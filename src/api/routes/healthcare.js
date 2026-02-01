/**
 * Healthcare API Routes
 * Exposes healthcare intelligence capabilities via REST API
 *
 * Core endpoints for:
 * - Patient data analysis
 * - PHI protection and compliance
 * - Clinical decision support
 * - Healthcare graph queries
 */

import express from 'express';
import { createHealthcareStack } from '../../healthcare/index.js';
import { DecisionArtifact } from '../../healthcare/reasoning/DecisionArtifact.js';
import { Logger } from '../../utils/logger.js';

const router = express.Router();
const logger = new Logger('HealthcareAPI');

// Healthcare stack instance (initialized on first request or via init endpoint)
let healthcareStack = null;

/**
 * Initialize the healthcare stack
 */
async function ensureStackInitialized(options = {}) {
  if (!healthcareStack) {
    healthcareStack = await createHealthcareStack({
      initializeGraph: options.initializeGraph !== false,
      llmService: options.llmService,
      cache: options.cache,
      ...options
    });
    logger.info('Healthcare stack initialized');
  } else if (options.llmService && !healthcareStack.orchestrator?.llmService) {
    // Update LLM service if not set
    healthcareStack.orchestrator.llmService = options.llmService;
    healthcareStack.recipeEngine.setLLMService(options.llmService);
  }
  return healthcareStack;
}

/**
 * POST /api/healthcare/chat
 * Natural language chat endpoint - uses ReAct loop
 * This is the main AI assistant endpoint
 */
router.post('/chat', async (req, res) => {
  try {
    const { query, context = {} } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    // Get LLM service from app context
    const llmService = req.app.get('llmService');
    const cache = req.app.get('cache');

    const stack = await ensureStackInitialized({ llmService, cache });

    const response = await stack.chat(query, {
      ...context,
      orgId: context.orgId || req.headers['x-org-id'],
      userId: context.userId || req.headers['x-user-id']
    });

    res.json(response);

  } catch (error) {
    logger.error('Healthcare chat error:', error);
    res.status(500).json({
      success: false,
      type: 'error',
      summary: error.message,
      markdown: `## Error\n\n${error.message}`
    });
  }
});

/**
 * POST /api/healthcare/init
 * Initialize the healthcare stack
 */
router.post('/init', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    res.json({
      success: true,
      message: 'Healthcare stack initialized',
      stats: {
        policyPacks: stack.policyEngine.getLoadedPacks().length,
        knowledgeStats: stack.knowledgeEngine.getStats(),
        recipePacks: stack.recipeEngine.getLoadedPacks().length
      }
    });
  } catch (error) {
    logger.error('Failed to initialize healthcare stack:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/task
 * Process a healthcare task through the intent router
 */
router.post('/task', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const { task, context } = req.body;

    if (!task || !task.type) {
      return res.status(400).json({
        success: false,
        error: 'Task with type is required'
      });
    }

    const result = await stack.processTask(task, context || {});

    res.json({
      success: result.success,
      intentMode: result.routing?.intentMode,
      recipe: result.routing?.recipe?.name,
      decision: result.decision,
      execution: result.execution ? {
        status: result.execution.status,
        duration: result.execution.duration,
        outputs: result.execution.outputs
      } : null
    });

  } catch (error) {
    logger.error('Task processing failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/intent/route
 * Route a task to determine intent mode and recipe
 */
router.post('/intent/route', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const { task, context } = req.body;

    const routing = await stack.intentRouter.route(task, context || {});

    res.json({
      success: routing.success,
      intentMode: routing.intentMode,
      recipe: routing.recipe?.name,
      routingPath: routing.routingContext?.routingPath,
      policyTrace: routing.routingContext?.policyTrace
    });

  } catch (error) {
    logger.error('Intent routing failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/policy/evaluate
 * Evaluate policies for a task
 */
router.post('/policy/evaluate', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const { task, context } = req.body;

    const modeResult = await stack.policyEngine.determineIntentMode(task, context || {});
    const validation = await stack.policyEngine.validateOperation(task, context || {});
    const overrides = await stack.policyEngine.getOverrides(context || {});

    res.json({
      intentMode: modeResult,
      validation,
      overrides
    });

  } catch (error) {
    logger.error('Policy evaluation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/knowledge/query
 * Query knowledge base
 */
router.post('/knowledge/query', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const { taskType, context } = req.body;

    const knowledge = await stack.knowledgeEngine.getRelevantKnowledge(
      taskType || 'general',
      context || {}
    );

    res.json({
      count: knowledge.length,
      knowledge: knowledge.map(k => ({
        key: k.key,
        category: k.category,
        type: k.type,
        relevance: k.relevance,
        source: k.source
      }))
    });

  } catch (error) {
    logger.error('Knowledge query failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/phi/detect
 * Detect PHI in field names
 */
router.post('/phi/detect', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const { fieldNames } = req.body;

    if (!Array.isArray(fieldNames)) {
      return res.status(400).json({
        success: false,
        error: 'fieldNames array is required'
      });
    }

    const results = fieldNames.map(fieldName => ({
      fieldName,
      ...stack.knowledgeEngine.detectPHI(fieldName)
    }));

    const phiFields = results.filter(r => r.isPHI);

    res.json({
      total: results.length,
      phiCount: phiFields.length,
      results,
      phiFields
    });

  } catch (error) {
    logger.error('PHI detection failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/intent/modes
 * Get available intent modes
 */
router.get('/intent/modes', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const { IntentModes, getModesByPriority } = await import('../../healthcare/intent/IntentModeRegistry.js');

    const modes = getModesByPriority().map(mode => ({
      id: mode.id,
      name: mode.name,
      description: mode.description,
      priority: mode.priority,
      constraints: mode.constraints,
      allowedRecipes: mode.allowedRecipes
    }));

    res.json({
      count: modes.length,
      modes
    });

  } catch (error) {
    logger.error('Failed to get intent modes:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/policy/packs
 * Get loaded policy packs
 */
router.get('/policy/packs', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const packs = stack.policyEngine.getLoadedPacks();

    res.json({
      count: packs.length,
      packs
    });

  } catch (error) {
    logger.error('Failed to get policy packs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/knowledge/stats
 * Get knowledge engine statistics
 */
router.get('/knowledge/stats', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const stats = stack.knowledgeEngine.getStats();

    res.json(stats);

  } catch (error) {
    logger.error('Failed to get knowledge stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/clinical-hours
 * Check if currently in clinical hours
 */
router.get('/clinical-hours', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const isWithinClinicalHours = stack.knowledgeEngine.isWithinClinicalHours();
    const config = stack.knowledgeEngine.getClinicalHoursConfig();

    res.json({
      isWithinClinicalHours,
      currentTime: new Date().toISOString(),
      config: config?.standard
    });

  } catch (error) {
    logger.error('Failed to check clinical hours:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/graph/query
 * Execute a graph query (when graph is available)
 */
router.post('/graph/query', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    if (!stack.graphService?.initialized) {
      return res.status(503).json({
        success: false,
        error: 'Graph service not available'
      });
    }

    const results = await stack.graphService.client.query(query);

    res.json({
      success: true,
      count: results.length,
      results
    });

  } catch (error) {
    logger.error('Graph query failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/graph/stats
 * Get graph statistics
 */
router.get('/graph/stats', async (req, res) => {
  try {
    const stack = await ensureStackInitialized();

    if (!stack.graphService?.initialized) {
      return res.status(503).json({
        success: false,
        error: 'Graph service not available'
      });
    }

    const stats = await stack.graphService.getStats();

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    logger.error('Failed to get graph stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
