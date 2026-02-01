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
 */

import { Logger } from '../../utils/logger.js';
import HEALTHCARE_TOOLS from './tools.js';

// Safety limits
const MAX_ITERATIONS = 10;
const MAX_TOOL_CALLS = 20;
const MAX_ACTIONS = 3;
const RISK_ASSESSMENT_EXPIRY_MS = 60000;

export class HealthcareOrchestrator {
  constructor(config = {}) {
    this.logger = new Logger('HealthcareOrchestrator');

    // Healthcare stack components
    this.intentRouter = config.intentRouter;
    this.policyEngine = config.policyEngine;
    this.knowledgeEngine = config.knowledgeEngine;
    this.recipeEngine = config.recipeEngine;
    this.graphService = config.graphService;

    // LLM service for ReAct loop
    this.llmService = config.llmService;

    // Cache for performance
    this.cache = config.cache;

    // Tool execution stats
    this.toolCallCount = 0;
    this.actionCount = 0;

    // Pending risk assessments (for action execution)
    this.riskAssessments = new Map();
  }

  /**
   * Main entry point - process a healthcare request
   */
  async processRequest(request, context = {}) {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.logger.info(`Processing request ${requestId}: ${request.query?.substring(0, 100)}...`);

    // Reset counters
    this.toolCallCount = 0;
    this.actionCount = 0;

    const reasoning = [];

    try {
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

      // 3. Check if this maps to a recipe (structured task)
      if (routing.recipe) {
        return this.executeRecipe(request, routing, context, reasoning, requestId, startTime);
      }

      // 4. Run ReAct loop for dynamic reasoning
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
      `g.V('${input.patient_id}').hasLabel('Patient').valueMap(true)`
    );

    if (!result || result.length === 0) {
      return { found: false, message: 'Patient not found' };
    }

    // Get related data
    const encounters = await this.graphService.client.query(
      `g.V('${input.patient_id}').out('HAS_ENCOUNTER').limit(5).valueMap(true)`
    );
    const diagnoses = await this.graphService.client.query(
      `g.V('${input.patient_id}').out('HAS_DIAGNOSIS').valueMap(true)`
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
      ? `g.V().hasLabel('Field').has('sensitivity', 'PHI').valueMap(true)`
      : `g.V().hasLabel('Field').has('phiClassification', '${classification}').valueMap(true)`;

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
      `g.V('${input.field_id}').inE('READS_FIELD').outV().valueMap(true)`
    );
    const writers = await this.graphService.client.query(
      `g.V('${input.field_id}').inE('WRITES_FIELD').outV().valueMap(true)`
    );
    const displays = await this.graphService.client.query(
      `g.V('${input.field_id}').inE('DISPLAYS').outV().valueMap(true)`
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
      ? `g.V().hasLabel('Flow', 'ApexTrigger', 'ProcessBuilder', 'ValidationRule').has('status', 'Active').valueMap(true)`
      : `g.V().hasLabel('${type}').has('status', 'Active').valueMap(true)`;

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

    query += `.order().by('timestamp', decr).limit(100).valueMap(true)`;

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
        execution: result.execution
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
