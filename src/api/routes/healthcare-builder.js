/**
 * Healthcare Builder Agent API Routes
 *
 * HTTP endpoints for Healthcare Builder Agent
 * Handles commands for building healthcare AI components:
 * - AI Experts with specialized prompts and knowledge packs
 * - Ground truth sources for clinical validation
 * - Assertions for correctness checking
 * - Calibration test cases with gold-standard answers
 * - Healthcare recipes with correctness integration
 * - Policy rules for compliance
 *
 * RBAC Enforcement:
 * - All routes require authenticated user (JWT)
 * - User role determines available tools and data visibility
 * - Org scoping enforced for non-platform_admin users
 */

import express from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();

/**
 * RBAC Middleware - Requires authenticated user with builder-level role
 */
const requireBuilderRole = (allowedRoles = ['platform_admin', 'healthcare_admin', 'healthcare_builder', 'developer']) => {
  return (req, res, next) => {
    try {
      // Get token from various sources
      let token = null;

      // 1. Authorization header (Bearer token)
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }

      // 2. Cookie
      if (!token && req.cookies?.auth_token) {
        token = req.cookies.auth_token;
      }

      if (!token) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required for Healthcare Builder Agent access'
        });
      }

      // Verify JWT
      const jwtSecret = process.env.JWT_SECRET || 'servient_jwt_secret_dev_12345_change_in_production';
      const decoded = jwt.verify(token, jwtSecret);

      // Check role
      const userRole = decoded.role || 'user';
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({
          success: false,
          error: `Access denied: Role '${userRole}' is not authorized for Healthcare Builder Agent`,
          requiredRoles: allowedRoles
        });
      }

      // Attach verified user info to request
      req.verifiedUser = {
        userId: decoded.userId || decoded.sub,
        username: decoded.username || decoded.email,
        email: decoded.email,
        role: userRole,
        orgId: decoded.orgId,
        permissions: decoded.permissions || []
      };

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Token expired - please login again'
        });
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid authentication token'
      });
    }
  };
};

// Apply RBAC middleware to all builder routes (bypass in development)
const isDev = process.env.NODE_ENV !== 'production';
if (!isDev) {
  router.use(requireBuilderRole(['platform_admin', 'healthcare_admin', 'healthcare_builder', 'developer']));
} else {
  // In development, attach mock builder user
  router.use((req, res, next) => {
    req.verifiedUser = {
      userId: 'dev-builder',
      username: 'builder@healthcare.com',
      email: 'builder@healthcare.com',
      role: req.headers['x-role'] || 'healthcare_admin',
      orgId: req.headers['x-org-id'] || null,
      permissions: ['*']
    };
    next();
  });
}

/**
 * POST /api/healthcare/builder/command
 *
 * Send command to Healthcare Builder Agent
 *
 * Request body:
 * {
 *   "message": "Create an AI expert for pediatric dosing verification",
 *   "conversationId": "optional-conv-id"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "response": "I'll create a Pediatric Dosing AI expert...",
 *   "toolsUsed": [{ "name": "create_ai_expert", "input": {...} }],
 *   "conversationId": "builder_conv_..."
 * }
 */
router.post('/command', async (req, res) => {
  try {
    const { message, conversationId } = req.body;
    const verifiedUser = req.verifiedUser;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'message is required'
      });
    }

    const orchestrator = req.app.locals.orchestrator;

    if (!orchestrator || !orchestrator.healthcareBuilderAgent) {
      return res.status(503).json({
        success: false,
        error: 'Healthcare Builder Agent not initialized'
      });
    }

    // Process command with verified user context
    const result = await orchestrator.healthcareBuilderAgent.processCommand(message, {
      conversationId: conversationId,
      userId: verifiedUser.userId,
      username: verifiedUser.username,
      role: verifiedUser.role,
      orgId: verifiedUser.orgId,
      permissions: verifiedUser.permissions,
      sessionId: req.headers['x-session-id'],
      interface: 'http-api'
    });

    return res.json({
      ...result,
      _rbac: {
        userRole: verifiedUser.role,
        orgScoped: verifiedUser.role !== 'platform_admin'
      }
    });

  } catch (error) {
    console.error('Healthcare Builder command failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/healthcare/builder/continue
 *
 * Continue existing conversation
 *
 * Request body:
 * {
 *   "conversationId": "builder_conv_...",
 *   "message": "Now add calibration test cases for this expert"
 * }
 */
router.post('/continue', async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    const verifiedUser = req.verifiedUser;

    if (!conversationId || !message) {
      return res.status(400).json({
        success: false,
        error: 'conversationId and message are required'
      });
    }

    const orchestrator = req.app.locals.orchestrator;

    if (!orchestrator.healthcareBuilderAgent) {
      return res.status(503).json({
        success: false,
        error: 'Healthcare Builder Agent not initialized'
      });
    }

    const result = await orchestrator.healthcareBuilderAgent.continueConversation(
      conversationId,
      message,
      {
        userId: verifiedUser.userId,
        username: verifiedUser.username,
        role: verifiedUser.role,
        orgId: verifiedUser.orgId,
        permissions: verifiedUser.permissions,
        interface: 'http-api'
      }
    );

    return res.json({
      ...result,
      _rbac: {
        userRole: verifiedUser.role,
        orgScoped: verifiedUser.role !== 'platform_admin'
      }
    });

  } catch (error) {
    console.error('Healthcare Builder continue failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/conversation/:conversationId
 *
 * Get conversation history
 */
router.get('/conversation/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params;

    const orchestrator = req.app.locals.orchestrator;

    if (!orchestrator.healthcareBuilderAgent) {
      return res.status(503).json({
        success: false,
        error: 'Healthcare Builder Agent not initialized'
      });
    }

    const conversation = orchestrator.healthcareBuilderAgent.getConversation(conversationId);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversation not found'
      });
    }

    return res.json({
      success: true,
      conversation: {
        id: conversation.id,
        createdAt: conversation.createdAt,
        userId: conversation.userId,
        role: conversation.role,
        messageCount: conversation.messages.length,
        messages: conversation.messages
      }
    });

  } catch (error) {
    console.error('Get conversation failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/status
 *
 * Get Healthcare Builder Agent status
 */
router.get('/status', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator;

    if (!orchestrator.healthcareBuilderAgent) {
      return res.json({
        success: true,
        initialized: false,
        status: 'not-initialized'
      });
    }

    const stats = orchestrator.healthcareBuilderAgent.getStats();

    return res.json({
      success: true,
      initialized: true,
      status: 'ready',
      stats
    });

  } catch (error) {
    console.error('Get builder status failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/tools
 *
 * Get available builder tools for the authenticated user's role
 */
router.get('/tools', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator;
    const verifiedUser = req.verifiedUser;

    if (!orchestrator.healthcareBuilderAgent) {
      return res.status(503).json({
        success: false,
        error: 'Healthcare Builder Agent not initialized'
      });
    }

    // Get tools for user's role
    const roleTools = orchestrator.healthcareBuilderAgent.getToolsForRole(verifiedUser.role);

    // Group by category
    const byCategory = {};
    for (const tool of roleTools) {
      if (!byCategory[tool.category]) {
        byCategory[tool.category] = [];
      }
      byCategory[tool.category].push({
        name: tool.name,
        description: tool.description
      });
    }

    return res.json({
      success: true,
      userRole: verifiedUser.role,
      totalTools: roleTools.length,
      byCategory,
      tools: roleTools,
      _rbac: {
        role: verifiedUser.role,
        orgScoped: verifiedUser.role !== 'platform_admin'
      }
    });

  } catch (error) {
    console.error('Get builder tools failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/experts
 *
 * List AI experts (filtered by org for non-platform_admin)
 */
router.get('/experts', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator;
    const verifiedUser = req.verifiedUser;
    const db = orchestrator.arango?.db;

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      });
    }

    let query = 'FOR e IN ai_experts';
    const filters = [];
    const bindVars = {};

    // Org scoping for non-platform_admin
    if (verifiedUser.role !== 'platform_admin' && verifiedUser.orgId) {
      filters.push('(e.orgId == @orgId OR e.orgId == null)');
      bindVars.orgId = verifiedUser.orgId;
    }

    const { specialty, status } = req.query;
    if (specialty) {
      filters.push('e.specialty == @specialty');
      bindVars.specialty = specialty;
    }
    if (status) {
      filters.push('e.status == @status');
      bindVars.status = status;
    }

    if (filters.length > 0) {
      query += ' FILTER ' + filters.join(' AND ');
    }

    query += ' RETURN e';

    const cursor = await db.query(query, bindVars);
    const experts = await cursor.all();

    return res.json({
      success: true,
      count: experts.length,
      experts: experts.map(e => ({
        expertType: e.expertType,
        displayName: e.displayName,
        specialty: e.specialty,
        status: e.status,
        version: e.version,
        knowledgePackCount: (e.knowledgePackIds || []).length,
        escalationTarget: e.escalationTarget,
        createdAt: e.createdAt
      }))
    });

  } catch (error) {
    console.error('List experts failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/knowledge-packs
 *
 * List knowledge packs (filtered by org for non-platform_admin)
 */
router.get('/knowledge-packs', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator;
    const verifiedUser = req.verifiedUser;
    const db = orchestrator.arango?.db;

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      });
    }

    let query = 'FOR p IN knowledge_packs';
    const filters = [];
    const bindVars = {};

    // Org scoping for non-platform_admin
    if (verifiedUser.role !== 'platform_admin' && verifiedUser.orgId) {
      filters.push('(p.orgId == @orgId OR p.orgId == null)');
      bindVars.orgId = verifiedUser.orgId;
    }

    const { category, specialty, status } = req.query;
    if (category) {
      filters.push('p.category == @category');
      bindVars.category = category;
    }
    if (specialty) {
      filters.push('p.specialty == @specialty');
      bindVars.specialty = specialty;
    }
    if (status) {
      filters.push('p.status == @status');
      bindVars.status = status;
    } else {
      filters.push('p.status == "active"');
    }

    if (filters.length > 0) {
      query += ' FILTER ' + filters.join(' AND ');
    }

    query += ' RETURN p';

    const cursor = await db.query(query, bindVars);
    const packs = await cursor.all();

    return res.json({
      success: true,
      count: packs.length,
      packs: packs.map(p => ({
        packId: p.packId,
        name: p.name,
        category: p.category,
        specialty: p.specialty,
        source: p.source,
        version: p.version,
        status: p.status,
        entryCount: p.entryCount,
        createdAt: p.createdAt
      }))
    });

  } catch (error) {
    console.error('List knowledge packs failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/recipes
 *
 * List healthcare recipes
 */
router.get('/recipes', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator;
    const verifiedUser = req.verifiedUser;
    const db = orchestrator.arango?.db;

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      });
    }

    let query = 'FOR r IN healthcare_recipes';
    const filters = [];
    const bindVars = {};

    // Org scoping
    if (verifiedUser.role !== 'platform_admin' && verifiedUser.orgId) {
      filters.push('(r.orgId == @orgId OR r.orgId == null)');
      bindVars.orgId = verifiedUser.orgId;
    }

    const { taskType, status } = req.query;
    if (taskType) {
      filters.push('r.taskType == @taskType');
      bindVars.taskType = taskType;
    }
    if (status) {
      filters.push('r.status == @status');
      bindVars.status = status;
    }

    if (filters.length > 0) {
      query += ' FILTER ' + filters.join(' AND ');
    }

    query += ' RETURN r';

    const cursor = await db.query(query, bindVars);
    const recipes = await cursor.all();

    return res.json({
      success: true,
      count: recipes.length,
      recipes: recipes.map(r => ({
        recipeName: r.recipeName,
        displayName: r.displayName,
        taskType: r.taskType,
        status: r.status,
        version: r.version,
        stepCount: (r.steps || []).length,
        assertionCount: (r.assertions || []).length,
        createdAt: r.createdAt
      }))
    });

  } catch (error) {
    console.error('List recipes failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/calibration-suites
 *
 * List calibration test suites
 */
router.get('/calibration-suites', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator;
    const verifiedUser = req.verifiedUser;
    const db = orchestrator.arango?.db;

    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Database not available'
      });
    }

    let query = 'FOR s IN calibration_suites';
    const filters = [];
    const bindVars = {};

    if (verifiedUser.role !== 'platform_admin' && verifiedUser.orgId) {
      filters.push('(s.orgId == @orgId OR s.orgId == null)');
      bindVars.orgId = verifiedUser.orgId;
    }

    const { targetExpert, status } = req.query;
    if (targetExpert) {
      filters.push('s.targetExpert == @targetExpert');
      bindVars.targetExpert = targetExpert;
    }
    if (status) {
      filters.push('s.status == @status');
      bindVars.status = status;
    }

    if (filters.length > 0) {
      query += ' FILTER ' + filters.join(' AND ');
    }

    query += ' RETURN s';

    const cursor = await db.query(query, bindVars);
    const suites = await cursor.all();

    return res.json({
      success: true,
      count: suites.length,
      suites: suites.map(s => ({
        suiteId: s.suiteId,
        name: s.name,
        targetExpert: s.targetExpert,
        testCount: s.testCount,
        passingThreshold: s.passingThreshold,
        lastResult: s.lastResult,
        lastRunAt: s.lastRunAt,
        createdAt: s.createdAt
      }))
    });

  } catch (error) {
    console.error('List calibration suites failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/healthcare/builder/ground-truth-sources
 *
 * List ground truth sources
 */
router.get('/ground-truth-sources', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator;
    const db = orchestrator.arango?.db;

    if (!db) {
      // Return standard sources as fallback
      return res.json({
        success: true,
        count: 4,
        sources: [
          { sourceId: 'icd10', name: 'ICD-10-CM', type: 'classification', status: 'available' },
          { sourceId: 'snomed_ct', name: 'SNOMED CT', type: 'terminology', status: 'available' },
          { sourceId: 'rxnorm', name: 'RxNorm', type: 'formulary', status: 'available' },
          { sourceId: 'loinc', name: 'LOINC', type: 'reference', status: 'available' }
        ],
        note: 'Standard sources available for registration'
      });
    }

    const cursor = await db.query('FOR s IN ground_truth_sources RETURN s');
    const sources = await cursor.all();

    return res.json({
      success: true,
      count: sources.length,
      sources: sources.map(s => ({
        sourceId: s.sourceId,
        name: s.name,
        type: s.type,
        version: s.version,
        status: s.status,
        lastValidated: s.lastValidated
      }))
    });

  } catch (error) {
    console.error('List ground truth sources failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
