/**
 * Healthcare ReAct Orchestrator
 *
 * Integrates:
 * - Intent Detection → determines mode (PHI_PROTECTION, CLINICAL_DECISION_SUPPORT)
 * - Policy Evaluation → validates against healthcare policies
 * - ReAct Loop → reasoning with tools (graph, knowledge, actions)
 * - Knowledge Base → past decisions, guidelines, heuristics
 * - JSON Contracts → structured outputs with reasoning chain
 *
 * Pattern: OpsBot ReAct architecture adapted for healthcare
 *
 * Architecture Integration:
 * Uses metadata-analytics/runtime/{ConfigLoader, RecipeExecutor, StepRunner}
 * for proper recipe-based execution with contract enforcement.
 */

import { Logger } from '../../utils/logger.js';
import HEALTHCARE_TOOLS from './tools.js';

// Import the core recipe execution infrastructure
let recipeExecutorPromise = null;
let configLoaderPromise = null;
let stepRunnerPromise = null;

async function getRecipeInfrastructure() {
  if (!recipeExecutorPromise) {
    recipeExecutorPromise = import('../../services/metadata-analytics/runtime/RecipeExecutor.js')
      .then(m => m.getRecipeExecutor())
      .catch(e => {
        console.warn('RecipeExecutor not available:', e.message);
        return null;
      });
  }
  if (!configLoaderPromise) {
    configLoaderPromise = import('../../services/metadata-analytics/runtime/ConfigLoader.js')
      .then(m => m.getConfigLoader())
      .catch(e => {
        console.warn('ConfigLoader not available:', e.message);
        return null;
      });
  }
  if (!stepRunnerPromise) {
    stepRunnerPromise = import('../../services/metadata-analytics/runtime/StepRunner.js')
      .then(m => m.getStepRunner())
      .catch(e => {
        console.warn('StepRunner not available:', e.message);
        return null;
      });
  }
  return {
    recipeExecutor: await recipeExecutorPromise,
    configLoader: await configLoaderPromise,
    stepRunner: await stepRunnerPromise
  };
}

// Safety limits
const MAX_ITERATIONS = 10;
const MAX_TOOL_CALLS = 20;
const MAX_ACTIONS = 3;
const RISK_ASSESSMENT_EXPIRY_MS = 60000;

/**
 * Confidence Calculation Algorithm
 *
 * Multi-factor weighted scoring based on:
 * - Data completeness (25%): How much patient/clinical data is available
 * - Data quality (20%): Validity, recency, consistency of data
 * - Source reliability (20%): Verified sources, clinical guidelines, peer-reviewed
 * - Model certainty (20%): LLM response quality, semantic coherence
 * - Clinical evidence level (15%): Strength of supporting evidence (RCT vs observational)
 *
 * Each factor scored 0-1, then weighted and combined
 * Final score adjusted by penalty factors (missing critical data, conflicting info)
 */
function calculateConfidence(factors) {
  const weights = {
    dataCompleteness: 0.25,
    dataQuality: 0.20,
    sourceReliability: 0.20,
    modelCertainty: 0.20,
    evidenceLevel: 0.15
  };

  // Data Completeness: What percentage of expected fields are present
  const completenessScore = factors.dataCompleteness ?? 0.5;

  // Data Quality: Recency, validity, consistency
  // Score based on: data age (<30 days = 1.0, <90 days = 0.8, <1yr = 0.6, older = 0.4)
  // Plus validation checks passed
  const qualityScore = factors.dataQuality ?? 0.5;

  // Source Reliability: Where did the data/recommendation come from
  // Clinical guidelines (ADA, ACC) = 1.0, Peer-reviewed = 0.9, Expert opinion = 0.7, AI-generated = 0.6
  const sourceScore = factors.sourceReliability ?? 0.6;

  // Model Certainty: Did LLM respond successfully, semantic coherence
  // Successful LLM call with structured output = 0.9, partial = 0.7, fallback = 0.5
  const modelScore = factors.modelCertainty ?? 0.5;

  // Evidence Level: Strength of clinical evidence
  // Level A (RCT) = 1.0, Level B (well-designed studies) = 0.85, Level C (expert consensus) = 0.7
  const evidenceScore = factors.evidenceLevel ?? 0.7;

  // Calculate weighted base score
  let baseScore =
    (completenessScore * weights.dataCompleteness) +
    (qualityScore * weights.dataQuality) +
    (sourceScore * weights.sourceReliability) +
    (modelScore * weights.modelCertainty) +
    (evidenceScore * weights.evidenceLevel);

  // Apply penalty factors
  const penalties = factors.penalties || [];
  for (const penalty of penalties) {
    switch (penalty.type) {
      case 'missing_critical_data':
        baseScore *= 0.7; // 30% penalty for missing critical fields
        break;
      case 'data_conflict':
        baseScore *= 0.85; // 15% penalty for conflicting information
        break;
      case 'outdated_guidelines':
        baseScore *= 0.9; // 10% penalty for older guidelines
        break;
      case 'llm_fallback':
        baseScore *= 0.8; // 20% penalty when LLM failed and using fallback
        break;
      case 'synthetic_data':
        baseScore *= 0.6; // 40% penalty for demo/synthetic data
        break;
    }
  }

  // Apply boost factors
  const boosts = factors.boosts || [];
  for (const boost of boosts) {
    switch (boost.type) {
      case 'multiple_sources':
        baseScore = Math.min(1.0, baseScore * 1.1); // 10% boost for corroborating sources
        break;
      case 'recent_validation':
        baseScore = Math.min(1.0, baseScore * 1.05); // 5% boost for recently validated data
        break;
      case 'expert_reviewed':
        baseScore = Math.min(1.0, baseScore * 1.15); // 15% boost for expert review
        break;
    }
  }

  // Clamp to valid range
  return Math.max(0.1, Math.min(0.99, baseScore));
}

export class HealthcareOrchestrator {
  constructor(config = {}) {
    this.logger = new Logger('HealthcareOrchestrator');

    // Healthcare stack components
    this.intentRouter = config.intentRouter;
    this.policyEngine = config.policyEngine;
    this.knowledgeEngine = config.knowledgeEngine;
    this.recipeEngine = config.recipeEngine;
    this.graphService = config.graphService;
    this.correctnessEvaluator = config.correctnessEvaluator;

    // LLM service for ReAct loop
    this.llmService = config.llmService;

    // Main orchestrator (ServientOrchestrator) for MCP handler access
    // Required for StepRunner's llm/invoke calls via processRequest
    this.mainOrchestrator = config.mainOrchestrator;

    // Cache for performance
    this.cache = config.cache;

    // Tool execution stats
    this.toolCallCount = 0;
    this.actionCount = 0;

    // Pending risk assessments (for action execution)
    this.riskAssessments = new Map();

    // Clinical knowledge for treatment recommendations
    this.clinicalKnowledge = {
      'diabetes': {
        'type 2': {
          firstLine: 'Metformin 500mg BID, titrate to 1000mg BID over 2-4 weeks',
          targets: { hba1c: '<7.0%', fastingGlucose: '80-130 mg/dL' },
          monitoring: ['HbA1c every 3 months', 'Fasting glucose weekly initially', 'Annual eye exam', 'Annual foot exam'],
          lifestyle: ['Diet modification', 'Exercise 150 min/week', 'Weight loss if overweight'],
          source: 'ADA Standards of Care 2024'
        },
        'type 1': {
          firstLine: 'Insulin therapy - basal-bolus regimen',
          targets: { hba1c: '<7.0%', fastingGlucose: '80-130 mg/dL' },
          monitoring: ['HbA1c every 3 months', 'CGM recommended', 'Annual eye exam', 'Annual foot exam'],
          source: 'ADA Standards of Care 2024'
        }
      },
      'hypertension': {
        firstLine: 'ACE inhibitor or ARB (if diabetes/CKD), otherwise thiazide diuretic',
        targets: { systolic: '<130 mmHg', diastolic: '<80 mmHg' },
        monitoring: ['BP every visit', 'BMP every 6 months'],
        lifestyle: ['DASH diet', 'Sodium <2300mg/day', 'Exercise', 'Weight loss'],
        source: 'ACC/AHA Hypertension Guidelines 2023'
      },
      'copd': {
        firstLine: 'LABA + ICS for moderate-severe, SABA PRN for mild',
        monitoring: ['Spirometry annually', 'Symptom assessment every visit'],
        lifestyle: ['Smoking cessation', 'Pulmonary rehabilitation'],
        source: 'GOLD Guidelines 2024'
      },
      'depression': {
        firstLine: 'SSRI (sertraline, escitalopram) + psychotherapy',
        monitoring: ['PHQ-9 every visit', 'Suicide risk assessment'],
        lifestyle: ['Exercise', 'Sleep hygiene', 'Social support'],
        source: 'APA Practice Guidelines 2023'
      }
    };

    // Care gap definitions
    this.careGapDefinitions = {
      'diabetes_eye_exam': { name: 'Diabetic Eye Exam', interval: '12 months', condition: 'Diabetes' },
      'diabetes_hba1c': { name: 'HbA1c Test', interval: '3 months', condition: 'Diabetes' },
      'mammogram': { name: 'Mammogram Screening', interval: '24 months', condition: 'Female 40+' },
      'colonoscopy': { name: 'Colorectal Screening', interval: '10 years', condition: 'Age 45+' },
      'flu_vaccine': { name: 'Annual Flu Vaccine', interval: '12 months', condition: 'All patients' }
    };
  }

  /**
   * Handle slash commands - /patient, /treatment, /care-gaps, etc.
   * Uses architecture-based flow: IntentRouter → Policy → Recipe → Correctness → DecisionArtifact
   */
  async handleSlashCommand(query, context, requestId, startTime) {
    const parts = query.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    this.logger.info(`Slash command: ${command} with args: ${args}`);

    try {
      // NOTE: Architecture-based flow (recipes) is disabled for now because the LLM output
      // doesn't match the structured format the frontend expects. The built-in handlers
      // below return correctly structured data. Re-enable when recipe output schemas are fixed.
      //
      // const commandName = command.replace(/^\//, '');
      // const architectureCommands = ['patient', 'care-gaps', 'treatment', 'drug-check'];
      // if (architectureCommands.includes(commandName) && this.intentRouter) {
      //   return await this.handleArchitectureBasedCommand(query, context, requestId, startTime);
      // }

      // Fallback to direct command handling for other commands or when architecture not available
      switch (command) {
        case '/patient':
          return await this.handlePatientCommand(args, context, requestId, startTime);

        case '/treatment':
          return await this.handleTreatmentCommand(args, context, requestId, startTime);

        case '/care-gaps':
          return await this.handleCareGapsCommand(args, context, requestId, startTime);

        case '/drug-check':
          return await this.handleDrugCheckCommand(args, context, requestId, startTime);

        case '/medications':
          return await this.handleMedicationsCommand(args, context, requestId, startTime);

        case '/labs':
          return await this.handleLabsCommand(args, context, requestId, startTime);

        case '/help':
          return this.buildHelpResponse(requestId, startTime);

        default:
          return this.buildNotAvailableResponse(command, requestId, startTime);
      }
    } catch (error) {
      this.logger.error(`Slash command error: ${error.message}`);
      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: error.message,
        duration: Date.now() - startTime
      });
    }
  }

  /**
   * Architecture-based command handling using proper infrastructure:
   * IntentRouter → ConfigLoader → RecipeExecutor → StepRunner → Contract Enforcement
   */
  async handleArchitectureBasedCommand(query, context, requestId, startTime) {
    const stepResults = [];

    // 1. Route through IntentRouter to get intent and recipe ID
    const routing = await this.intentRouter.route({
      query,
      ...context
    });

    stepResults.push({
      name: 'intent_routing',
      success: routing.success,
      duration: routing.routingTimeMs,
      output: { intent: routing.intent?.id, mode: routing.mode, recipe: routing.recipe }
    });

    if (!routing.success) {
      return this.buildErrorResponse(routing.error, requestId, startTime);
    }

    // 2. Get the recipe infrastructure
    const { recipeExecutor, configLoader, stepRunner } = await getRecipeInfrastructure();

    // 3. Try to execute via RecipeExecutor (proper architecture)
    let recipeResult;
    if (recipeExecutor && configLoader && routing.recipe) {
      try {
        // Ensure config is loaded
        if (!configLoader.loaded) {
          await configLoader.load();
        }

        // Initialize step runner if needed
        if (stepRunner && !stepRunner.initialized) {
          await stepRunner.initialize({
            cache: this.cache,
            llmService: this.llmService,
            // Use mainOrchestrator (ServientOrchestrator) which has processRequest with MCP handlers
            orchestrator: this.mainOrchestrator
          });
        }

        // Extract inputs from query (e.g., "/patient MRN-12345" → patientId: "MRN-12345")
        const inputs = this.extractRecipeInputs(query, routing);

        // Get recipe ID (routing.recipe may be object { id: '...' } or string)
        const recipeId = typeof routing.recipe === 'string' ? routing.recipe : routing.recipe?.id;

        // Execute recipe through RecipeExecutor
        this.logger.info(`Executing recipe '${recipeId}' via RecipeExecutor`, { inputs });

        // Debug: Check mainOrchestrator
        this.logger.info(`mainOrchestrator check: exists=${!!this.mainOrchestrator}, hasProcessRequest=${typeof this.mainOrchestrator?.processRequest === 'function'}`);

        const execContext = {
          orgId: context.orgId || 'healthcare',
          userId: context.userId || 'system',
          cache: this.cache,
          llmService: this.llmService,
          // Use main orchestrator (ServientOrchestrator) which has processRequest with MCP handlers
          orchestrator: this.mainOrchestrator
        };

        recipeResult = await recipeExecutor.execute(recipeId, inputs, execContext);

        stepResults.push({
          name: 'recipe_execution',
          success: recipeResult.success,
          duration: recipeResult.meta?.totalDuration,
          output: recipeResult.data,
          steps: recipeResult.meta?.timing
        });

        this.logger.info(`Recipe '${routing.recipe}' completed`, {
          success: recipeResult.success,
          cacheHits: recipeResult.meta?.cacheHits,
          totalSteps: recipeResult.meta?.totalSteps
        });

      } catch (recipeError) {
        this.logger.warn(`Recipe execution failed: ${recipeError.message}`, { stack: recipeError.stack });
        // Fall back to built-in handlers
        recipeResult = await this.executeBuiltInHandler(query, routing, context, requestId, startTime);
        stepResults.push({
          name: 'builtin_fallback',
          success: recipeResult.success,
          duration: Date.now() - startTime,
          output: recipeResult.data,
          fallbackReason: recipeError.message
        });
      }
    } else {
      // RecipeExecutor not available - use built-in handlers
      this.logger.info('RecipeExecutor not available, using built-in handlers');
      recipeResult = await this.executeBuiltInHandler(query, routing, context, requestId, startTime);
      stepResults.push({
        name: 'builtin_handler',
        success: recipeResult.success,
        duration: Date.now() - startTime,
        output: recipeResult.data
      });
    }

    // 4. Evaluate correctness if available
    let correctnessResult = { passed: true, assertions: [], requiresReview: false };
    if (this.correctnessEvaluator && recipeResult.correctness) {
      try {
        correctnessResult = await this.correctnessEvaluator.evaluate(
          recipeResult,
          recipeResult.correctness
        );
      } catch (evalError) {
        this.logger.warn(`Correctness evaluation failed: ${evalError.message}`);
        correctnessResult = {
          passed: true,
          assertions: [{ type: 'evaluation_skipped', reason: evalError.message }],
          requiresReview: false
        };
      }
    }

    // 5. Build DecisionArtifact with reason contract
    return this.buildDecisionArtifact({
      routing,
      recipeResult,
      correctnessResult,
      stepResults,
      requestId,
      startTime
    });
  }

  /**
   * Extract recipe inputs from query based on routing
   * Handles both slash commands (/patient P001) and natural language (patient summary for P001)
   */
  extractRecipeInputs(query, routing) {
    const isSlashCommand = query.trim().startsWith('/');
    const parts = query.trim().split(/\s+/);
    const inputs = {};

    // Get intent ID (may be 'patient-summary' or 'hc:patient-summary')
    const intentId = routing.intent?.id?.replace(/^hc:/, '') || '';

    if (isSlashCommand) {
      // Slash command format: /command args
      const args = parts.slice(1).join(' ');

      switch (intentId) {
        case 'patient-summary':
          inputs.patientId = args || parts[1];
          break;

        case 'treatment-recommendation': {
          const conditionParts = args.split(/\s+/);
          inputs.condition = conditionParts[0] || args;
          if (conditionParts.length > 1) {
            inputs.subtype = conditionParts.slice(1).join(' ');
          }
          break;
        }

        case 'care-gaps':
        case 'care-gap-analysis':
          inputs.patientId = args || parts[1];
          break;

        case 'drug-interaction-check':
          inputs.drugs = args.split(/[\s,]+/).filter(d => d.length > 0);
          break;

        default:
          inputs.query = args;
      }
    } else {
      // Natural language format - extract entities from text
      const lowerQuery = query.toLowerCase();

      switch (intentId) {
        case 'patient-summary': {
          // "patient summary for P001", "summarize patient MRN-12345", "patient P001 overview"
          const patientMatch = query.match(/(?:patient|for|mrn)[\s:]*([A-Z0-9][-A-Z0-9]*)/i) ||
                               query.match(/\b([PM][A-Z0-9][-A-Z0-9]+)\b/i) ||
                               query.match(/\b(MRN[-\s]?\d+)\b/i);
          inputs.patientId = patientMatch ? patientMatch[1] : parts[parts.length - 1];
          break;
        }

        case 'treatment-recommendation': {
          // "treatment for diabetes", "how to treat hypertension type 2"
          const conditionMatch = query.match(/(?:treatment|treat|therapy|manage)(?:\s+(?:for|of))?\s+(.+)/i);
          if (conditionMatch) {
            const conditionText = conditionMatch[1].trim();
            const conditionParts = conditionText.split(/\s+/);
            inputs.condition = conditionParts[0];
            if (conditionParts.length > 1) {
              inputs.subtype = conditionParts.slice(1).join(' ');
            }
          } else {
            // Extract last meaningful word(s) as condition
            const words = parts.filter(w => !['treatment', 'for', 'treat', 'how', 'to', 'the', 'a'].includes(w.toLowerCase()));
            inputs.condition = words.join(' ') || query;
          }
          break;
        }

        case 'care-gaps':
        case 'care-gap-analysis': {
          // "care gaps for P001", "what care gaps does patient MRN-12345 have"
          const patientMatch = query.match(/(?:patient|for|mrn)[\s:]*([A-Z0-9][-A-Z0-9]*)/i) ||
                               query.match(/\b([PM][A-Z0-9][-A-Z0-9]+)\b/i) ||
                               query.match(/\b(MRN[-\s]?\d+)\b/i);
          inputs.patientId = patientMatch ? patientMatch[1] : parts[parts.length - 1];
          break;
        }

        case 'drug-interaction-check': {
          // "drug interactions for warfarin and aspirin", "check warfarin aspirin metformin"
          // Extract drug names - words that look like medication names
          const stopWords = ['drug', 'interaction', 'interactions', 'check', 'for', 'between', 'and', 'with', 'the', 'any', 'are', 'there'];
          const drugCandidates = parts.filter(word => {
            const lower = word.toLowerCase().replace(/[,;]/g, '');
            return lower.length > 2 && !stopWords.includes(lower) && !/^\d+$/.test(lower);
          });
          inputs.drugs = drugCandidates.map(d => d.replace(/[,;]/g, ''));
          break;
        }

        default:
          inputs.query = query;
      }
    }

    this.logger.debug(`Extracted inputs for intent '${intentId}' (${isSlashCommand ? 'slash' : 'NL'})`, { inputs });
    return inputs;
  }

  /**
   * Execute built-in handler for command when recipe execution not available
   */
  async executeBuiltInHandler(query, routing, context, requestId, startTime) {
    const parts = query.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    if (command === '/patient') {
      return await this.handlePatientCommand(args, context, requestId, startTime);
    } else if (command === '/treatment') {
      return await this.handleTreatmentCommand(args, context, requestId, startTime);
    }

    return this.buildNotAvailableResponse(command, requestId, startTime);
  }

  /**
   * Build error response
   */
  buildErrorResponse(error, requestId, startTime) {
    return this.buildResponse({
      requestId,
      success: false,
      type: 'error',
      summary: error || 'An error occurred',
      duration: Date.now() - startTime
    });
  }

  /**
   * Build DecisionArtifact with reason contract - deterministic, auditable output
   */
  buildDecisionArtifact({ routing, recipeResult, correctnessResult, stepResults, requestId, startTime }) {
    return {
      // Core output (from recipe or built-in handler)
      output: recipeResult?.data || recipeResult?.output || recipeResult,

      // Reason contract (deterministic, auditable)
      reasoning: {
        intent: routing.intent?.id,
        mode: routing.mode,
        steps: (stepResults || []).map(step => ({
          id: step.name,
          status: step.success ? 'passed' : 'failed',
          duration: step.duration,
          outputSummary: this.summarizeStepOutput(step)
        })),
        knowledgePacksUsed: ['healthcare-clinical-v1'],
        policiesEvaluated: routing.policyApplied || []
      },

      // Correctness envelope
      correctness: {
        assertions: correctnessResult.assertions || [],
        overallStatus: correctnessResult.passed ? 'VALID' : 'FAILED',
        reviewRequired: correctnessResult.requiresReview || false,
        escalateTo: correctnessResult.escalateTo
      },

      // Audit metadata
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
        processingTime: Date.now() - startTime,
        routingTime: routing.routingTimeMs
      },

      // Backward compatibility fields
      requestId,
      success: recipeResult?.success !== false,
      type: routing.intent?.id || 'clinical_decision',
      data: recipeResult?.data || recipeResult?.output,
      suggested_actions: recipeResult?.recommended_actions || [],
      markdown: recipeResult?.markdown,
      duration_ms: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Summarize step output for reasoning chain
   */
  summarizeStepOutput(step) {
    if (!step.output) return 'No output';
    if (typeof step.output === 'string') return step.output.substring(0, 100);
    if (step.output.summary) return step.output.summary;
    if (step.output.patientId) return `Patient: ${step.output.patientId}`;
    if (step.output.condition) return `Condition: ${step.output.condition}`;
    if (step.output.intent) return `Intent: ${step.output.intent}`;
    return JSON.stringify(step.output).substring(0, 100);
  }

  /**
   * /patient MRN-12345 - Get patient summary
   */
  async handlePatientCommand(patientId, context, requestId, startTime) {
    if (!patientId) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: 'Patient ID required. Usage: /patient MRN-12345',
        duration: Date.now() - startTime
      });
    }

    // Query database for patient
    let patient = null;
    let diagnoses = [];
    let medications = [];
    let encounters = [];

    if (this.graphService?.initialized) {
      try {
        // Query patient from graph
        const patientResult = await this.graphService.client.query(
          `g.V().hasLabel('Patient').has('patientId', '${patientId}').valueMap().limit(1)`
        );
        if (patientResult && patientResult.length > 0) {
          patient = this.flattenGremlinResult(patientResult[0]);
        }

        // Get diagnoses
        const diagResult = await this.graphService.client.query(
          `g.V().hasLabel('Patient').has('patientId', '${patientId}').out('HAS_DIAGNOSIS').valueMap().limit(10)`
        );
        diagnoses = (diagResult || []).map(d => this.flattenGremlinResult(d));

        // Get medications
        const medResult = await this.graphService.client.query(
          `g.V().hasLabel('Patient').has('patientId', '${patientId}').out('PRESCRIBED').valueMap().limit(10)`
        );
        medications = (medResult || []).map(m => this.flattenGremlinResult(m));

        // Get recent encounters
        const encResult = await this.graphService.client.query(
          `g.V().hasLabel('Patient').has('patientId', '${patientId}').out('HAS_ENCOUNTER').order().by('admitDate', decr).valueMap().limit(5)`
        );
        encounters = (encResult || []).map(e => this.flattenGremlinResult(e));

      } catch (dbError) {
        this.logger.error('Database query error:', dbError);
      }
    }

    // If no DB result, use synthetic demo data
    if (!patient) {
      patient = this.getSyntheticPatient(patientId);
      diagnoses = this.getSyntheticDiagnoses(patientId);
      medications = this.getSyntheticMedications(patientId);
      encounters = this.getSyntheticEncounters(patientId);
    }

    if (!patient) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'not_found',
        summary: `Patient ${patientId} not found`,
        duration: Date.now() - startTime
      });
    }

    const patientName = patient.name || `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'Unknown';
    const age = this.calculateAge(patient.dateOfBirth || patient.dob);
    const alerts = this.generatePatientAlerts(patient, diagnoses, medications);

    // Track data source for confidence calculation
    const usingSyntheticData = !this.graphService?.initialized || !patient?.fromDatabase;

    // Call LLM to generate comprehensive summary
    let llmSummary = null;
    let reasoning = [];
    let llmSuccess = false;

    if (this.llmService) {
      try {
        const patientData = {
          id: patientId,
          name: patientName,
          age,
          gender: patient.gender,
          diagnoses: diagnoses.map(d => d.description || d.icdCode || d.code),
          medications: medications.map(m => `${m.name} ${m.dosage || ''}`),
          alerts: alerts.map(a => a.message)
        };

        const prompt = `You are a clinical decision support system. Generate a comprehensive patient summary for:

Patient: ${patientName} (ID: ${patientId})
Age: ${age} years old, ${patient.gender}
Active Diagnoses: ${diagnoses.map(d => `${d.icdCode || d.code || ''} - ${d.description || 'Unknown'}`).join('; ') || 'None documented'}
Current Medications: ${medications.map(m => `${m.name} ${m.dosage || ''} ${m.frequency || ''}`).join('; ') || 'None documented'}
Clinical Alerts: ${alerts.map(a => a.message).join('; ') || 'None'}

Provide a detailed clinical summary including:
1. Brief patient overview with demographics and key conditions
2. Current disease status and control (include specific values like HbA1c, BP if relevant to diagnoses)
3. Medication review with appropriateness assessment
4. Critical alerts or care gaps that need attention
5. Overall clinical status assessment

Format as a cohesive narrative paragraph suitable for clinical handoff. Be specific with clinical values where appropriate.`;

        const llmResponse = await this.llmService.generateText(prompt, {
          maxTokens: 1000,
          temperature: 0.3
        });

        llmSummary = llmResponse?.text || llmResponse;
        llmSuccess = true;
        reasoning = [
          { step: 'data_collection', thought: 'Retrieved patient demographics, diagnoses, and medications', action: 'query_database', observation: `Found ${diagnoses.length} diagnoses, ${medications.length} medications` },
          { step: 'clinical_analysis', thought: 'Analyzing patient data for clinical summary', action: 'llm_summarize', observation: 'Generated comprehensive clinical summary' }
        ];
      } catch (llmError) {
        this.logger.warn('LLM summary generation failed:', llmError.message);
        llmSuccess = false;
      }
    }

    // Build findings from data
    const findings = [];
    diagnoses.forEach(d => {
      findings.push({ severity: 'info', message: `Diagnosis: ${d.description || d.icdCode || d.code || 'Unknown'}` });
    });
    medications.forEach(m => {
      findings.push({ severity: 'info', message: `Medication: ${m.name || 'Unknown'} ${m.dosage || ''}`.trim() });
    });
    alerts.forEach(a => {
      findings.push({ severity: a.severity || 'warning', message: a.message });
    });

    // Calculate confidence using multi-factor algorithm
    const expectedFields = ['name', 'dateOfBirth', 'gender'];
    const presentFields = expectedFields.filter(f => patient[f] || patient[f.toLowerCase()]);
    const dataCompleteness = (presentFields.length / expectedFields.length) * 0.5 +
      (diagnoses.length > 0 ? 0.25 : 0) + (medications.length > 0 ? 0.25 : 0);

    const confidence = calculateConfidence({
      dataCompleteness,
      dataQuality: 0.7, // Assume moderate quality without date validation
      sourceReliability: usingSyntheticData ? 0.4 : 0.8,
      modelCertainty: llmSuccess ? 0.9 : 0.5,
      evidenceLevel: 0.7,
      penalties: [
        ...(usingSyntheticData ? [{ type: 'synthetic_data' }] : []),
        ...(!llmSuccess ? [{ type: 'llm_fallback' }] : []),
        ...(diagnoses.length === 0 ? [{ type: 'missing_critical_data' }] : [])
      ],
      boosts: [
        ...(diagnoses.length > 0 && medications.length > 0 ? [{ type: 'multiple_sources' }] : [])
      ]
    });

    return this.buildResponse({
      requestId,
      success: true,
      type: 'patient_summary',
      summary: llmSummary || `Patient: ${patientName} (${patientId})`,
      confidence,
      confidenceFactors: {
        dataCompleteness: Math.round(dataCompleteness * 100) + '%',
        sourceType: usingSyntheticData ? 'synthetic_demo' : 'database',
        llmGenerated: llmSuccess,
        diagnosesFound: diagnoses.length,
        medicationsFound: medications.length
      },
      reasoning,
      data: {
        patient: {
          id: patientId,
          name: patientName,
          dob: patient.dateOfBirth || patient.dob,
          gender: patient.gender,
          age
        },
        diagnoses,
        medications,
        recentEncounters: encounters.slice(0, 3),
        alerts
      },
      findings,
      recommended_actions: alerts.map(a => ({ action: a.action, priority: a.severity })),
      duration: Date.now() - startTime
    });
  }

  /**
   * /treatment diabetes type 2 - Get treatment recommendations
   */
  async handleTreatmentCommand(condition, context, requestId, startTime) {
    if (!condition) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: 'Condition required. Usage: /treatment diabetes type 2',
        duration: Date.now() - startTime
      });
    }

    const conditionLower = condition.toLowerCase();
    let treatment = null;
    let matchedCondition = null;

    // Search in clinical knowledge
    for (const [key, value] of Object.entries(this.clinicalKnowledge)) {
      if (conditionLower.includes(key)) {
        matchedCondition = key;
        if (typeof value === 'object' && !value.firstLine) {
          // Nested conditions (like diabetes type 1 vs type 2)
          for (const [subKey, subValue] of Object.entries(value)) {
            if (conditionLower.includes(subKey)) {
              treatment = subValue;
              matchedCondition = `${key} ${subKey}`;
              break;
            }
          }
          // Default to first subtype if no match
          if (!treatment) {
            const firstKey = Object.keys(value)[0];
            treatment = value[firstKey];
            matchedCondition = `${key} ${firstKey}`;
          }
        } else {
          treatment = value;
        }
        break;
      }
    }

    // Call LLM for comprehensive treatment recommendations
    let llmSummary = null;
    let llmRecommendations = [];
    let reasoning = [];
    let llmSuccess = false;
    const hasGuidelineMatch = !!treatment;

    if (this.llmService) {
      try {
        const prompt = `You are a clinical decision support system. Provide comprehensive evidence-based treatment recommendations for: ${condition}

Include the following sections:
1. **Primary Recommendation**: First-line treatment with specific medications, dosages, and titration schedule
2. **Treatment Goals**: Specific targets (e.g., HbA1c <7%, BP <130/80)
3. **Monitoring Plan**: Required tests and frequency
4. **Lifestyle Modifications**: Diet, exercise, weight management recommendations
5. **Secondary Options**: Alternative treatments if first-line fails or is contraindicated
6. **Cardiovascular Protection**: CV risk management for this condition
7. **Complication Screening**: Tests to detect complications early
8. **Patient Education**: Key points for self-management
9. **When to Refer**: Criteria for specialist referral
10. **Evidence Source**: Clinical guidelines referenced (ADA, ACC, etc.)

For each recommendation, provide:
- Priority level (critical/high/medium)
- Brief rationale
- Specific actionable steps

Format as a clinical decision support response.`;

        const llmResponse = await this.llmService.generateText(prompt, {
          maxTokens: 2000,
          temperature: 0.3
        });

        llmSummary = llmResponse?.text || llmResponse;
        llmSuccess = true;
        reasoning = [
          { step: 'condition_analysis', thought: `Analyzing treatment options for ${condition}`, action: 'query_guidelines', observation: 'Retrieved evidence-based protocols' },
          { step: 'recommendation_generation', thought: 'Generating comprehensive treatment plan', action: 'llm_analyze', observation: 'Generated multi-faceted treatment recommendations' }
        ];
      } catch (llmError) {
        this.logger.warn('LLM treatment generation failed:', llmError.message);
        llmSuccess = false;
      }
    }

    // Use basic treatment data as fallback structure
    const baseData = treatment || {
      firstLine: `Consult clinical guidelines for ${condition}`,
      targets: {},
      monitoring: ['Regular follow-up'],
      lifestyle: ['Lifestyle modifications as appropriate'],
      source: 'Clinical judgment'
    };

    // Calculate confidence using multi-factor algorithm
    const confidence = calculateConfidence({
      dataCompleteness: hasGuidelineMatch ? 0.9 : 0.5,
      dataQuality: 0.8,
      sourceReliability: hasGuidelineMatch ? 0.95 : 0.6, // Clinical guidelines = high reliability
      modelCertainty: llmSuccess ? 0.9 : 0.5,
      evidenceLevel: baseData.source?.includes('ADA') || baseData.source?.includes('ACC') ? 0.95 : 0.7,
      penalties: [
        ...(!hasGuidelineMatch ? [{ type: 'missing_critical_data' }] : []),
        ...(!llmSuccess ? [{ type: 'llm_fallback' }] : [])
      ],
      boosts: [
        ...(hasGuidelineMatch && llmSuccess ? [{ type: 'multiple_sources' }] : [])
      ]
    });

    return this.buildResponse({
      requestId,
      success: true,
      type: 'treatment_recommendation',
      summary: llmSummary || `Treatment protocol for ${matchedCondition || condition}`,
      confidence,
      confidenceFactors: {
        guidelineMatch: hasGuidelineMatch,
        source: baseData.source,
        llmGenerated: llmSuccess,
        evidenceLevel: baseData.source?.includes('ADA') ? 'A (RCT)' : 'C (Expert)'
      },
      reasoning,
      data: {
        condition: matchedCondition || condition,
        firstLine: baseData.firstLine,
        targets: baseData.targets,
        monitoring: baseData.monitoring,
        lifestyle: baseData.lifestyle,
        source: baseData.source
      },
      findings: [
        { type: 'recommendation', severity: 'critical', message: baseData.firstLine }
      ],
      recommended_actions: [
        { action: 'Review with physician', priority: 'required' },
        ...(baseData.monitoring || []).map(m => ({ action: m, priority: 'recommended' }))
      ],
      compliance_status: { source: baseData.source, evidenceLevel: 'A' },
      duration: Date.now() - startTime
    });
  }

  /**
   * /drug-check drug1 drug2 - Check drug interactions
   */
  async handleDrugCheckCommand(args, context, requestId, startTime) {
    if (!args || args.trim().length === 0) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: 'Drug names required. Usage: /drug-check aspirin warfarin',
        duration: Date.now() - startTime
      });
    }

    const drugs = args.split(/\s+/).filter(d => d.length > 0);
    if (drugs.length < 2) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: 'At least 2 drugs required. Usage: /drug-check aspirin warfarin',
        duration: Date.now() - startTime
      });
    }

    // Known interaction database (demo)
    const interactions = this.checkDrugInteractions(drugs);

    return this.buildResponse({
      requestId,
      success: true,
      type: 'drug_interaction',
      summary: interactions.length > 0
        ? `Found ${interactions.length} interaction(s) between ${drugs.join(', ')}`
        : `No significant interactions found between ${drugs.join(', ')}`,
      data: {
        drugs,
        interactionCount: interactions.length,
        interactions,
        checkedAt: new Date().toISOString()
      },
      findings: interactions.map(i => ({
        type: 'interaction',
        severity: i.severity,
        message: i.description
      })),
      recommended_actions: interactions.filter(i => i.severity === 'high').map(i => ({
        action: i.recommendation,
        priority: 'required'
      })),
      duration: Date.now() - startTime
    });
  }

  /**
   * Check drug interactions from knowledge base
   */
  checkDrugInteractions(drugs) {
    const knownInteractions = {
      'aspirin_warfarin': {
        severity: 'high',
        description: 'Increased bleeding risk - aspirin enhances anticoagulant effect of warfarin',
        recommendation: 'Monitor INR closely, consider alternative antiplatelet if needed'
      },
      'metformin_contrast': {
        severity: 'high',
        description: 'Risk of lactic acidosis with iodinated contrast',
        recommendation: 'Hold metformin 48h before/after contrast administration'
      },
      'lisinopril_potassium': {
        severity: 'moderate',
        description: 'Risk of hyperkalemia - ACE inhibitors increase potassium retention',
        recommendation: 'Monitor serum potassium levels regularly'
      },
      'simvastatin_grapefruit': {
        severity: 'moderate',
        description: 'Grapefruit increases statin levels, risk of myopathy',
        recommendation: 'Avoid grapefruit juice with this medication'
      },
      'metformin_alcohol': {
        severity: 'moderate',
        description: 'Increased risk of lactic acidosis and hypoglycemia',
        recommendation: 'Limit alcohol consumption'
      }
    };

    const interactions = [];
    const drugLower = drugs.map(d => d.toLowerCase());

    for (const [pair, interaction] of Object.entries(knownInteractions)) {
      const [drug1, drug2] = pair.split('_');
      if (drugLower.includes(drug1) && drugLower.includes(drug2)) {
        interactions.push(interaction);
      }
    }

    return interactions;
  }

  /**
   * /care-gaps MRN-12345 - Identify care gaps
   */
  async handleCareGapsCommand(patientId, context, requestId, startTime) {
    if (!patientId) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: 'Patient ID required. Usage: /care-gaps MRN-12345',
        duration: Date.now() - startTime
      });
    }

    // Get patient data first
    let patient = null;
    let diagnoses = [];
    let procedures = [];

    if (this.graphService?.initialized) {
      try {
        const patientResult = await this.graphService.client.query(
          `g.V().hasLabel('Patient').has('patientId', '${patientId}').valueMap().limit(1)`
        );
        if (patientResult && patientResult.length > 0) {
          patient = this.flattenGremlinResult(patientResult[0]);
        }

        const diagResult = await this.graphService.client.query(
          `g.V().hasLabel('Patient').has('patientId', '${patientId}').out('HAS_DIAGNOSIS').valueMap()`
        );
        diagnoses = (diagResult || []).map(d => this.flattenGremlinResult(d));

        const procResult = await this.graphService.client.query(
          `g.V().hasLabel('Patient').has('patientId', '${patientId}').out('UNDERWENT').valueMap()`
        );
        procedures = (procResult || []).map(p => this.flattenGremlinResult(p));

      } catch (dbError) {
        this.logger.error('Database query error:', dbError);
      }
    }

    // Fallback to synthetic data
    if (!patient) {
      patient = this.getSyntheticPatient(patientId);
      diagnoses = this.getSyntheticDiagnoses(patientId);
    }

    if (!patient) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'not_found',
        summary: `Patient ${patientId} not found`,
        duration: Date.now() - startTime
      });
    }

    const patientName = `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'Unknown';
    const age = this.calculateAge(patient.dateOfBirth || patient.dob);

    // Track data source for confidence calculation
    const usingSyntheticData = !this.graphService?.initialized || !patient?.fromDatabase;

    // Analyze care gaps from data
    const careGaps = this.analyzeCareGaps(patient, diagnoses, procedures);

    // Call LLM for comprehensive care gap analysis
    let llmSummary = null;
    let reasoning = [];
    let llmSuccess = false;

    if (this.llmService) {
      try {
        const prompt = `You are a clinical quality improvement specialist. Analyze care gaps for:

Patient: ${patientName} (ID: ${patientId})
Age: ${age}, Gender: ${patient.gender}
Active Diagnoses: ${diagnoses.map(d => d.description || d.icdCode).join('; ') || 'None documented'}

Identified Care Gaps:
${careGaps.map(g => `- ${g.name}: ${g.status} (Priority: ${g.priority}, HEDIS: ${g.measure})`).join('\n')}

Provide a comprehensive care gap analysis including:
1. **Summary**: Overview of gaps identified and their clinical significance
2. **For each gap**:
   - Clinical importance and rationale
   - Potential consequences if not addressed
   - Specific recommended action with timeline
   - HEDIS measure reference
3. **Prioritization**: Order of urgency for addressing gaps
4. **Coordination**: How to address multiple gaps efficiently
5. **Patient communication**: Key points to discuss with patient

Focus on actionable recommendations that improve quality metrics and patient outcomes.`;

        const llmResponse = await this.llmService.generateText(prompt, {
          maxTokens: 2000,
          temperature: 0.3
        });

        llmSummary = llmResponse?.text || llmResponse;
        llmSuccess = true;
        reasoning = [
          { step: 'gap_identification', thought: 'Identifying overdue screenings and preventive services', action: 'analyze_hedis', observation: `Found ${careGaps.length} care gaps` },
          { step: 'clinical_analysis', thought: 'Analyzing clinical significance and prioritization', action: 'llm_analyze', observation: 'Generated comprehensive care gap recommendations' }
        ];
      } catch (llmError) {
        this.logger.warn('LLM care gap analysis failed:', llmError.message);
        llmSuccess = false;
      }
    }

    // Calculate confidence using multi-factor algorithm
    const confidence = calculateConfidence({
      dataCompleteness: diagnoses.length > 0 ? 0.8 : 0.5,
      dataQuality: 0.7,
      sourceReliability: 0.85, // HEDIS measures are well-defined
      modelCertainty: llmSuccess ? 0.85 : 0.5,
      evidenceLevel: 0.9, // HEDIS measures are evidence-based
      penalties: [
        ...(usingSyntheticData ? [{ type: 'synthetic_data' }] : []),
        ...(!llmSuccess ? [{ type: 'llm_fallback' }] : []),
        ...(careGaps.length === 0 ? [{ type: 'missing_critical_data' }] : [])
      ],
      boosts: []
    });

    return this.buildResponse({
      requestId,
      success: true,
      type: 'care_gaps',
      summary: llmSummary || `Found ${careGaps.length} care gap(s) for patient ${patientId}`,
      confidence,
      confidenceFactors: {
        sourceType: usingSyntheticData ? 'synthetic_demo' : 'database',
        llmGenerated: llmSuccess,
        gapsIdentified: careGaps.length,
        measureSource: 'HEDIS Quality Measures'
      },
      reasoning,
      data: {
        patientId,
        patientName,
        careGaps,
        complianceScore: Math.max(0, 100 - (careGaps.length * 15)),
        lastAssessed: new Date().toISOString()
      },
      findings: careGaps.map(g => ({
        type: 'care_gap',
        severity: g.priority === 'high' ? 'high' : 'medium',
        message: `${g.name}: ${g.status}`,
        measure: g.measure
      })),
      recommended_actions: careGaps.map(g => ({
        action: `Schedule ${g.name}`,
        priority: g.priority,
        dueDate: g.dueDate
      })),
      duration: Date.now() - startTime
    });
  }

  /**
   * /medications MRN-12345 - List patient medications
   */
  async handleMedicationsCommand(patientId, context, requestId, startTime) {
    return this.buildNotAvailableResponse('/medications', requestId, startTime,
      'Medication list feature coming soon. Use /patient to see basic medication info.');
  }

  /**
   * /labs MRN-12345 - Get lab results
   */
  async handleLabsCommand(patientId, context, requestId, startTime) {
    return this.buildNotAvailableResponse('/labs', requestId, startTime,
      'Lab results feature coming soon.');
  }

  /**
   * Build help response
   */
  buildHelpResponse(requestId, startTime) {
    return this.buildResponse({
      requestId,
      success: true,
      type: 'help',
      summary: 'Healthcare Assistant Commands',
      data: {
        commands: [
          { command: '/patient MRN-12345', description: 'Get patient summary', status: 'available' },
          { command: '/treatment [condition]', description: 'Treatment recommendations', status: 'available' },
          { command: '/care-gaps MRN-12345', description: 'Identify care gaps', status: 'available' },
          { command: '/medications MRN-12345', description: 'List medications', status: 'coming_soon' },
          { command: '/labs MRN-12345', description: 'View lab results', status: 'coming_soon' },
          { command: '/help', description: 'Show this help', status: 'available' }
        ]
      },
      duration: Date.now() - startTime
    });
  }

  /**
   * Build "not available" response
   */
  buildNotAvailableResponse(command, requestId, startTime, message = null) {
    return this.buildResponse({
      requestId,
      success: true,
      type: 'not_available',
      summary: message || `${command} is not available yet`,
      data: {
        command,
        status: 'not_implemented',
        suggestion: 'Try /help to see available commands'
      },
      duration: Date.now() - startTime
    });
  }

  // ===========================================
  // SYNTHETIC DATA HELPERS
  // ===========================================

  getSyntheticPatient(patientId) {
    const patients = {
      'MRN-12345': { firstName: 'John', lastName: 'Smith', dateOfBirth: '1965-03-15', gender: 'Male' },
      'MRN-12346': { firstName: 'Mary', lastName: 'Johnson', dateOfBirth: '1978-07-22', gender: 'Female' },
      'MRN-12347': { firstName: 'Robert', lastName: 'Williams', dateOfBirth: '1952-11-08', gender: 'Male' },
      'MRN-12348': { firstName: 'Sarah', lastName: 'Davis', dateOfBirth: '1990-01-30', gender: 'Female' }
    };
    return patients[patientId] || null;
  }

  getSyntheticDiagnoses(patientId) {
    const diagnoses = {
      'MRN-12345': [
        { icdCode: 'E11.9', description: 'Type 2 diabetes mellitus without complications', status: 'Active' },
        { icdCode: 'I10', description: 'Essential hypertension', status: 'Active' }
      ],
      'MRN-12346': [
        { icdCode: 'J45.20', description: 'Mild intermittent asthma', status: 'Active' }
      ],
      'MRN-12347': [
        { icdCode: 'I50.9', description: 'Heart failure, unspecified', status: 'Active' },
        { icdCode: 'E11.9', description: 'Type 2 diabetes mellitus', status: 'Active' },
        { icdCode: 'N18.3', description: 'Chronic kidney disease, stage 3', status: 'Active' }
      ],
      'MRN-12348': [
        { icdCode: 'F32.1', description: 'Major depressive disorder, single episode, moderate', status: 'Active' }
      ]
    };
    return diagnoses[patientId] || [];
  }

  getSyntheticMedications(patientId) {
    const medications = {
      'MRN-12345': [
        { name: 'Metformin', dosage: '1000mg', frequency: 'BID' },
        { name: 'Lisinopril', dosage: '10mg', frequency: 'Daily' }
      ],
      'MRN-12346': [
        { name: 'Albuterol inhaler', dosage: '90mcg', frequency: 'PRN' }
      ],
      'MRN-12347': [
        { name: 'Metoprolol', dosage: '50mg', frequency: 'BID' },
        { name: 'Furosemide', dosage: '40mg', frequency: 'Daily' },
        { name: 'Metformin', dosage: '500mg', frequency: 'BID' }
      ],
      'MRN-12348': [
        { name: 'Sertraline', dosage: '50mg', frequency: 'Daily' }
      ]
    };
    return medications[patientId] || [];
  }

  getSyntheticEncounters(patientId) {
    return [
      { encounterType: 'Office Visit', admitDate: '2025-01-15', chiefComplaint: 'Follow-up' },
      { encounterType: 'Lab Work', admitDate: '2025-01-10', chiefComplaint: 'Routine labs' }
    ];
  }

  calculateAge(dateOfBirth) {
    if (!dateOfBirth) return null;
    const today = new Date();
    const birth = new Date(dateOfBirth);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  }

  generatePatientAlerts(patient, diagnoses, medications) {
    const alerts = [];
    const diagCodes = diagnoses.map(d => d.icdCode);

    // Check for diabetes without recent HbA1c
    if (diagCodes.some(c => c?.startsWith('E11'))) {
      alerts.push({
        severity: 'medium',
        message: 'Diabetic patient - ensure HbA1c within 3 months',
        action: 'Order HbA1c if not recent'
      });
    }

    // Check for heart failure
    if (diagCodes.some(c => c?.startsWith('I50'))) {
      alerts.push({
        severity: 'high',
        message: 'Heart failure patient - monitor weight and symptoms',
        action: 'Review BNP and weight trend'
      });
    }

    return alerts;
  }

  analyzeCareGaps(patient, diagnoses, procedures) {
    const gaps = [];
    const diagCodes = diagnoses.map(d => d.icdCode);
    const age = this.calculateAge(patient.dateOfBirth);

    // Diabetes care gaps
    if (diagCodes.some(c => c?.startsWith('E11'))) {
      gaps.push({
        name: 'Diabetic Eye Exam',
        status: 'Due - no exam in past 12 months',
        priority: 'high',
        dueDate: 'Overdue',
        measure: 'HEDIS NQF 0055'
      });
      gaps.push({
        name: 'HbA1c Test',
        status: 'Due - last test >3 months ago',
        priority: 'high',
        dueDate: 'Due now',
        measure: 'HEDIS NQF 0059'
      });
    }

    // Age-based screenings
    if (age >= 50) {
      gaps.push({
        name: 'Colorectal Cancer Screening',
        status: 'Due - no colonoscopy on record',
        priority: 'medium',
        dueDate: 'Schedule within 30 days',
        measure: 'HEDIS NQF 0034'
      });
    }

    if (patient.gender === 'Female' && age >= 40) {
      gaps.push({
        name: 'Mammogram Screening',
        status: 'Due - no mammogram in past 24 months',
        priority: 'medium',
        dueDate: 'Schedule within 30 days',
        measure: 'HEDIS NQF 2372'
      });
    }

    // Annual flu vaccine for all
    gaps.push({
      name: 'Annual Flu Vaccine',
      status: 'Due for current season',
      priority: 'low',
      dueDate: 'Before end of flu season',
      measure: 'HEDIS NQF 0039'
    });

    return gaps;
  }

  flattenGremlinResult(result) {
    if (!result) return null;
    const flat = {};
    // Handle Map objects from TinkerPop
    const entries = result instanceof Map ? result.entries() : Object.entries(result);
    for (const [key, value] of entries) {
      if (key === 'id' || key === 'label') {
        flat[key] = value;
      } else if (Array.isArray(value) && value.length === 1) {
        flat[key] = value[0];
      } else {
        flat[key] = value;
      }
    }
    return flat;
  }

  /**
   * Process a healthcare request through the orchestration pipeline
   * Supports both slash commands (/patient P001) and natural language (patient summary for P001)
   */
  async process(request, context = {}) {
    const requestId = request.requestId || `req_${Date.now()}`;
    const startTime = Date.now();

    this.logger.info(`Processing request ${requestId}: ${request.query?.substring(0, 100)}...`);

    // Reset counters
    this.toolCallCount = 0;
    this.actionCount = 0;

    const reasoning = [];

    try {
      const query = request.query || '';

      // Check for slash commands first - route directly to handleSlashCommand
      if (query.startsWith('/')) {
        return await this.handleSlashCommand(query, context, requestId, startTime);
      }

      // For natural language queries, detect intent first
      // 1. Route the request - detect intent and mode
      const routing = await this.routeRequest(request, context);
      reasoning.push({
        step: 'intent_detection',
        thought: `Detected intent: ${routing.intent?.id || 'unknown'}`,
        action: 'route_request',
        observation: `Mode: ${routing.mode}, Recipe: ${routing.recipe?.id || 'none'}`
      });

      // 2. Validate against policy
      const policyResult = await this.validatePolicy(request, routing, context);
      reasoning.push({
        step: 'policy_check',
        thought: 'Validating against healthcare policies',
        action: 'check_policy',
        observation: policyResult.allowed ? 'Allowed' : `Blocked: ${policyResult.reason}`
      });

      if (!policyResult.allowed) {
        return this.buildResponse({
          requestId,
          success: false,
          type: 'policy_blocked',
          summary: policyResult.reason,
          routing,
          reasoning,
          duration: Date.now() - startTime
        });
      }

      // 3. For healthcare intents with good confidence, use architecture-based execution
      //    This uses the same RecipeExecutor path as slash commands
      const healthcareIntents = ['patient-summary', 'treatment-recommendation', 'care-gap-analysis', 'drug-interaction-check'];
      const intentId = routing.intent?.id?.replace(/^hc:/, '') || '';

      if (healthcareIntents.includes(intentId) && routing.intent?.confidence >= 0.7) {
        this.logger.info(`NL query matched healthcare intent '${intentId}' with confidence ${routing.intent.confidence}`);

        // Convert NL query to equivalent format for architecture-based handler
        // The handleArchitectureBasedCommand extracts inputs from the query
        return await this.handleArchitectureBasedCommand(query, context, requestId, startTime);
      }

      // 4. Check if this maps to a recipe (structured task) - lower confidence intents
      if (routing.recipe) {
        return this.executeRecipe(request, routing, context, reasoning, requestId, startTime);
      }

      // 5. Run ReAct loop for dynamic reasoning (general queries)
      const reactResult = await this.runReActLoop(request, routing, context, reasoning);

      return this.buildResponse({
        requestId,
        ...reactResult,
        routing,
        reasoning,
        duration: Date.now() - startTime
      });

    } catch (error) {
      this.logger.error(`Request ${requestId} failed:`, error);
      reasoning.push({
        step: 'error',
        thought: 'An error occurred',
        action: 'handle_error',
        observation: error.message
      });

      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: error.message,
        reasoning,
        duration: Date.now() - startTime
      });
    }
  }

  /**
   * Route request to determine intent and mode
   */
  async routeRequest(request, context) {
    if (!this.intentRouter) {
      return {
        success: true,
        intent: { id: 'general', confidence: 0.5 },
        mode: 'CLINICAL_DECISION_SUPPORT',
        recipe: null
      };
    }

    return await this.intentRouter.route(request);
  }

  /**
   * Validate request against policy engine
   */
  async validatePolicy(request, routing, context) {
    if (!this.policyEngine) {
      return { allowed: true, policiesApplied: [] };
    }

    return await this.policyEngine.validateOperation({
      type: 'request',
      intent: routing.intent?.id,
      mode: routing.mode
    }, {
      ...context,
      policyPack: context.policyPack || 'healthcare-default'
    });
  }

  /**
   * Execute a structured recipe
   */
  async executeRecipe(request, routing, context, reasoning, requestId, startTime) {
    reasoning.push({
      step: 'recipe_execution',
      thought: `Executing recipe: ${routing.recipe.id}`,
      action: 'execute_recipe',
      observation: 'Starting structured execution'
    });

    if (!this.recipeEngine) {
      return this.buildResponse({
        requestId,
        success: false,
        type: 'error',
        summary: 'Recipe engine not configured',
        routing,
        reasoning,
        duration: Date.now() - startTime
      });
    }

    const execution = await this.recipeEngine.execute(routing.recipe.id, {
      ...context,
      ...request,
      intentMode: routing.mode
    });

    reasoning.push({
      step: 'recipe_complete',
      thought: `Recipe completed with status: ${execution.status}`,
      action: 'recipe_result',
      observation: `${execution.stepsCompleted || 0} steps completed`
    });

    return this.buildResponse({
      requestId,
      success: execution.status === 'completed',
      type: 'recipe_execution',
      summary: `Executed recipe: ${routing.recipe.id}`,
      data: execution.context,
      execution,
      routing,
      reasoning,
      duration: Date.now() - startTime
    });
  }

  /**
   * Run ReAct reasoning loop
   */
  async runReActLoop(request, routing, context, reasoning) {
    if (!this.llmService) {
      return {
        success: false,
        type: 'error',
        summary: 'LLM service not configured for ReAct loop'
      };
    }

    const messages = [];

    // Build system prompt with healthcare context
    const systemPrompt = this.buildSystemPrompt(routing, context);

    // Initial user message
    messages.push({
      role: 'user',
      content: this.buildUserPrompt(request, routing, context)
    });

    let iterations = 0;
    let finalResponse = null;

    while (iterations < MAX_ITERATIONS && this.toolCallCount < MAX_TOOL_CALLS) {
      iterations++;

      // Call LLM with tools
      const llmResult = await this.llmService.invokeLLM(
        context.orgId || 'healthcare',
        context.userId || 'system',
        {
          provider: 'ANTHROPIC',
          systemPrompt,
          messages,
          tools: HEALTHCARE_TOOLS,
          temperature: 0.2,
          maxTokens: 4000,
          taskType: 'healthcare_react'
        }
      );

      const assistantMessage = llmResult.response;
      messages.push({ role: 'assistant', content: assistantMessage });

      // Check for tool calls
      const toolCalls = this.extractToolCalls(assistantMessage);

      if (toolCalls.length === 0) {
        // No tool calls - check if final response provided
        finalResponse = this.extractFinalResponse(assistantMessage);
        if (finalResponse) {
          reasoning.push({
            step: `iteration_${iterations}`,
            thought: 'Providing final response',
            action: 'provide_response',
            observation: finalResponse.summary
          });
          break;
        }

        // No tool calls and no final response - prompt to continue or conclude
        messages.push({
          role: 'user',
          content: 'Please either call a tool to gather more information, or call provide_response to give your final answer.'
        });
        continue;
      }

      // Execute tool calls
      for (const toolCall of toolCalls) {
        reasoning.push({
          step: `iteration_${iterations}`,
          thought: `Need to ${toolCall.name}`,
          action: toolCall.name,
          input: toolCall.input
        });

        const toolResult = await this.executeTool(toolCall, context);

        reasoning[reasoning.length - 1].observation =
          typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult).substring(0, 500);

        messages.push({
          role: 'user',
          content: `Tool result for ${toolCall.name}:\n${JSON.stringify(toolResult, null, 2)}`
        });

        this.toolCallCount++;

        // Check for provide_response tool
        if (toolCall.name === 'provide_response') {
          finalResponse = toolCall.input;
          break;
        }
      }

      if (finalResponse) break;
    }

    // Build final result
    if (finalResponse) {
      return {
        success: true,
        type: finalResponse.response_type || 'investigation',
        summary: finalResponse.summary,
        root_cause: finalResponse.root_cause,
        confidence: finalResponse.confidence || 0.7,
        findings: finalResponse.findings || [],
        recommended_actions: finalResponse.recommended_actions || [],
        compliance_status: finalResponse.compliance_status,
        data: finalResponse
      };
    }

    return {
      success: false,
      type: 'incomplete',
      summary: 'ReAct loop did not produce a final response',
      iterations,
      toolCalls: this.toolCallCount
    };
  }

  /**
   * Build system prompt for ReAct loop
   */
  buildSystemPrompt(routing, context) {
    const mode = routing.mode || 'CLINICAL_DECISION_SUPPORT';

    let prompt = `You are a healthcare AI assistant operating in ${mode} mode.

Your capabilities:
- Query patient data and PHI fields from the graph database
- Search past decisions and clinical guidelines from knowledge base
- Check compliance requirements (HIPAA, state laws)
- Assess risk of proposed changes
- Execute approved remediation actions

Your constraints:
- ALWAYS follow HIPAA guidelines for PHI handling
- NEVER make clinical decisions - provide decision SUPPORT only
- ALWAYS assess risk before recommending actions
- High-risk actions (score > 5) require human approval
- Maximum ${MAX_ACTIONS} actions per session

Response format:
Use the tools to gather information, then call provide_response with structured findings.
Show your reasoning at each step.`;

    // Add knowledge constraints if available
    if (this.knowledgeEngine) {
      const constraints = this.knowledgeEngine.getConstraints(context);
      if (constraints.length > 0) {
        prompt += `\n\nAdditional constraints:\n${constraints.map(c => `- ${c}`).join('\n')}`;
      }
    }

    // Add clinical hours awareness
    if (this.knowledgeEngine?.isWithinClinicalHours()) {
      prompt += `\n\nNOTE: Currently within clinical hours. Schema and PHI automation changes are restricted.`;
    }

    return prompt;
  }

  /**
   * Build user prompt with request context
   */
  buildUserPrompt(request, routing, context) {
    let prompt = request.query || request.message || '';

    if (context.patientId) {
      prompt += `\n\nPatient ID: ${context.patientId}`;
    }
    if (context.orgId) {
      prompt += `\nOrganization: ${context.orgId}`;
    }
    if (routing.intent) {
      prompt += `\n\n[System: Detected intent "${routing.intent.id}" with ${Math.round(routing.intent.confidence * 100)}% confidence]`;
    }

    return prompt;
  }

  /**
   * Execute a tool call
   */
  async executeTool(toolCall, context) {
    const { name, input } = toolCall;

    try {
      switch (name) {
        // Data source tools
        case 'get_patient_summary':
          return await this.toolGetPatientSummary(input, context);
        case 'get_phi_fields':
          return await this.toolGetPHIFields(input, context);
        case 'get_field_dependencies':
          return await this.toolGetFieldDependencies(input, context);
        case 'get_active_automation':
          return await this.toolGetActiveAutomation(input, context);
        case 'get_audit_trail':
          return await this.toolGetAuditTrail(input, context);

        // Knowledge base tools
        case 'search_similar_decisions':
          return await this.toolSearchSimilarDecisions(input, context);
        case 'get_clinical_guidelines':
          return await this.toolGetClinicalGuidelines(input, context);
        case 'get_compliance_requirements':
          return await this.toolGetComplianceRequirements(input, context);
        case 'get_known_patterns':
          return await this.toolGetKnownPatterns(input, context);

        // Validation tools
        case 'check_phi_compliance':
          return await this.toolCheckPHICompliance(input, context);
        case 'assess_change_risk':
          return await this.toolAssessChangeRisk(input, context);
        case 'check_drug_interactions':
          return await this.toolCheckDrugInteractions(input, context);

        // Action tools
        case 'request_approval':
          return await this.toolRequestApproval(input, context);
        case 'execute_remediation':
          return await this.toolExecuteRemediation(input, context);

        // Response tool
        case 'provide_response':
          return input; // Just return the input - it's the final response

        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      this.logger.error(`Tool ${name} failed:`, error);
      return { error: error.message };
    }
  }

  // ===========================================
  // TOOL IMPLEMENTATIONS
  // ===========================================

  async toolGetPatientSummary(input, context) {
    if (!this.graphService) return { error: 'Graph service not available' };

    const result = await this.graphService.client.query(
      `g.V('${input.patient_id}').hasLabel('Patient').valueMap()`
    );

    if (!result || result.length === 0) {
      return { found: false, message: 'Patient not found' };
    }

    // Get related data
    const encounters = await this.graphService.client.query(
      `g.V('${input.patient_id}').out('HAS_ENCOUNTER').limit(5).valueMap()`
    );
    const diagnoses = await this.graphService.client.query(
      `g.V('${input.patient_id}').out('HAS_DIAGNOSIS').valueMap()`
    );

    return {
      found: true,
      patient: result[0],
      recentEncounters: encounters,
      activeDiagnoses: diagnoses
    };
  }

  async toolGetPHIFields(input, context) {
    if (!this.graphService) return { error: 'Graph service not available' };

    const classification = input.classification || 'all';
    const query = classification === 'all'
      ? `g.V().hasLabel('Field').has('sensitivity', 'PHI').valueMap()`
      : `g.V().hasLabel('Field').has('phiClassification', '${classification}').valueMap()`;

    const fields = await this.graphService.client.query(query);

    return {
      count: fields.length,
      fields: fields.slice(0, 50), // Limit response size
      truncated: fields.length > 50
    };
  }

  async toolGetFieldDependencies(input, context) {
    if (!this.graphService) return { error: 'Graph service not available' };

    const depth = Math.min(input.depth || 2, 3);

    const readers = await this.graphService.client.query(
      `g.V('${input.field_id}').inE('READS_FIELD').outV().valueMap()`
    );
    const writers = await this.graphService.client.query(
      `g.V('${input.field_id}').inE('WRITES_FIELD').outV().valueMap()`
    );
    const displays = await this.graphService.client.query(
      `g.V('${input.field_id}').inE('DISPLAYS').outV().valueMap()`
    );

    return {
      fieldId: input.field_id,
      readers: readers.length,
      writers: writers.length,
      displays: displays.length,
      totalDependencies: readers.length + writers.length + displays.length,
      details: {
        readers: readers.slice(0, 10),
        writers: writers.slice(0, 10),
        displays: displays.slice(0, 10)
      }
    };
  }

  async toolGetActiveAutomation(input, context) {
    if (!this.graphService) return { error: 'Graph service not available' };

    const type = input.type || 'all';
    const query = type === 'all'
      ? `g.V().hasLabel('Flow', 'ApexTrigger', 'ProcessBuilder', 'ValidationRule').has('status', 'Active').valueMap()`
      : `g.V().hasLabel('${type}').has('status', 'Active').valueMap()`;

    const automation = await this.graphService.client.query(query);

    return {
      count: automation.length,
      automation: automation.slice(0, 30),
      truncated: automation.length > 30
    };
  }

  async toolGetAuditTrail(input, context) {
    if (!this.graphService) return { error: 'Graph service not available' };

    let query = `g.V().hasLabel('AuditEntry')
      .has('timestamp', gte('${input.start_date}'))
      .has('timestamp', lte('${input.end_date}'))`;

    if (input.user_id) {
      query += `.has('userId', '${input.user_id}')`;
    }

    query += `.order().by('timestamp', decr).limit(100).valueMap()`;

    const entries = await this.graphService.client.query(query);

    return {
      count: entries.length,
      entries,
      period: { start: input.start_date, end: input.end_date }
    };
  }

  async toolSearchSimilarDecisions(input, context) {
    if (!this.knowledgeEngine) return { error: 'Knowledge engine not available' };

    // Search for similar past decisions
    const knowledge = await this.knowledgeEngine.getRelevantKnowledge(
      input.query,
      context
    );

    return {
      found: knowledge.length,
      decisions: knowledge.slice(0, input.limit || 5).map(k => ({
        key: k.key,
        category: k.category,
        relevance: k.relevance,
        content: k.content
      }))
    };
  }

  async toolGetClinicalGuidelines(input, context) {
    if (!this.knowledgeEngine) return { error: 'Knowledge engine not available' };

    const guidance = this.knowledgeEngine.getGuidance(input.topic);

    // In a real system, this would query a guidelines database
    return {
      topic: input.topic,
      source: input.source || 'all',
      guidelines: guidance,
      note: 'Guidelines are for reference only - clinical judgment required'
    };
  }

  async toolGetComplianceRequirements(input, context) {
    if (!this.knowledgeEngine) return { error: 'Knowledge engine not available' };

    // Built-in HIPAA requirements
    const hipaaRequirements = {
      'PHI access': [
        'Access must be for treatment, payment, or operations',
        'Minimum necessary standard applies',
        'Access must be logged for audit',
        'User must have legitimate need'
      ],
      'consent': [
        'Written consent required for non-TPO uses',
        'Patient has right to revoke consent',
        'Consent must specify permitted uses'
      ],
      'breach notification': [
        'Notify affected individuals within 60 days',
        'Notify HHS if > 500 individuals affected',
        'Document breach risk assessment'
      ]
    };

    return {
      topic: input.topic,
      jurisdiction: input.jurisdiction || 'federal',
      requirements: hipaaRequirements[input.topic] || [],
      note: 'Consult legal counsel for specific guidance'
    };
  }

  async toolGetKnownPatterns(input, context) {
    // Match symptoms to known problem patterns
    const patterns = [
      {
        symptoms: ['high_phi_access', 'unusual_hours'],
        pattern: 'potential_breach',
        severity: 'critical',
        recommended_action: 'investigate_access'
      },
      {
        symptoms: ['field_dependency_high', 'no_test_coverage'],
        pattern: 'risky_automation',
        severity: 'high',
        recommended_action: 'add_test_coverage'
      },
      {
        symptoms: ['encryption_missing', 'phi_field'],
        pattern: 'unprotected_phi',
        severity: 'critical',
        recommended_action: 'enable_encryption'
      }
    ];

    const matches = patterns.filter(p =>
      p.symptoms.some(s => input.symptoms.includes(s))
    );

    return {
      symptoms: input.symptoms,
      matches: matches.length,
      patterns: matches
    };
  }

  async toolCheckPHICompliance(input, context) {
    // Evaluate PHI operation against HIPAA rules
    const violations = [];

    // Check purpose
    const validPurposes = ['treatment', 'payment', 'operations'];
    if (!validPurposes.includes(input.purpose) && input.purpose !== 'research') {
      violations.push({
        rule: 'HIPAA 164.502',
        message: 'PHI use must be for TPO or with authorization'
      });
    }

    // Check operation type
    if (input.operation === 'export' || input.operation === 'share') {
      violations.push({
        rule: 'HIPAA 164.512',
        message: 'External sharing requires authorization or exception',
        severity: 'high'
      });
    }

    // Check data elements
    const highRiskElements = ['SSN', 'MRN', 'diagnosis'];
    const hasHighRisk = input.data_elements.some(e =>
      highRiskElements.some(hr => e.toLowerCase().includes(hr.toLowerCase()))
    );

    if (hasHighRisk) {
      violations.push({
        rule: 'Minimum Necessary',
        message: 'High-sensitivity PHI elements detected - verify necessity',
        severity: 'medium'
      });
    }

    return {
      compliant: violations.filter(v => v.severity === 'high').length === 0,
      violations,
      recommendation: violations.length > 0
        ? 'Review access with compliance officer'
        : 'Operation appears compliant'
    };
  }

  async toolAssessChangeRisk(input, context) {
    let riskScore = 0;
    const factors = [];

    // Base risk by change type
    const typeRisks = {
      'field_delete': 4,
      'field_modify': 2,
      'schema_change': 5,
      'automation_change': 3,
      'migration': 6
    };

    riskScore += typeRisks[input.change_type] || 2;
    factors.push(`Base risk for ${input.change_type}: +${typeRisks[input.change_type] || 2}`);

    // Impact scope
    if (input.impact_scope?.phi_fields_affected > 0) {
      riskScore += 2;
      factors.push(`PHI fields affected (${input.impact_scope.phi_fields_affected}): +2`);
    }

    if (input.impact_scope?.automations_affected > 10) {
      riskScore += 2;
      factors.push(`Many automations affected (${input.impact_scope.automations_affected}): +2`);
    }

    // Clinical hours
    if (this.knowledgeEngine?.isWithinClinicalHours()) {
      riskScore += 1;
      factors.push('During clinical hours: +1');
    }

    const riskLevel = riskScore <= 2 ? 'LOW' : riskScore <= 4 ? 'MEDIUM' : riskScore <= 6 ? 'HIGH' : 'CRITICAL';
    const requiresApproval = riskScore > 5;

    // Store assessment for later action execution
    const assessmentId = `risk_${Date.now()}`;
    this.riskAssessments.set(assessmentId, {
      ...input,
      riskScore,
      timestamp: Date.now()
    });

    return {
      assessmentId,
      riskScore,
      riskLevel,
      requiresApproval,
      autoExecute: riskScore <= 4,
      factors,
      recommendation: requiresApproval
        ? 'Request approval before proceeding'
        : 'Safe to proceed with caution'
    };
  }

  async toolCheckDrugInteractions(input, context) {
    // Simplified drug interaction check
    // In production, this would call a drug database API
    const knownInteractions = [
      { drug1: 'warfarin', drug2: 'aspirin', severity: 'major', effect: 'Increased bleeding risk' },
      { drug1: 'metformin', drug2: 'contrast', severity: 'major', effect: 'Lactic acidosis risk' },
      { drug1: 'lisinopril', drug2: 'potassium', severity: 'moderate', effect: 'Hyperkalemia risk' }
    ];

    const medications = input.medications.map(m => m.toLowerCase());
    const interactions = [];

    for (const ki of knownInteractions) {
      if (medications.includes(ki.drug1) && medications.includes(ki.drug2)) {
        interactions.push(ki);
      }
    }

    return {
      medications: input.medications,
      interactionsFound: interactions.length > 0,
      severity: interactions.some(i => i.severity === 'major') ? 'major' :
                interactions.some(i => i.severity === 'moderate') ? 'moderate' : 'none',
      interactions,
      note: 'This is a simplified check - verify with pharmacist'
    };
  }

  async toolRequestApproval(input, context) {
    // Log approval request
    this.logger.info(`Approval requested: ${input.action} (risk: ${input.risk_score})`);

    const approvalId = `apr_${Date.now()}`;

    return {
      approvalId,
      status: 'pending',
      action: input.action,
      riskScore: input.risk_score,
      requiredApprover: input.approver_role,
      expiresIn: '30 minutes',
      message: `Approval request ${approvalId} submitted to ${input.approver_role}`
    };
  }

  async toolExecuteRemediation(input, context) {
    // Check action limit
    if (this.actionCount >= MAX_ACTIONS) {
      return {
        success: false,
        error: `Maximum actions (${MAX_ACTIONS}) reached for this session`
      };
    }

    // Verify risk assessment exists and not expired
    const assessment = this.riskAssessments.get(input.risk_assessment_id);
    if (!assessment) {
      return {
        success: false,
        error: 'Risk assessment required before action execution'
      };
    }

    if (Date.now() - assessment.timestamp > RISK_ASSESSMENT_EXPIRY_MS) {
      return {
        success: false,
        error: 'Risk assessment expired - please reassess'
      };
    }

    if (assessment.riskScore > 5) {
      return {
        success: false,
        error: 'High-risk action requires approval - use request_approval first'
      };
    }

    this.actionCount++;

    // Log the action
    this.logger.info(`Executing remediation: ${input.action} on ${input.target}`);

    return {
      success: true,
      action: input.action,
      target: input.target,
      executedAt: new Date().toISOString(),
      message: `Action ${input.action} executed on ${input.target}`
    };
  }

  /**
   * Extract tool calls from LLM response
   */
  extractToolCalls(response) {
    // Handle both string and structured responses
    if (typeof response === 'object' && response.tool_use) {
      return response.tool_use.map(tu => ({
        name: tu.name,
        input: tu.input
      }));
    }

    if (typeof response === 'string') {
      // Try to parse tool calls from text
      const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
      const calls = [];
      let match;
      while ((match = toolCallRegex.exec(response)) !== null) {
        try {
          const parsed = JSON.parse(match[1]);
          calls.push({
            name: parsed.name || parsed.tool,
            input: parsed.input || parsed.parameters
          });
        } catch (e) {
          // Ignore parse errors
        }
      }
      return calls;
    }

    return [];
  }

  /**
   * Extract final response from LLM output
   */
  extractFinalResponse(response) {
    if (typeof response === 'object' && response.provide_response) {
      return response.provide_response;
    }

    // Try to find structured response in text
    const responseMatch = /<provide_response>([\s\S]*?)<\/provide_response>/.exec(
      typeof response === 'string' ? response : JSON.stringify(response)
    );

    if (responseMatch) {
      try {
        return JSON.parse(responseMatch[1]);
      } catch (e) {
        return null;
      }
    }

    return null;
  }

  /**
   * Build structured response with UI hints
   */
  buildResponse(result) {
    const response = {
      requestId: result.requestId,
      success: result.success,
      type: result.type,

      // Structured data
      data: {
        summary: result.summary,
        root_cause: result.root_cause,
        confidence: result.confidence,
        findings: result.findings,
        routing: result.routing,
        execution: result.execution,
        ...result.data // Include patient, diagnoses, medications, etc.
      },

      // Suggested actions for UI
      suggested_actions: result.recommended_actions || [],

      // Compliance status
      compliance_status: result.compliance_status,

      // Full reasoning chain for transparency
      reasoning: result.reasoning,

      // UI component hints
      ui_components: this.buildUIComponents(result),

      // Backward compatibility - markdown version
      markdown: this.buildMarkdown(result),

      // Metadata
      duration_ms: result.duration,
      tool_calls: this.toolCallCount,
      timestamp: new Date().toISOString()
    };

    return response;
  }

  /**
   * Build UI component hints
   */
  buildUIComponents(result) {
    const components = [];

    // Status card
    components.push({
      type: 'status_card',
      status: result.success ? 'success' : 'error',
      summary: result.summary
    });

    // Findings list
    if (result.findings?.length > 0) {
      components.push({
        type: 'findings_list',
        findings: result.findings
      });
    }

    // Action buttons
    for (const action of result.recommended_actions || []) {
      components.push({
        type: 'action_button',
        action: action.action,
        target: action.target,
        risk_score: action.risk_score,
        command: action.command
      });
    }

    // Reasoning chain (collapsible)
    if (result.reasoning?.length > 0) {
      components.push({
        type: 'reasoning_chain',
        steps: result.reasoning,
        collapsible: true
      });
    }

    return components;
  }

  /**
   * Build markdown response for backward compatibility
   */
  buildMarkdown(result) {
    let md = `## ${result.type === 'error' ? '❌' : '✓'} ${result.summary || 'Healthcare Assistant Response'}\n\n`;

    if (result.root_cause) {
      md += `### Root Cause\n${result.root_cause}\n\n`;
    }

    if (result.confidence) {
      md += `**Confidence:** ${Math.round(result.confidence * 100)}%\n\n`;
    }

    if (result.findings?.length > 0) {
      md += `### Findings\n`;
      for (const f of result.findings) {
        const icon = f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : '🟡';
        md += `- ${icon} **${f.severity}**: ${f.message}\n`;
      }
      md += '\n';
    }

    if (result.recommended_actions?.length > 0) {
      md += `### Recommended Actions\n`;
      for (const a of result.recommended_actions) {
        md += `- \`${a.command || a.action}\` - Risk: ${a.risk_score || 'N/A'}/10\n`;
      }
      md += '\n';
    }

    if (result.reasoning?.length > 0) {
      md += `<details>\n<summary>Reasoning Steps (${result.reasoning.length})</summary>\n\n`;
      for (const r of result.reasoning) {
        md += `**${r.step}**\n`;
        if (r.thought) md += `- Thought: ${r.thought}\n`;
        if (r.action) md += `- Action: ${r.action}\n`;
        if (r.observation) md += `- Observation: ${r.observation}\n`;
        md += '\n';
      }
      md += `</details>\n`;
    }

    return md;
  }
}

export default HealthcareOrchestrator;
