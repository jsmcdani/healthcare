/**
 * Recipe Engine
 * Executes recipes (predefined task execution plans) with policy and knowledge integration
 *
 * Contract Integration:
 * - Integrates with core contract enforcement
 * - Validates execution against schemas
 * - Supports artifact creation through contracts
 *
 * Confidence Integration:
 * - Central confidence computation for clinical responses
 * - Same model applies whether LLM or deterministic execution
 * - Per the spec: "Confidence computed by control plane, never by LLM"
 */

import { Logger } from '../../../utils/logger.js';
import {
  calculateClinicalConfidence,
  buildSignalsFromRecipeResult,
  initializeClinicalConfidence
} from '../../confidence/ClinicalConfidenceIntegration.js';

// Contract enforcement integration (lazy load to avoid circular deps)
let ContractEnforcer = null;
let ArtifactFactories = null;

async function loadContractModules() {
  if (!ContractEnforcer) {
    try {
      const module = await import('../../../core/contracts/ContractEnforcer.js');
      ContractEnforcer = module.getContractEnforcer;
    } catch (e) {
      // Contract module not available
    }
  }
  if (!ArtifactFactories) {
    try {
      const module = await import('../../../core/artifacts/index.js');
      ArtifactFactories = {
        createFeaturePack: module.createFeaturePack,
        createProposal: module.createProposal
      };
    } catch (e) {
      // Artifact module not available
    }
  }
}

export class RecipeEngine {
  constructor(options = {}) {
    this.logger = new Logger('RecipeEngine');
    this.recipePacks = new Map();
    this.stepHandlers = new Map();
    this.policyEngine = options.policyEngine;
    this.knowledgeEngine = options.knowledgeEngine;
    this.graphService = options.graphService;

    // Contract enforcement
    this.contractEnforcer = null;
    this.artifactFactories = null;
    this.enforcementEnabled = options.enforcementEnabled !== false;

    // Initialize contract modules asynchronously
    this.initPromise = this.initializeContracts();
  }

  /**
   * Initialize contract enforcement
   */
  async initializeContracts() {
    await loadContractModules();
    if (ContractEnforcer && this.enforcementEnabled) {
      this.contractEnforcer = ContractEnforcer();
      this.logger.info('Contract enforcement enabled for RecipeEngine');
    }
    if (ArtifactFactories) {
      this.artifactFactories = ArtifactFactories;
    }
  }

  /**
   * Ensure contracts are initialized
   */
  async ensureInitialized() {
    await this.initPromise;
  }

  /**
   * Set dependent engines
   */
  setEngines({ policyEngine, knowledgeEngine, graphService }) {
    this.policyEngine = policyEngine;
    this.knowledgeEngine = knowledgeEngine;
    this.graphService = graphService;
  }

  /**
   * Load a recipe pack
   */
  async loadRecipePack(packDefinition) {
    const { name, version, recipes, metadata } = packDefinition;

    if (!name || !recipes) {
      throw new Error('Recipe pack must have name and recipes');
    }

    const pack = {
      name,
      version: version || '1.0.0',
      recipes: new Map(),
      metadata: metadata || {},
      loadedAt: new Date().toISOString()
    };

    for (const recipe of recipes) {
      pack.recipes.set(recipe.name, {
        ...recipe,
        packName: name
      });
    }

    this.recipePacks.set(name, pack);
    this.logger.info(`Loaded recipe pack: ${name} v${version} with ${recipes.length} recipes`);

    return pack;
  }

  /**
   * Register a step handler
   */
  registerStepHandler(stepType, handler) {
    this.stepHandlers.set(stepType, handler);
    this.logger.debug(`Registered step handler: ${stepType}`);
  }

  /**
   * Get a recipe by name
   */
  getRecipe(recipeName, packName = null) {
    if (packName) {
      const pack = this.recipePacks.get(packName);
      return pack?.recipes.get(recipeName);
    }

    // Search all packs
    for (const pack of this.recipePacks.values()) {
      const recipe = pack.recipes.get(recipeName);
      if (recipe) return recipe;
    }

    return null;
  }

  /**
   * Execute a recipe
   */
  async execute(recipe, context = {}) {
    // Ensure contract modules are loaded
    await this.ensureInitialized();

    const executionId = `exec_${Date.now()}`;
    const execution = {
      id: executionId,
      recipe: recipe.name,
      startTime: new Date().toISOString(),
      steps: [],
      status: 'running',
      context: { ...context },
      outputs: {},
      errors: []
    };

    this.logger.info(`Starting recipe execution: ${recipe.name}`, { executionId });

    try {
      // Pre-execution policy check
      if (this.policyEngine) {
        const validation = await this.policyEngine.validateOperation(
          { type: 'recipe_execution', recipe: recipe.name },
          context
        );

        if (!validation.allowed) {
          execution.status = 'blocked';
          execution.errors.push({
            phase: 'pre_execution',
            message: 'Blocked by policy',
            violations: validation.violations
          });
          return this.finalizeExecution(execution);
        }
      }

      // Get knowledge context
      let knowledgeContext = {};
      if (this.knowledgeEngine) {
        const knowledge = await this.knowledgeEngine.getRelevantKnowledge(
          recipe.taskType || 'general',
          context
        );
        knowledgeContext = {
          constraints: knowledge.filter(k => k.type === 'constraint'),
          guidance: knowledge.filter(k => k.type === 'guidance')
        };
      }

      // Execute steps
      for (const step of recipe.steps || []) {
        const stepResult = await this.executeStep(step, execution, knowledgeContext);
        execution.steps.push(stepResult);

        if (stepResult.status === 'failed' && !step.continueOnError) {
          execution.status = 'failed';
          break;
        }

        // Update context with step outputs
        if (stepResult.outputs) {
          Object.assign(execution.outputs, stepResult.outputs);
          Object.assign(execution.context, stepResult.outputs);
        }
      }

      // Mark complete if not failed
      if (execution.status === 'running') {
        execution.status = 'completed';
      }

    } catch (error) {
      execution.status = 'failed';
      execution.errors.push({
        phase: 'execution',
        message: error.message,
        stack: error.stack
      });
    }

    return this.finalizeExecution(execution);
  }

  /**
   * Execute a single step
   */
  async executeStep(step, execution, knowledgeContext) {
    const stepExecution = {
      name: step.name,
      type: step.type,
      startTime: new Date().toISOString(),
      status: 'running',
      outputs: {},
      logs: []
    };

    try {
      // Check step condition
      if (step.condition && !this.evaluateCondition(step.condition, execution.context)) {
        stepExecution.status = 'skipped';
        stepExecution.logs.push('Condition not met, skipping step');
        return stepExecution;
      }

      // Get step handler
      const handler = this.stepHandlers.get(step.type);
      if (!handler) {
        // Default handlers for common step types
        switch (step.type) {
          case 'query':
            stepExecution.outputs = await this.handleQueryStep(step, execution.context);
            break;
          case 'transform':
            stepExecution.outputs = await this.handleTransformStep(step, execution.context);
            break;
          case 'validate':
            stepExecution.outputs = await this.handleValidateStep(step, execution.context);
            break;
          case 'analyze':
            stepExecution.outputs = await this.handleAnalyzeStep(step, execution.context);
            break;
          case 'aggregate':
            stepExecution.outputs = await this.handleAggregateStep(step, execution.context);
            break;
          case 'llm.analyze':
            stepExecution.outputs = await this.handleLLMAnalyzeStep(step, execution.context, knowledgeContext);
            break;
          case 'llm.recommend':
            stepExecution.outputs = await this.handleLLMRecommendStep(step, execution.context, knowledgeContext);
            break;
          case 'llm.classify':
            stepExecution.outputs = await this.handleLLMClassifyStep(step, execution.context);
            break;
          default:
            throw new Error(`Unknown step type: ${step.type}`);
        }
      } else {
        stepExecution.outputs = await handler(step, execution.context, knowledgeContext);
      }

      stepExecution.status = 'completed';

    } catch (error) {
      stepExecution.status = 'failed';
      stepExecution.error = error.message;
      execution.errors.push({
        phase: 'step',
        step: step.name,
        message: error.message
      });
    }

    stepExecution.endTime = new Date().toISOString();
    return stepExecution;
  }

  /**
   * Handle query step
   */
  async handleQueryStep(step, context) {
    if (!this.graphService) {
      throw new Error('Graph service not available for query step');
    }

    const query = this.interpolate(step.query, context);
    const results = await this.graphService.client.query(query);

    return {
      [step.outputKey || 'queryResults']: results
    };
  }

  /**
   * Handle transform step
   */
  async handleTransformStep(step, context) {
    const input = this.resolveInput(step.input, context);
    let output = input;

    for (const operation of step.operations || []) {
      switch (operation.type) {
        case 'map':
          output = output.map(item => this.applyMapping(item, operation.mapping));
          break;
        case 'filter':
          output = output.filter(item => this.evaluateCondition(operation.condition, item));
          break;
        case 'sort':
          output = output.sort((a, b) => {
            const aVal = a[operation.field];
            const bVal = b[operation.field];
            return operation.order === 'desc' ? bVal - aVal : aVal - bVal;
          });
          break;
        case 'group':
          output = this.groupBy(output, operation.field);
          break;
        case 'limit':
          output = output.slice(0, operation.count);
          break;
      }
    }

    return {
      [step.outputKey || 'transformedData']: output
    };
  }

  /**
   * Handle validate step
   */
  async handleValidateStep(step, context) {
    const input = this.resolveInput(step.input, context);
    const violations = [];

    for (const rule of step.rules || []) {
      for (const item of Array.isArray(input) ? input : [input]) {
        if (!this.evaluateCondition(rule.condition, item)) {
          violations.push({
            rule: rule.name,
            item: item.id || item.name,
            message: rule.message
          });
        }
      }
    }

    return {
      valid: violations.length === 0,
      violations
    };
  }

  /**
   * Handle analyze step
   */
  async handleAnalyzeStep(step, context) {
    const input = this.resolveInput(step.input, context);
    const analysis = {
      count: Array.isArray(input) ? input.length : 1,
      summary: {}
    };

    if (Array.isArray(input)) {
      // Compute field statistics
      for (const field of step.analyzeFields || []) {
        const values = input.map(i => i[field]).filter(v => v !== undefined);
        analysis.summary[field] = {
          count: values.length,
          unique: [...new Set(values)].length
        };

        if (values.every(v => typeof v === 'number')) {
          analysis.summary[field].min = Math.min(...values);
          analysis.summary[field].max = Math.max(...values);
          analysis.summary[field].avg = values.reduce((a, b) => a + b, 0) / values.length;
        }
      }
    }

    return {
      [step.outputKey || 'analysis']: analysis
    };
  }

  /**
   * Handle aggregate step
   */
  async handleAggregateStep(step, context) {
    const inputs = step.inputs.map(input => this.resolveInput(input, context));

    let aggregated;
    switch (step.method) {
      case 'concat':
        aggregated = inputs.flat();
        break;
      case 'merge':
        aggregated = Object.assign({}, ...inputs);
        break;
      case 'union':
        aggregated = [...new Set(inputs.flat())];
        break;
      default:
        aggregated = inputs;
    }

    return {
      [step.outputKey || 'aggregated']: aggregated
    };
  }

  /**
   * Handle LLM analyze step - calls Claude for reasoning
   * Data should already be in context from prior graph/cache steps
   */
  async handleLLMAnalyzeStep(step, context, knowledgeContext) {
    if (!this.llmService) {
      throw new Error('LLM service not configured - required for llm.analyze step');
    }

    // Build system prompt with healthcare context
    const systemPrompt = step.systemPrompt || this.buildHealthcareSystemPrompt(step, knowledgeContext);

    // Build user prompt from step config and context data
    const input = this.resolveInput(step.input, context);
    const userPrompt = step.userPrompt
      ? this.interpolate(step.userPrompt, { ...context, input: JSON.stringify(input) })
      : `Analyze the following healthcare data:\n\n${JSON.stringify(input, null, 2)}`;

    // Get output schema if specified
    const outputSchema = step.schema ? this.getSchema(step.schema) : null;

    // Call LLM with caching
    const result = await this.llmService.invokeLLM(
      context.orgId || 'healthcare',
      context.userId || 'system',
      {
        provider: 'ANTHROPIC',
        systemPrompt,
        userPrompt,
        temperature: step.temperature || 0.2,
        maxTokens: step.maxTokens || 4000,
        outputSchema,
        skipCache: step.skipCache || false,
        cachePrefix: `healthcare:${context.recipe || 'unknown'}`,
        taskType: step.taskType || 'healthcare_analysis'
      }
    );

    // Parse response
    let analysis;
    try {
      analysis = typeof result.response === 'string'
        ? JSON.parse(result.response)
        : result.response;
    } catch (e) {
      analysis = { rawResponse: result.response, parseError: e.message };
    }

    return {
      [step.outputKey || 'llmAnalysis']: analysis,
      llmMetadata: {
        model: result.model,
        duration: result.duration,
        cached: result.cached || false
      }
    };
  }

  /**
   * Handle LLM recommend step - generates recommendations
   */
  async handleLLMRecommendStep(step, context, knowledgeContext) {
    if (!this.llmService) {
      throw new Error('LLM service not configured - required for llm.recommend step');
    }

    const input = this.resolveInput(step.input, context);
    const systemPrompt = step.systemPrompt ||
      `You are a healthcare compliance and optimization advisor. Generate actionable recommendations based on the analysis provided. Follow HIPAA guidelines.`;

    const userPrompt = step.userPrompt
      ? this.interpolate(step.userPrompt, { ...context, input: JSON.stringify(input) })
      : `Based on this analysis, provide prioritized recommendations:\n\n${JSON.stringify(input, null, 2)}`;

    const outputSchema = step.schema ? this.getSchema(step.schema) : null;

    const result = await this.llmService.invokeLLM(
      context.orgId || 'healthcare',
      context.userId || 'system',
      {
        provider: 'ANTHROPIC',
        systemPrompt,
        userPrompt,
        temperature: step.temperature || 0.3,
        maxTokens: step.maxTokens || 2000,
        outputSchema,
        skipCache: step.skipCache || false,
        cachePrefix: `healthcare:${context.recipe || 'unknown'}`,
        taskType: 'healthcare_recommendation'
      }
    );

    let recommendations;
    try {
      recommendations = typeof result.response === 'string'
        ? JSON.parse(result.response)
        : result.response;
    } catch (e) {
      recommendations = { rawResponse: result.response, parseError: e.message };
    }

    return {
      [step.outputKey || 'recommendations']: recommendations
    };
  }

  /**
   * Handle LLM classify step - intent/category classification
   */
  async handleLLMClassifyStep(step, context) {
    if (!this.llmService) {
      throw new Error('LLM service not configured - required for llm.classify step');
    }

    const input = this.resolveInput(step.input, context);
    const categories = step.categories || [];

    const systemPrompt = `Classify the input into one of these categories: ${categories.join(', ')}. Return only the category name.`;
    const userPrompt = typeof input === 'string' ? input : JSON.stringify(input);

    const result = await this.llmService.invokeLLM(
      context.orgId || 'healthcare',
      context.userId || 'system',
      {
        provider: 'ANTHROPIC',
        systemPrompt,
        userPrompt,
        temperature: 0.1,
        maxTokens: 100,
        skipCache: false,
        cachePrefix: `healthcare:classify`,
        taskType: 'healthcare_classification'
      }
    );

    const classification = result.response?.trim();

    return {
      [step.outputKey || 'classification']: classification,
      confidence: categories.includes(classification) ? 0.9 : 0.5
    };
  }

  /**
   * Build healthcare-specific system prompt
   */
  buildHealthcareSystemPrompt(step, knowledgeContext) {
    const basePrompt = `You are a healthcare AI assistant specialized in ${step.domain || 'clinical analysis'}.
You must:
- Follow HIPAA guidelines for all PHI handling
- Provide evidence-based analysis
- Flag any compliance concerns
- Never make clinical decisions - only provide decision support`;

    // Add knowledge context if available
    if (knowledgeContext?.constraints?.length) {
      return basePrompt + `\n\nConstraints to consider:\n${knowledgeContext.constraints.map(c => `- ${c.description}`).join('\n')}`;
    }

    return basePrompt;
  }

  /**
   * Get schema by name from registry
   */
  getSchema(schemaName) {
    // Lazy load schemas to avoid circular deps
    if (!this.schemaRegistry) {
      try {
        const schemas = require('../../schemas/healthcare-outputs.schema.js');
        this.schemaRegistry = schemas.HealthcareSchemas || schemas;
      } catch (e) {
        this.logger.warn('Could not load healthcare schemas:', e.message);
        return null;
      }
    }
    return this.schemaRegistry[schemaName] || null;
  }

  /**
   * Set LLM service for recipe execution
   */
  setLLMService(llmService) {
    this.llmService = llmService;
    this.logger.info('LLM service configured for RecipeEngine');
  }

  /**
   * Interpolate variables in a string
   */
  interpolate(template, context) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return context[key] !== undefined ? context[key] : match;
    });
  }

  /**
   * Resolve input reference
   */
  resolveInput(inputRef, context) {
    if (typeof inputRef === 'string' && inputRef.startsWith('$')) {
      return context[inputRef.substring(1)];
    }
    return inputRef;
  }

  /**
   * Apply mapping to an item
   */
  applyMapping(item, mapping) {
    const result = {};
    for (const [targetKey, sourceKey] of Object.entries(mapping)) {
      result[targetKey] = typeof sourceKey === 'string' && sourceKey.startsWith('$')
        ? item[sourceKey.substring(1)]
        : sourceKey;
    }
    return result;
  }

  /**
   * Evaluate a condition
   */
  evaluateCondition(condition, context) {
    if (typeof condition === 'function') {
      return condition(context);
    }

    for (const [key, expected] of Object.entries(condition)) {
      const actual = context[key];

      if (typeof expected === 'object' && expected !== null) {
        if (expected.$eq !== undefined && actual !== expected.$eq) return false;
        if (expected.$ne !== undefined && actual === expected.$ne) return false;
        if (expected.$in !== undefined && !expected.$in.includes(actual)) return false;
        if (expected.$gt !== undefined && !(actual > expected.$gt)) return false;
        if (expected.$exists !== undefined && (actual !== undefined) !== expected.$exists) return false;
      } else {
        if (actual !== expected) return false;
      }
    }

    return true;
  }

  /**
   * Group items by field
   */
  groupBy(items, field) {
    const groups = {};
    for (const item of items) {
      const key = item[field];
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return groups;
  }

  /**
   * Finalize execution and store artifact
   */
  async finalizeExecution(execution) {
    execution.endTime = new Date().toISOString();
    execution.duration = new Date(execution.endTime) - new Date(execution.startTime);

    // ============================================
    // CENTRAL CONFIDENCE COMPUTATION (Control Plane)
    // Same model applies whether LLM or deterministic execution
    // Per spec: "Confidence computed centrally, never by LLM"
    // ============================================
    try {
      // Initialize confidence system if needed
      initializeClinicalConfidence();

      // Build execution context for model selection
      const executionContext = {
        intentId: execution.context.intentId || execution.recipe,
        intentMode: execution.context.intentMode || 'CLINICAL_DECISION_SUPPORT',
        recipeId: execution.recipe,
        decisionType: execution.context.decisionType
      };

      // Gather signals from execution
      const llmSteps = execution.steps.filter(s => s.type?.startsWith('llm.'));
      const failedSteps = execution.steps.filter(s => s.status === 'failed');
      const completedSteps = execution.steps.filter(s => s.status === 'completed');

      // Check for LLM metadata in step outputs
      const llmMetadata = execution.outputs.llmMetadata || {};

      // Build signals for confidence calculation
      const executionSignals = {
        // Data signals
        dataCompleteness: this.calculateDataCompleteness(execution.outputs),
        dataQuality: execution.context.dataQuality ?? 0.6,
        sourceReliability: execution.context.sourceReliability ?? 0.7,
        evidenceLevel: execution.context.evidenceLevel ?? 0.6,
        modelCertainty: llmMetadata.cached ? 0.8 : 0.6,
        temporalRelevance: execution.context.temporalRelevance ?? 0.7,

        // Execution path signals
        llmUsed: llmSteps.length > 0,
        llmFailed: llmSteps.some(s => s.status === 'failed'),

        // Data quality signals
        missingCritical: execution.context.missingCritical || false,
        hasDataConflict: execution.context.hasDataConflict || false,
        syntheticData: execution.context.syntheticData || execution.context.demoMode || false,

        // Positive signals
        multipleSources: execution.context.multipleSources || false,
        expertReviewed: execution.context.expertReviewed || false,
        recentlyValidated: execution.context.recentlyValidated || false,

        // Execution metadata
        totalSteps: execution.steps.length,
        completedSteps: completedSteps.length,
        failedSteps: failedSteps.length,
        cacheHits: execution.context.cacheHits || 0
      };

      // Calculate confidence using central computation
      execution.confidence = calculateClinicalConfidence(executionContext, executionSignals);

      this.logger.info('Clinical confidence computed for recipe', {
        recipe: execution.recipe,
        modelId: execution.confidence.modelId,
        confidence: execution.confidence.value,
        level: execution.confidence.level,
        canProceed: execution.confidence.canProceed,
        llmUsed: executionSignals.llmUsed
      });

    } catch (confidenceError) {
      this.logger.warn('Failed to compute clinical confidence', { error: confidenceError.message });
      // Provide fallback confidence indicating uncertainty
      execution.confidence = {
        value: 0,
        level: 'UNCERTAIN',
        canProceed: false,
        safetyFlag: 'COMPUTATION_ERROR',
        modelId: 'fallback',
        reason: confidenceError.message
      };
    }

    // Store decision artifact if graph available
    if (this.graphService && execution.status !== 'blocked') {
      try {
        await this.graphService.addDecisionArtifact({
          id: execution.id,
          taskType: execution.recipe,
          decision: execution.status === 'completed' ? 'success' : 'failure',
          timestamp: execution.endTime,
          intentMode: execution.context.intentMode,
          recipeExecuted: execution.recipe,
          stepsCompleted: execution.steps.filter(s => s.status === 'completed').length,
          errors: execution.errors,
          // Include confidence in decision artifact for audit trail
          confidence: execution.confidence
        });
      } catch (e) {
        this.logger.debug('Failed to store decision artifact:', e.message);
      }
    }

    this.logger.info(`Recipe execution complete: ${execution.recipe}`, {
      executionId: execution.id,
      status: execution.status,
      duration: execution.duration,
      confidence: execution.confidence?.level
    });

    return execution;
  }

  /**
   * Calculate data completeness from outputs
   */
  calculateDataCompleteness(outputs) {
    if (!outputs || typeof outputs !== 'object') return 0.5;

    let totalFields = 0;
    let populatedFields = 0;

    const countFields = (obj, depth = 0) => {
      if (depth > 3 || !obj || typeof obj !== 'object') return;
      for (const key of Object.keys(obj)) {
        if (key.startsWith('_') || key === 'llmMetadata') continue; // Skip internal fields
        totalFields++;
        const value = obj[key];
        if (value !== null && value !== undefined && value !== '') {
          populatedFields++;
        }
        if (typeof value === 'object' && !Array.isArray(value)) {
          countFields(value, depth + 1);
        }
      }
    };

    countFields(outputs);
    return totalFields > 0 ? populatedFields / totalFields : 0.5;
  }

  /**
   * Get loaded packs info
   */
  getLoadedPacks() {
    return Array.from(this.recipePacks.values()).map(pack => ({
      name: pack.name,
      version: pack.version,
      recipeCount: pack.recipes.size,
      loadedAt: pack.loadedAt
    }));
  }

  /**
   * Get all recipes for a task type
   */
  getRecipesForTaskType(taskType) {
    const recipes = [];
    for (const pack of this.recipePacks.values()) {
      for (const recipe of pack.recipes.values()) {
        if (recipe.taskType === taskType || recipe.taskTypes?.includes(taskType)) {
          recipes.push(recipe);
        }
      }
    }
    return recipes;
  }
}

export default RecipeEngine;
