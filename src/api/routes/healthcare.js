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
import { HealthcareAdminAgent } from '../../healthcare/admin/HealthcareAdminAgent.js';
import { HealthcareUserService } from '../../healthcare/auth/HealthcareUserService.js';
import { CosmosGremlinClient } from '../../database/CosmosGremlinClient.js';
import { Logger } from '../../utils/logger.js';
import { getNaturalLanguageService } from '../../healthcare/nls/index.js';

const router = express.Router();
const logger = new Logger('HealthcareAPI');

// Module-level orchestrator reference (set when routes are mounted)
let moduleOrchestrator = null;

/**
 * Get orchestrator from module variable, router, or app.locals
 */
function getOrchestrator(req) {
  return moduleOrchestrator || router.orchestrator || req?.app?.locals?.orchestrator;
}

// Healthcare stack instance (initialized on first request or via init endpoint)
let healthcareStack = null;

// Healthcare user service (initialized when Cosmos is available)
let healthcareUserService = null;

// Cosmos client for healthcare auth (separate from main stack)
let cosmosClient = null;

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

// ============================================================
// HEALTHCARE NLS (Natural Language Service) ROUTES
// ============================================================

let nlsService = null;

/**
 * Initialize NLS service with orchestrator for LLM fallback
 */
async function ensureNLSInitialized(orchestrator) {
  if (!nlsService) {
    nlsService = getNaturalLanguageService();
    await nlsService.initialize({
      orchestrator,
      cache: orchestrator?.cache
    });
    logger.info('Healthcare NLS initialized', {
      llmFallbackEnabled: !!orchestrator
    });
  }
  return nlsService;
}

/**
 * POST /api/healthcare/nls/parse
 * Parse natural language input to detect intent
 *
 * Body: { text: string, context?: { orgId?, userId?, clinicalMode? } }
 * Returns: IntentParseEnvelope with intent, parameters, confidence
 */
router.post('/nls/parse', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    const nls = await ensureNLSInitialized(orchestrator);

    const { text, context = {} } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'text is required'
      });
    }

    const result = await nls.parseIntent({
      rawText: text,
      context: {
        orgId: context.orgId || req.headers['x-org-id'] || 'default',
        userId: context.userId || req.headers['x-user-id'],
        clinicalMode: context.clinicalMode,
        ...context
      }
    });

    res.json({
      success: true,
      envelope: result,
      // Convenience fields
      intentId: result.payload?.intentId,
      confidence: result.payload?.parseConfidence,
      confidenceLevel: result.payload?.trace?.confidenceLevel,
      confidenceModel: result.payload?.trace?.confidenceModel,
      penalties: result.payload?.trace?.penalties,
      boosts: result.payload?.trace?.boosts,
      canProceed: result.payload?.trace?.canProceed,
      safetyFlag: result.payload?.trace?.safetyFlag,
      requiresClarification: result.payload?.requiresClarification,
      parameters: result.payload?.parameters,
      parser: result.payload?.trace?.parserUsed,
      llmInvoked: result.payload?.trace?.llmInvoked
    });

  } catch (error) {
    logger.error('NLS parse failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/nls/confirm
 * Confirm an intent after clarification
 *
 * Body: { parseEnvelopeId, confirmedIntentId, confirmedParameters }
 */
router.post('/nls/confirm', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    const nls = await ensureNLSInitialized(orchestrator);

    const { parseEnvelopeId, confirmedIntentId, confirmedParameters = [] } = req.body;

    if (!parseEnvelopeId || !confirmedIntentId) {
      return res.status(400).json({
        success: false,
        error: 'parseEnvelopeId and confirmedIntentId are required'
      });
    }

    // Build confirmation envelope
    const { createUserConfirm } = await import('../../healthcare/nls/contracts/zod/IntentConfirmEnvelope.js');
    const confirmation = createUserConfirm({
      parseEnvelopeId,
      confirmedIntentId,
      confirmedParameters: confirmedParameters.map(p => ({
        name: p.name,
        value: p.value,
        userModified: p.userModified || false
      }))
    });

    const result = await nls.confirmIntent(confirmation);

    res.json({
      success: result.confirmed,
      ...result
    });

  } catch (error) {
    logger.error('NLS confirm failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/nls/intents
 * Get available healthcare intents
 */
router.get('/nls/intents', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    const nls = await ensureNLSInitialized(orchestrator);

    const intents = nls.getAvailableIntents();

    res.json({
      success: true,
      count: intents.length,
      intents
    });

  } catch (error) {
    logger.error('NLS intents failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/nls/help
 * Get help text for intents
 */
router.get('/nls/help', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    const nls = await ensureNLSInitialized(orchestrator);

    const intentId = req.query.intent;
    const help = nls.getHelpText(intentId || null);

    res.json({
      success: true,
      help
    });

  } catch (error) {
    logger.error('NLS help failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/nls/status
 * Get NLS service status
 */
router.get('/nls/status', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);

    res.json({
      success: true,
      initialized: !!nlsService?.initialized,
      llmFallbackEnabled: !!(nlsService?.llmParser),
      cacheEnabled: nlsService?.config?.cacheEnabled,
      ruleConfidenceThreshold: nlsService?.config?.ruleConfidenceThreshold
    });

  } catch (error) {
    logger.error('NLS status failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/nls/confidence/model
 * Get the NLS confidence model information
 */
router.get('/nls/confidence/model', async (req, res) => {
  try {
    const { getNLSConfidenceModelInfo } = await import('../../healthcare/nls/NLSConfidenceIntegration.js');
    const modelInfo = getNLSConfidenceModelInfo();

    if (!modelInfo) {
      return res.status(503).json({
        success: false,
        error: 'NLS confidence model not loaded'
      });
    }

    res.json({
      success: true,
      model: modelInfo
    });

  } catch (error) {
    logger.error('NLS confidence model info failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/nls/confidence/explain
 * Explain how confidence would be calculated for a parse context
 *
 * Body: { matchType, rawConfidence, queryLength, hasAmbiguity, entityCompleteness, missingRequired }
 */
router.post('/nls/confidence/explain', async (req, res) => {
  try {
    const { explainNLSConfidence } = await import('../../healthcare/nls/NLSConfidenceIntegration.js');
    const explanation = explainNLSConfidence(req.body);

    res.json({
      success: true,
      explanation
    });

  } catch (error) {
    logger.error('NLS confidence explanation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// HEALTHCARE ADMIN AGENT ROUTES
// ============================================================

let healthcareAdminAgent = null;

/**
 * Initialize the healthcare admin agent
 */
async function ensureAdminAgentInitialized(orchestrator) {
  if (!orchestrator) {
    throw new Error('Orchestrator not available. Server may still be initializing.');
  }
  if (!healthcareAdminAgent) {
    healthcareAdminAgent = new HealthcareAdminAgent(orchestrator);
    await healthcareAdminAgent.initialize();
    logger.info('Healthcare Admin Agent initialized');
  }
  return healthcareAdminAgent;
}

/**
 * GET /api/healthcare/admin/status
 * Get admin agent status
 */
router.get('/admin/status', async (req, res) => {
  try {
    res.json({
      success: true,
      initialized: !!healthcareAdminAgent,
      poolConnected: healthcareAdminAgent?.poolDatabaseConnected || false,
      activeConversations: healthcareAdminAgent?.activeConversations?.size || 0
    });
  } catch (error) {
    logger.error('Failed to get admin status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/admin/init
 * Initialize the healthcare admin agent
 */
router.post('/admin/init', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    const agent = await ensureAdminAgentInitialized(orchestrator);

    res.json({
      success: true,
      message: 'Healthcare Admin Agent initialized',
      initialized: true
    });
  } catch (error) {
    logger.error('Failed to initialize admin agent:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/admin/command
 * Process a natural language admin command
 */
router.post('/admin/command', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    const agent = await ensureAdminAgentInitialized(orchestrator);

    const { message, conversationId } = req.body;
    const userId = req.headers['x-user-id'] || 'anonymous';
    const userRole = req.headers['x-user-role'] || 'user';
    const orgId = req.headers['x-org-id'];

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    const result = await agent.processCommand(message, {
      conversationId,
      userId,
      role: userRole,
      orgId
    });

    res.json(result);

  } catch (error) {
    logger.error('Admin command failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/admin/tools
 * Get available admin tools (respects RBAC)
 */
router.get('/admin/tools', async (req, res) => {
  try {
    const orchestrator = getOrchestrator(req);
    const agent = await ensureAdminAgentInitialized(orchestrator);

    const userRole = req.headers['x-user-role'] || 'user';
    const tools = await agent.loadToolsForRole(userRole);

    // Group tools by category
    const toolCategories = {
      healthcare: [],
      governance: [],
      system: [],
      other: []
    };

    for (const tool of tools) {
      if (tool.name.includes('phi') || tool.name.includes('clinical') ||
          tool.name.includes('knowledge') || tool.name.includes('gremlin') ||
          tool.name.includes('policy') || tool.name.includes('intent')) {
        toolCategories.healthcare.push(tool.name);
      } else if (tool.name.includes('audit') || tool.name.includes('compliance') ||
                 tool.name.includes('user') || tool.name.includes('session')) {
        toolCategories.governance.push(tool.name);
      } else if (tool.name.includes('cache') || tool.name.includes('health') ||
                 tool.name.includes('llm') || tool.name.includes('feature')) {
        toolCategories.system.push(tool.name);
      } else {
        toolCategories.other.push(tool.name);
      }
    }

    res.json({
      success: true,
      totalTools: tools.length,
      role: userRole,
      categories: toolCategories,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description?.substring(0, 100)
      }))
    });

  } catch (error) {
    logger.error('Failed to get admin tools:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/admin/schema/visualize
 * Get schema visualization
 */
router.get('/admin/schema/visualize', async (req, res) => {
  try {
    const format = req.query.format || 'mermaid';
    const scope = req.query.scope || 'all';

    const orchestrator = getOrchestrator(req);
    const agent = await ensureAdminAgentInitialized(orchestrator);

    // Call the visualize_schema tool directly
    const { cosmosSchemaTools } = await import('../../healthcare/admin/tools/cosmos-schema-tools.js');
    const visualizeTool = cosmosSchemaTools.find(t => t.name === 'visualize_schema');

    const result = await visualizeTool.handler(orchestrator, {
      format,
      scope,
      includeStats: true
    });

    res.json(result);

  } catch (error) {
    logger.error('Schema visualization failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// HEALTHCARE AUTHENTICATION ROUTES
// ============================================================

/**
 * Ensure Cosmos client and user service are initialized
 * Uses orchestrator's Cosmos client if available, falls back to creating one
 */
async function ensureUserServiceInitialized(req) {
  // Try to get Cosmos client from orchestrator first
  if (!cosmosClient) {
    const orchestrator = getOrchestrator(req);
    if (orchestrator?.cosmosGremlinClient?.initialized) {
      cosmosClient = orchestrator.cosmosGremlinClient;
      logger.info('Using orchestrator Cosmos Gremlin Client for healthcare auth');
    } else {
      // Fallback: create our own client
      try {
        cosmosClient = new CosmosGremlinClient();
        await cosmosClient.initialize();
        logger.info('Cosmos Gremlin Client initialized for healthcare auth (standalone)');
      } catch (error) {
        logger.error('Failed to initialize Cosmos client:', error.message);
        // Don't throw - return null so caller can handle gracefully
        return null;
      }
    }
  }

  // Initialize user service with Cosmos client
  if (!healthcareUserService && cosmosClient?.initialized) {
    healthcareUserService = new HealthcareUserService(cosmosClient);
    logger.info('Healthcare User Service initialized');
  }

  return healthcareUserService;
}

/**
 * POST /api/healthcare/auth/login
 * Authenticate user
 */
router.post('/auth/login', async (req, res) => {
  try {
    const userService = await ensureUserServiceInitialized(req);

    if (!userService) {
      return res.status(503).json({
        success: false,
        error: 'User service not available - Cosmos DB not connected'
      });
    }

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    const result = await userService.authenticate(email, password);

    if (result.success) {
      // Set session cookie
      res.cookie('healthcare_session', result.sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 8 * 60 * 60 * 1000 // 8 hours
      });
    }

    res.json(result);

  } catch (error) {
    logger.error('Login failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/auth/logout
 * Logout user
 */
router.post('/auth/logout', async (req, res) => {
  try {
    const userService = await ensureUserServiceInitialized(req);

    const sessionId = req.cookies?.healthcare_session || req.headers['x-session-id'];

    if (userService && sessionId) {
      userService.logout(sessionId);
    }

    res.clearCookie('healthcare_session');
    res.json({ success: true });

  } catch (error) {
    logger.error('Logout failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/auth/session
 * Validate current session
 */
router.get('/auth/session', async (req, res) => {
  try {
    const userService = await ensureUserServiceInitialized(req);

    if (!userService) {
      return res.status(503).json({
        success: false,
        error: 'User service not available'
      });
    }

    const sessionId = req.cookies?.healthcare_session || req.headers['x-session-id'];

    if (!sessionId) {
      return res.json({ valid: false, error: 'No session' });
    }

    const result = userService.validateSession(sessionId);

    if (result.valid) {
      const persona = userService.getPersona(result.session.role);
      res.json({
        valid: true,
        session: {
          userId: result.session.userId,
          email: result.session.email,
          name: result.session.name,
          role: result.session.role,
          department: result.session.department,
          persona: persona,
          isProvider: userService.isProvider(result.session.role),
          isPatient: userService.isPatient(result.session.role)
        },
        user: {
          id: result.session.userId,
          email: result.session.email,
          name: result.session.name,
          role: result.session.role,
          department: result.session.department
        }
      });
    } else {
      res.json({ valid: false, error: result.error });
    }

  } catch (error) {
    logger.error('Session check failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/auth/access
 * Check if user has access to a page
 */
router.get('/auth/access', async (req, res) => {
  try {
    const userService = await ensureUserServiceInitialized(req);

    if (!userService) {
      return res.status(503).json({
        success: false,
        error: 'User service not available'
      });
    }

    const sessionId = req.cookies?.healthcare_session || req.headers['x-session-id'];
    const page = req.query.page;

    if (!sessionId) {
      return res.json({ hasAccess: false, reason: 'Not authenticated' });
    }

    const sessionResult = userService.validateSession(sessionId);

    if (!sessionResult.valid) {
      return res.json({ hasAccess: false, reason: sessionResult.error });
    }

    const hasAccess = userService.hasAccess(sessionResult.session.role, page);

    res.json({
      hasAccess,
      role: sessionResult.session.role,
      reason: hasAccess ? 'Access granted' : 'Insufficient permissions'
    });

  } catch (error) {
    logger.error('Access check failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/auth/seed
 * Seed demo users (dev only)
 */
router.post('/auth/seed', async (req, res) => {
  try {
    const userService = await ensureUserServiceInitialized(req);

    if (!userService) {
      return res.status(503).json({
        success: false,
        error: 'User service not available - Cosmos DB not connected'
      });
    }

    const created = await userService.seedDemoUsers();

    res.json({
      success: true,
      message: 'Demo users seeded',
      created: created.length,
      users: created
    });

  } catch (error) {
    logger.error('Seed users failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/auth/debug
 * Debug endpoint - check Cosmos and list users (dev only)
 */
router.get('/auth/debug', async (req, res) => {
  try {
    const userService = await ensureUserServiceInitialized(req);

    if (!userService) {
      return res.json({
        success: false,
        cosmosConnected: false,
        error: 'Cosmos not connected'
      });
    }

    // Direct query to check what's in Cosmos
    const allUsers = await userService.cosmos.query(`g.V().hasLabel('HealthcareUser').valueMap(true)`);

    res.json({
      success: true,
      cosmosConnected: true,
      userCount: allUsers.length,
      users: allUsers.map(u => ({
        id: u.id,
        email: u.email?.[0] || u.email,
        name: u.name?.[0] || u.name,
        role: u.role?.[0] || u.role,
        hasPasswordHash: !!(u.passwordHash?.[0] || u.passwordHash)
      }))
    });

  } catch (error) {
    logger.error('Debug endpoint error:', error);
    res.json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

/**
 * GET /api/healthcare/auth/users
 * List all users (admin only)
 */
router.get('/auth/users', async (req, res) => {
  try {
    const userService = await ensureUserServiceInitialized(req);

    if (!userService) {
      return res.status(503).json({
        success: false,
        error: 'User service not available'
      });
    }

    // Check admin access
    const sessionId = req.cookies?.healthcare_session || req.headers['x-session-id'];
    if (sessionId) {
      const sessionResult = userService.validateSession(sessionId);
      if (!sessionResult.valid || sessionResult.session.role !== 'admin') {
        return res.status(403).json({
          success: false,
          error: 'Admin access required'
        });
      }
    }

    const users = await userService.listUsers();

    res.json({
      success: true,
      count: users.length,
      users
    });

  } catch (error) {
    logger.error('List users failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default (orchestrator) => {
  // Store orchestrator at module level so all routes can access it
  moduleOrchestrator = orchestrator;
  router.orchestrator = orchestrator;
  logger.info('Healthcare routes mounted with orchestrator:', orchestrator ? 'provided' : 'null');
  return router;
};
