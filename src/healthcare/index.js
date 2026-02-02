/**
 * Metalligent Healthcare Platform
 * Main export for healthcare intelligence modules
 *
 * Architecture:
 * - Intent Detection → determines mode (PHI_PROTECTION, CLINICAL_DECISION_SUPPORT)
 * - Policy Evaluation → validates against healthcare policies
 * - ReAct Loop → reasoning with tools (graph, knowledge, actions)
 * - Recipes → structured multi-step workflows
 * - JSON Contracts → structured outputs with reasoning chain
 */

// Intent System
export {
  IntentModes as HealthcareIntentModes,
  getMode,
  getModesByPriority,
  isRecipeAllowedInMode,
  getDefaultMode
} from './intent/IntentModeRegistry.js';
export { IntentRouter } from './intent/IntentRouter.js';

// Policy Pack
export { PolicyEngine } from './packs/policy/PolicyEngine.js';

// Knowledge Pack
export { KnowledgeEngine } from './packs/knowledge/KnowledgeEngine.js';

// Recipe Pack
export { RecipeEngine } from './packs/recipe/RecipeEngine.js';

// ReAct Orchestrator
export { HealthcareOrchestrator } from './react/HealthcareOrchestrator.js';
export { HEALTHCARE_TOOLS } from './react/tools.js';

// Reasoning
export { ReasonBuilder, ReasonTypes, ConfidenceLevels } from './reasoning/ReasonBuilder.js';
export { DecisionArtifact, DecisionOutcome, DecisionCategory } from './reasoning/DecisionArtifact.js';

// Schemas
export { HealthcareSchemas } from './schemas/healthcare-outputs.schema.js';

// Convenience re-export of schema types
export {
  VertexLabels,
  EdgeLabels,
  SensitivityLevels,
  PHIClassifications,
  IntentModes
} from '../database/schema/healthcare-graph-schema.js';

// Correctness Assurance (Phase 9)
export {
  createCorrectnessStack,
  CorrectnessEvaluator,
  GroundTruthRegistry,
  AssertionEngine,
  CalibrationFramework,
  ExpertReviewWorkflow,
  OutcomeTracker,
  FeedbackAnalyzer,
  CorrectnessStatus,
  AssertionTypes,
  AssertionSeverity,
  ReviewStatus,
  ReviewDecision,
  OutcomeType
} from '../core/correctness/index.js';

/**
 * Create a fully configured healthcare intelligence stack
 * Includes ReAct orchestrator for dynamic reasoning
 */
export async function createHealthcareStack(options = {}) {
  const { PolicyEngine } = await import('./packs/policy/PolicyEngine.js');
  const { KnowledgeEngine } = await import('./packs/knowledge/KnowledgeEngine.js');
  const { RecipeEngine } = await import('./packs/recipe/RecipeEngine.js');
  const { IntentRouter } = await import('./intent/IntentRouter.js');
  const { HealthcareOrchestrator } = await import('./react/HealthcareOrchestrator.js');
  const { CosmosGraphService } = await import('../database/CosmosGraphService.js');

  // Initialize graph service
  const graphService = new CosmosGraphService(options.cosmos);
  if (options.initializeGraph !== false) {
    await graphService.initialize();
  }

  // Initialize engines
  const policyEngine = new PolicyEngine();
  const knowledgeEngine = new KnowledgeEngine({ graphService });
  const recipeEngine = new RecipeEngine({ policyEngine, knowledgeEngine, graphService });

  // Load default policy pack
  const fs = await import('fs/promises');
  const path = await import('path');
  const policyPath = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
    'packs/policy/healthcare-default.policy.json'
  );

  try {
    await policyEngine.loadPolicyPackFromFile(policyPath);
  } catch (e) {
    console.warn('Could not load default policy pack:', e.message);
  }

  // Initialize knowledge engine
  await knowledgeEngine.initialize(graphService);

  // Initialize intent router
  const intentRouter = new IntentRouter({ policyEngine, knowledgeEngine });

  // Initialize ReAct orchestrator
  const orchestrator = new HealthcareOrchestrator({
    intentRouter,
    policyEngine,
    knowledgeEngine,
    recipeEngine,
    graphService,
    llmService: options.llmService,
    cache: options.cache
  });

  // Wire LLM service to recipe engine if provided
  if (options.llmService) {
    recipeEngine.setLLMService(options.llmService);
  }

  // Initialize correctness stack if requested
  let correctnessStack = null;
  if (options.enableCorrectness !== false) {
    try {
      const { createCorrectnessStack } = await import('../core/correctness/index.js');
      correctnessStack = await createCorrectnessStack({
        groundTruthOptions: options.groundTruthOptions,
        triggerConfig: options.reviewTriggerConfig,
        calibrationOptions: options.calibrationOptions,
        ...options.correctnessOptions
      });
    } catch (e) {
      console.warn('Could not initialize correctness stack:', e.message);
    }
  }

  return {
    graphService,
    policyEngine,
    knowledgeEngine,
    recipeEngine,
    intentRouter,
    orchestrator,
    correctnessStack,

    /**
     * Process a natural language request through ReAct loop
     * This is the main entry point for the healthcare AI assistant
     */
    async chat(query, context = {}) {
      return await orchestrator.processRequest({ query }, context);
    },

    /**
     * Process a structured task (routes to recipe if available)
     */
    async processTask(task, context = {}) {
      // Route the task
      const routing = await intentRouter.route(task, context);
      if (!routing.success) {
        return {
          success: false,
          error: routing.error,
          decision: DecisionArtifact.create({ taskType: task.type })
            .deny(routing.error)
            .finalize()
            .toArtifact()
        };
      }

      // Execute the recipe if found
      if (routing.recipe) {
        const execution = await recipeEngine.execute(routing.recipe, {
          ...context,
          intentMode: routing.intentMode,
          task
        });

        const decision = DecisionArtifact.create({
          taskType: task.type,
          intentMode: routing.intentMode,
          context
        });

        if (execution.status === 'completed') {
          decision.approve('Task completed successfully');
        } else if (execution.status === 'blocked') {
          decision.deny('Blocked by policy', execution.errors);
        } else {
          decision.deny('Execution failed', execution.errors);
        }

        decision.setRecipeExecution(execution);
        decision.finalize();

        return {
          success: execution.status === 'completed',
          routing,
          execution,
          decision: decision.toArtifact()
        };
      }

      return {
        success: true,
        routing,
        message: 'No recipe found for task'
      };
    },

    /**
     * Evaluate decision artifact for correctness
     */
    async evaluateCorrectness(artifact, options = {}) {
      if (!correctnessStack) {
        return { success: false, error: 'Correctness stack not initialized' };
      }
      return correctnessStack.evaluate(artifact, options);
    },

    // Shutdown
    async close() {
      if (correctnessStack) {
        await correctnessStack.shutdown();
      }
      await graphService.close();
    }
  };
}

export default { createHealthcareStack };
