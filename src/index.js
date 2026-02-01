// src/index.js - Main Application Entry Point - UPDATED
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { Logger } from './utils/logger.js';
import { AppError } from './utils/errors.js';

// Core Services
import { ServientOrchestrator } from './core/ServientOrchestrator.js';
import { ValidationService } from './services/ValidationService.js';
import { LLMService } from './services/LLMService.js';
import { PromptService } from './services/promptService.js';
import { MetadataService } from './services/MetadataService.js';
import { MetadataIngestionService } from './services/MetadataIngestionService.js';
import { PlatformCacheIngestionService } from './services/PlatformCacheIngestionService.js';
// import { LogIngestionService } from './services/LogIngestionService.js'; // File doesn't exist
// import { DbLogTriageService } from './services/DbLogTriageService.js'; // File doesn't exist
import { MetadataInspectionsService } from './services/MetadataInspectionService.js';
import { RecordOperationsService } from './services/RecordOperationsService.js';
// import { WebSearchService } from './services/WebSearchService.js'; // File is empty
import { BusinessIntelligenceService } from './services/BusinessIntelligenceService.js';
import { WorkflowOrchestrationService } from './services/WorkflowOrchestrationService.js';
import { GitHubIntegrationService } from './services/GitHubIntegrationService.js';
import { ApprovalService } from './services/ApprovalService.js';
import { WorkflowDiscoveryService } from './services/WorkflowDiscoveryService.js';
import { LabelMismatchService } from './services/LabelMismatchService.js';

// Audit Service
import { initAuditService } from './services/AuditService.js';

// API Routes
import { routes } from './api/routes.js';
import { promptTestingRoutes } from './api/promptTestingRoutes.js';

// Security Middleware
import dynamicSubdomainValidator from './api/middleware/dynamic-subdomain-validator.js';
import authRequired from './api/middleware/auth-required.js';
import { requireRole, monitoringAccess, filterApps } from './api/middleware/role-based-access.js';
import loginRoutes from './api/routes/dynamic-login.js';

// Configuration
import config from '../config/index.js';

const logger = new Logger('ServientApp');

class ServientApp {
  constructor() {
    this.app = express();
    this.orchestrator = null;
    this.server = null;
    this.config = null;
  }

  async initialize() {
    try {
      logger.info('Initializing Servient Platform');

      // Load configuration
      this.config = config;
      
      // Setup Express middleware
      this.setupMiddleware();

      // Initialize orchestrator (and all services)
      await this.initializeOrchestrator();

      // Setup API routes
      await this.setupRoutes();

      // Setup error handling
      this.setupErrorHandling();

      logger.info('Servient Platform initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Servient Platform:', error);
      throw error;
    }
  }

  setupMiddleware() {
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-hashes'", "https://cdn.jsdelivr.net"],
          scriptSrcAttr: ["'self'", "'unsafe-inline'", "'unsafe-hashes'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"]
        }
      }
    }));
    this.app.use(cors({
      origin: this.config.cors?.origin || '*',
      credentials: true
    }));
    this.app.use(rateLimit({
      windowMs: 15 * 60 * 1000,
      max: this.config.rateLimit?.maxRequests || 10000,
      message: 'Too many requests from this IP, please try again later.',
      skip: (req) => {
        // Skip rate limiting for localhost in development
        return process.env.NODE_ENV === 'development' && 
               (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1');
      }
    }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    this.app.use(cookieParser());

    // Security Middleware Integration
    // 1. Subdomain validation first (sets req.orgContext)
    this.app.use(dynamicSubdomainValidator({
      allowDirectIP: true,
      cacheTimeout: 300000
    }));

    // 2. Dynamic login routes (must come before auth enforcement)
    this.app.use(loginRoutes);

    // 3. Authentication enforcement - Environment-aware
    const isDevelopment = process.env.NODE_ENV === 'development';
    const requireAuthInDev = process.env.REQUIRE_AUTH_IN_DEV === 'true';

    if (isDevelopment && !requireAuthInDev) {
      // DEV MODE: Skip authentication for fast iteration
      logger.warn('🔓 DEV MODE: Authentication DISABLED for fast development iteration');
      logger.warn('   Set REQUIRE_AUTH_IN_DEV=true to enable auth in development');

      this.app.use(async (req, res, next) => {
        // Inject fake admin user for API calls that need user context
        if (!req.user) {
          // Try to get org from registry, otherwise leave unset (will be set by later middleware)
          let defaultOrgId = null;
          try {
            // Check if orchestrator has org registry service
            if (this.orchestrator?.orgRegistryService) {
              const orgs = await this.orchestrator.orgRegistryService.getAllOrganizations();
              if (orgs && orgs.length > 0) {
                defaultOrgId = orgs[0].orgId || orgs[0].salesforceOrgId;
              }
            }
          } catch (e) {
            // Ignore - org will be set by later request context
          }

          req.user = {
            id: 'dev-user',
            email: 'dev@localhost',
            name: 'Dev User',
            role: 'platform_admin',
            org_id: defaultOrgId, // Load from registry or null
            permissions: ['*']
          };
        }
        next();
      });
    } else {
      // PROD MODE (or DEV with auth enabled): Zero-Trust authentication
      logger.info('🔒 Authentication ENABLED - Zero-trust security mode');

      this.app.use(authRequired({
        publicPaths: ['/login', '/api/auth/login', '/health', '/api/health', '/favicon.ico', '/public'],
        loginRedirect: '/login'
      }));
    }

    // 4. Serve static files AFTER authentication (protects all static content)
    this.app.use(express.static('public'));

    // 5. App filtering based on organization features
    this.app.use(filterApps());

    this.app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        orgId: req.orgId,
        userId: req.user?.email
      });
      next();
    });
  }

  async initializeOrchestrator() {
    logger.info('Initializing ServientOrchestrator');
    this.orchestrator = new ServientOrchestrator(this.config);
    await this.orchestrator.initialize();
    
    // Inject orchestrator and its services into app.locals for middleware access
    this.app.locals.orchestrator = this.orchestrator;
    this.app.locals.store = this.orchestrator.store;
    this.app.locals.cache = this.orchestrator.cache;
    this.app.locals.batchAnalytics = this.orchestrator.batchAnalytics;
    this.app.locals.sessionManager = this.orchestrator.sessionManager;

    // Initialize AuditService with database connection
    if (this.orchestrator.arango?.db) {
      await initAuditService(this.orchestrator.arango.db);
      logger.info('AuditService initialized for session and audit logging');
    } else {
      logger.warn('AuditService not initialized - database not available');
    }

    logger.info('ServientOrchestrator initialized with all services and injected into app.locals');
  }

  async setupRoutes() {
    logger.info('Setting up API routes');

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development'
      });
    });

    // Base API info
    this.app.get('/api', (req, res) => {
      res.json({
        name: 'Servient Platform API',
        version: '1.0.0',
        description: 'Multi-Org Salesforce Intelligence Platform'
      });
    });

    // Import and apply org context middleware for /api routes
    const { orgContext } = await import('./api/middleware/org-context.js');
    
    // Mount all API routes under /api with orgContext
    this.app.use('/api', orgContext({ required: false })); // Set required:false for development
    this.app.use('/api/prompt-testing', promptTestingRoutes);
    this.app.use('/api', routes(this.orchestrator, this.orchestrator.eventSystem));

    // System-wide endpoints
    this.app.get('/api/system/status', async (req, res, next) => {
      try {
        const systemStatus = {
          platform: 'Servient',
          status: 'operational',
          timestamp: new Date().toISOString(),
          services: this.orchestrator.getServiceStatus(),
          activeServices: await this.orchestrator.getActiveServices(),
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          version: process.env.npm_package_version || '1.0.0'
        };
        res.json({ success: true, data: systemStatus });
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/api/system/services', (req, res) => {
      const services = this.orchestrator.getActiveServices();
      res.json({
        success: true,
        data: {
          activeServices: services,
          serviceCount: services.length
        }
      });
    });

    // Protected routes requiring specific roles
    // Monitoring routes - platform admin only
    this.app.use(['/grafana', '/prometheus', '/alertmanager', '/loki'], monitoringAccess());

    // Admin routes - platform admin and admin roles
    this.app.use('/admin', requireRole(['platform_admin', 'admin']));
    this.app.use('/api/admin', requireRole('platform_admin'));

    logger.info('API routes configured successfully');
  }

  setupErrorHandling() {
    // 404 handler
    this.app.use('*', (req, res) => {
      // API requests get JSON
      if (req.path.startsWith('/api/')) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `API endpoint ${req.method} ${req.originalUrl} not found`
          },
          timestamp: new Date().toISOString()
        });
      }

      // Browser requests get HTML 404 page
      res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>404 - Page Not Found</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .error-container {
              background: white;
              padding: 3rem;
              border-radius: 12px;
              box-shadow: 0 4px 20px rgba(0,0,0,0.1);
              text-align: center;
              max-width: 500px;
            }
            h1 { color: #e74c3c; margin: 0 0 1rem 0; font-size: 4rem; }
            h2 { color: #333; margin: 0 0 1rem 0; }
            p { color: #666; margin: 0 0 2rem 0; }
            a {
              display: inline-block;
              padding: 0.75rem 2rem;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 6px;
              transition: background 0.3s;
            }
            a:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="error-container">
            <h1>404</h1>
            <h2>Page Not Found</h2>
            <p>The page <code>${req.originalUrl}</code> does not exist.</p>
            <a href="/">Go to Dashboard</a>
          </div>
        </body>
        </html>
      `);
    });

    // Global error handler
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      const isDev = process.env.NODE_ENV === 'development';
      res.status(err.status || 500).json({
        success: true,
        error: {
          code: err.code || 'INTERNAL_ERROR',
          message: err.message || 'An unexpected error occurred',
          type: err.name || 'Internal Server Error'
        },
        ...(isDev && { stack: err.stack }),
        timestamp: new Date().toISOString()
      });
    });

    // Unhandled rejections & exceptions
    process.on('unhandledRejection', reason => logger.error('UnhandledRejection:', reason));
    process.on('uncaughtException', err => { logger.error('UncaughtException:', err); process.exit(1); });
  }

  async start() {
    const port = this.config.port || process.env.PORT || 3001;
    const host = this.config.host || '0.0.0.0';
    this.server = this.app.listen(port, host, async () => {
      logger.info(`Servient Platform started on ${host}:${port}`);
      
      // Initialize WebSocket server
      await this.initializeWebSocketServer();
      
      this.logIngestionStatus(); // UPDATED method name
    });
    this.setupGracefulShutdown();
  }

  async initializeWebSocketServer() {
    try {
      logger.info('Initializing WebSocket server');
      
      const { ServientWebSocketServer } = await import('./api/websocket-server.js');
      const webSocketConfig = {
        jwtSecret: this.config.jwt.secret,
        port: this.config.port || process.env.PORT || 3001
      };
      
      this.webSocketServer = new ServientWebSocketServer(webSocketConfig);
      this.webSocketServer.initialize(this.server);
      
      // Make WebSocket server available to orchestrator
      this.orchestrator.webSocketServer = this.webSocketServer;
      this.app.locals.webSocketServer = this.webSocketServer;
      
      logger.info('WebSocket server initialized and attached');
    } catch (error) {
      logger.error('Failed to initialize WebSocket server:', error);
    }
  }

  async logIngestionStatus() { // UPDATED to include Platform Cache
    try {
      // Log Metadata Ingestion Status
      const metadataStatus = await this.orchestrator.getMetadataIngestionStatus();
      logger.info('Metadata Ingestion Status:', {
        totalCustomers: metadataStatus.multiOrgMetrics?.totalCustomers,
        totalOrgs: metadataStatus.multiOrgMetrics?.totalOrgs,
        lastDetectionRun: metadataStatus.autoDetection?.lastDetectionRun
      });

      // Log Platform Cache Ingestion Status
      const platformCacheStatus = this.orchestrator.getPlatformCacheIngestionStatus();
      if (platformCacheStatus) {
        logger.info('Platform Cache Ingestion Status:', {
          activeOrgs: platformCacheStatus.activeOrgs,
          totalProcessed: platformCacheStatus.totalProcessed,
          cacheHitRate: platformCacheStatus.cacheHitRate || 'N/A',
          pollingEnabled: platformCacheStatus.pollingEnabled || false
        });
      }

    } catch (err) {
      logger.warn('Could not retrieve ingestion status:', err.message);
    }
  }

  setupGracefulShutdown() {
    const shutdown = async sig => {
      logger.info(`Received ${sig}, shutting down…`);
      
      // Close WebSocket server first
      if (this.webSocketServer) {
        await this.webSocketServer.shutdown();
      }
      
      this.server.close(() => logger.info('HTTP server closed'));
      await this.orchestrator.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// Main entry
async function main() {
  try {
    const app = new ServientApp();
    await app.initialize();
    await app.start();
    return app;
  } catch (err) {
    console.error('Failed to start Servient Platform:', err);
    console.error('Stack trace:', err.stack);
    process.exit(1);
  }
}

// Always call main when this file is run directly
console.log('File being executed:', process.argv[1]);
console.log('Import meta URL:', import.meta.url);
main();

export { ServientApp, main };
export default ServientApp;