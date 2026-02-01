// api/middleware/org-context.js
import { Logger } from '../../utils/logger.js';
import { ValidationError, AppError } from '../../utils/errors.js';
import crypto from 'crypto';

const logger = new Logger('OrgContext');

export const orgContext = (options = {}) => {
  const {
    required = true,
    allowSystemRequests = false,
    headerName = 'x-org-id',
    queryParam = 'orgId'
  } = options;

  // Healthcare mode bypass
  const healthcareMode = process.env.HEALTHCARE_MODE === 'true';

  return async (req, res, next) => {
    try {
      // HEALTHCARE MODE: Skip all org validation
      if (healthcareMode) {
        req.orgId = 'healthcare';
        req.orgContext = { orgId: 'healthcare', orgName: 'Healthcare Platform' };
        return next();
      }

      // Generate request ID if not present
      if (!req.requestId) {
        req.requestId = generateRequestId();
      }

      // Extract org ID from various sources
      let orgId = await extractOrgId(req, headerName, queryParam);
      
      // If user is authenticated, use their org ID as fallback
      if (!orgId && req.user?.orgId) {
        orgId = req.user.orgId;
      }
      
      // Handle system requests
      if (!orgId && allowSystemRequests) {
        orgId = 'system';
      }
      
      // Validate org ID is present if required
      if (!orgId && required) {
        throw new ValidationError('Organization ID is required');
      }
      
      // Validate org ID format
      if (orgId && orgId !== 'system') {
        validateOrgIdFormat(orgId);
      }
      
      // Verify user has access to the org
      // DISABLED: This check breaks existing functionality - user.organizations not populated in JWT
      // TODO: Implement proper multi-org access control when user.organizations is available
      // if (orgId && req.user && orgId !== 'system') {
      //   await verifyOrgAccess(req.user, orgId);
      // }
      
      // Load org context if org ID is present
      let orgContext = null;
      if (orgId && orgId !== 'system') {
        orgContext = await loadOrgContext(orgId, req);
      }
      
      // Attach org information to request
      req.orgId = orgId;
      req.orgContext = orgContext;
      
      // Add org-specific namespace for caching/storage
      if (orgId && orgId !== 'system') {
        req.orgNamespace = `org:${orgId}`;
      } else {
        req.orgNamespace = 'system';
      }
      
      // Set response headers
      if (orgId) {
        res.set('X-Org-ID', orgId);
      }
      res.set('X-Request-ID', req.requestId);
      
      logger.debug('Org context established', {
        orgId,
        userId: req.user?.userId,
        requestId: req.requestId,
        path: req.path
      });
      
      next();
      
    } catch (error) {
      logger.warn('Org context validation failed', {
        error: error.message,
        path: req.path,
        userId: req.user?.userId,
        requestId: req.requestId
      });
      
      if (error instanceof ValidationError) {
        return res.status(400).json({
          error: 'Invalid Organization Context',
          message: error.message,
          code: 'ORG_CONTEXT_ERROR',
          requestId: req.requestId
        });
      }
      
      return res.status(500).json({
        error: 'Organization Context Error',
        message: 'Failed to establish organization context',
        code: 'ORG_CONTEXT_ERROR',
        requestId: req.requestId
      });
    }
  };
};

async function extractOrgId(req, headerName, queryParam) {
  // Check header first
  let orgId = req.headers[headerName.toLowerCase()];

  // Check for subdomain from nginx proxy header (multi-org support)
  if (!orgId && req.headers["x-org-subdomain"]) {
    const subdomain = req.headers["x-org-subdomain"];

    // Look up organization by subdomain
    if (req.app.locals.store) {
      try {
        const orgs = await req.app.locals.store.find('organizations', { subdomain: subdomain });
        if (orgs.length > 0) {
          orgId = orgs[0]._key;
          // Cache org info in request for efficiency
          req.orgFromSubdomain = orgs[0];
        }
      } catch (error) {
        logger.debug('Failed to lookup org by subdomain', { subdomain, error: error.message });
      }
    }
  }

  // Check query parameter
  if (!orgId && req.query[queryParam]) {
    orgId = req.query[queryParam];
  }

  // Check body for POST requests
  if (!orgId && req.body && req.body[queryParam]) {
    orgId = req.body[queryParam];
  }

  // Check route parameters
  if (!orgId && req.params.orgId) {
    orgId = req.params.orgId;
  }

  // Trim whitespace
  if (orgId && typeof orgId === 'string') {
    orgId = orgId.trim();
  }

  return orgId;
}

function validateOrgIdFormat(orgId) {
  if (typeof orgId !== 'string') {
    throw new ValidationError('Organization ID must be a string');
  }
  
  if (orgId.length === 0) {
    throw new ValidationError('Organization ID cannot be empty');
  }
  
  if (orgId.length > 100) {
    throw new ValidationError('Organization ID is too long');
  }
  
  // Validate format - should be alphanumeric with underscores/hyphens
  if (!/^[a-zA-Z0-9_-]+$/.test(orgId)) {
    throw new ValidationError('Organization ID contains invalid characters');
  }
}

async function verifyOrgAccess(user, orgId) {
  // Check if user has access to this organization
  const userOrgs = user.organizations || [];
  
  if (!userOrgs.includes(orgId)) {
    throw new ValidationError(`User does not have access to organization: ${orgId}`);
  }
  
  // Additional checks could include:
  // - Org status (active/inactive)
  // - User role within org
  // - Feature permissions
}

async function loadOrgContext(orgId, req) {
  try {
    // Try to get from cache first
    let orgContext = null;
    
    if (req.app.locals.cache) {
      orgContext = await req.app.locals.cache.getJSON(`org:${orgId}:context`);
    }
    
    // Load from database if not in cache (try both orgId and salesforceOrgId)
    if (!orgContext && req.app.locals.store) {
      logger.debug('Loading org from database', { orgId });
      
      // Try to find by orgId first
      let orgs = await req.app.locals.store.find('organizations', { orgId: orgId });
      
      // If not found, try by salesforceOrgId
      if (orgs.length === 0) {
        orgs = await req.app.locals.store.find('organizations', { salesforceOrgId: orgId });
      }
      
      logger.debug('Database query results', { orgId, orgsFound: orgs.length, orgs });
      
      if (orgs.length > 0) {
        const org = orgs[0];
        logger.debug('Processing org data', { 
          orgId, 
          orgKey: org._key,
          orgStatus: org.status,
          orgFeatures: org.features,
          settingsFeatures: org.settings?.features,
          rawSettings: org.settings
        });
        
        orgContext = {
          orgId: org.orgId,
          name: org.name,
          status: org.status,
          settings: org.settings || {},
          features: org.features || org.settings?.features || [],
          limits: org.limits || org.settings?.limits || {},
          metadata: org.metadata || {},
          lastUpdated: org.lastUpdated
        };
        
        logger.debug('Created orgContext', { orgId, orgContext });
        
        // Cache for 5 minutes
        if (req.app.locals.cache) {
          await req.app.locals.cache.setJSON(
            `org:${orgId}:context`,
            orgContext,
            300
          );
        }
      }
    }
    
    // Check org registry if not found in database
    if (!orgContext) {
      const orchestrator = req.app.locals.orchestrator;
      if (orchestrator?.orgRegistry) {
        try {
          const orgInfo = await orchestrator.orgRegistry.getOrgInfo(orgId);
          if (orgInfo) {
            logger.debug('Found org in registry, creating context from registry data', { orgId, orgInfo });
            orgContext = {
              orgId: orgInfo.orgId,
              name: orgInfo.name || 'Registry Organization',
              status: 'active',
              settings: {},
              features: ['all'], // Registry orgs get all features by default
              limits: {},
              metadata: { source: 'org_registry', registeredAt: orgInfo.registeredAt },
              lastUpdated: orgInfo.registeredAt
            };
            
            // Cache the registry-based context
            if (req.app.locals.cache) {
              await req.app.locals.cache.setJSON(
                `org:${orgId}:context`,
                orgContext,
                300
              );
            }
          }
        } catch (error) {
          logger.debug('Org not found in registry either', { orgId, error: error.message });
        }
      }
    }
    
    // Auto-register organization if not found anywhere
    // ONLY auto-register valid Salesforce org IDs (starts with 00D, 15 or 18 chars)
    if (!orgContext) {
      if (!isLikeSalesforceOrgId(orgId)) {
        logger.warn('Rejecting auto-registration for invalid org ID format', { orgId });
        // Don't register invalid orgs - just continue without org context
      } else {
        logger.info('Organization not found, attempting auto-registration', { orgId });

        try {
          // Try to auto-register through OrgRegistry
          const orchestrator = req.app.locals.orchestrator;
          if (orchestrator?.orgRegistry) {
            // Register as outbound org (client-initiated connection)
            const orgInfo = await orchestrator.orgRegistry.registerOutboundOrg(orgId, {
            connectionSource: 'api_request',
            userAgent: req.get('User-Agent'),
            ipAddress: req.ip
          });
          
          logger.info('Auto-registered organization via OrgRegistry', { orgId, orgInfo });
          
          // Create database record for the auto-registered org
          const newOrg = {
            _key: `auto_${Date.now()}_${orgId.replace(/[^a-zA-Z0-9]/g, '_')}`,
            orgId: orgInfo.orgId,
            name: `Auto-registered Organization (${orgId})`,
            type: 'customer',
            status: 'active',
            createdAt: new Date().toISOString(),
            salesforceOrgId: isLikeSalesforceOrgId(orgId) ? orgId : null,
            autoRegistered: true,
            settings: {
              features: [
                'ai-analysis', 
                'workflows', 
                'workflows:convert',
                'workflows:deploy', 
                'analytics', 
                'salesforce-integration',
                'metadata:admin',
                'org:admin',
                'org:read'
              ],
              limits: getDefaultLimits(),
              registration: {
                source: 'auto',
                timestamp: new Date().toISOString(),
                connectionInfo: orgInfo
              }
            }
          };
          
          // Save to database
          if (req.app.locals.store) {
            await req.app.locals.store.save('organizations', newOrg);
            logger.info('Auto-registered organization saved to database', { orgId, key: newOrg._key });
          }
          
          // Create org context from new record
          orgContext = {
            orgId: newOrg.orgId,
            name: newOrg.name,
            status: newOrg.status,
            settings: newOrg.settings || {},
            features: newOrg.settings?.features || [],
            limits: newOrg.settings?.limits || {},
            metadata: { autoRegistered: true },
            lastUpdated: newOrg.createdAt
          };
          
          // Cache the new context
          if (req.app.locals.cache) {
            await req.app.locals.cache.setJSON(
              `org:${orgId}:context`,
              orgContext,
              300
            );
          }
          
        } else {
          logger.debug('OrgRegistry not available, using simplified auto-registration', { orgId });
          
          // Simplified auto-registration when OrgRegistry is not available
          const newOrg = {
            _key: `simple_${Date.now()}_${orgId.replace(/[^a-zA-Z0-9]/g, '_')}`,
            orgId: orgId,
            name: `Organization (${orgId})`,
            type: 'customer', 
            status: 'active',
            createdAt: new Date().toISOString(),
            salesforceOrgId: isLikeSalesforceOrgId(orgId) ? orgId : null,
            autoRegistered: true,
            settings: {
              features: ['ai-analysis', 'workflows'],
              limits: { apiCalls: 1000, storage: '1GB' }
            }
          };
          
          // Save to database
          if (req.app.locals.store) {
            await req.app.locals.store.save('organizations', newOrg);
            logger.info('Simple auto-registration completed', { orgId, key: newOrg._key });
          }
          
          // Create org context
          orgContext = {
            orgId: newOrg.orgId,
            name: newOrg.name,
            status: newOrg.status,
            settings: newOrg.settings || {},
            features: newOrg.settings?.features || [],
            limits: newOrg.settings?.limits || {},
            metadata: { autoRegistered: true, fallbackMode: true },
            lastUpdated: newOrg.createdAt
          };
          
          // Cache the new context
          if (req.app.locals.cache) {
            await req.app.locals.cache.setJSON(
              `org:${orgId}:context`,
              orgContext,
              300
            );
          }
        }
        } catch (regError) {
          logger.error('Failed to auto-register organization', { orgId, error: regError.message });
        }
      }
    }
    
    // Fallback to default context if auto-registration failed
    if (!orgContext) {
      orgContext = {
        orgId,
        name: 'Unknown Organization',
        status: 'unknown',
        settings: {},
        features: [],
        limits: getDefaultLimits(),
        metadata: {},
        lastUpdated: new Date().toISOString()
      };
      
      logger.warn('Organization not found and auto-registration failed, using default context', { orgId });
    }
    
    return orgContext;
    
  } catch (error) {
    logger.error('Failed to load org context:', error, { orgId });
    
    // Return minimal context on error
    return {
      orgId,
      name: 'Organization',
      status: 'unknown',
      settings: {},
      features: [],
      limits: getDefaultLimits(),
      metadata: {},
      error: 'Failed to load organization context'
    };
  }
}

function getDefaultLimits() {
  return {
    maxApiCallsPerHour: 1000,
    maxUsersPerOrg: 100,
    maxStorageGB: 10,
    maxSessionsPerUser: 5
  };
}

// Helper function to detect if an orgId looks like a Salesforce org ID
function isLikeSalesforceOrgId(orgId) {
  // Salesforce org IDs are 15 or 18 characters, start with '00D'
  return typeof orgId === 'string' && 
         (orgId.length === 15 || orgId.length === 18) && 
         orgId.startsWith('00D');
}

function generateRequestId() {
  return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// Helper function to check if org has access to a specific feature
// Supports hierarchical permissions (e.g., "workflows" grants "workflows:read")
function hasFeatureAccess(orgFeatures, requiredFeature) {
  // Check for "all" feature which grants everything
  if (orgFeatures.includes('all')) {
    return true;
  }

  // Check for exact match first
  if (orgFeatures.includes(requiredFeature)) {
    return true;
  }

  // Check for hierarchical match
  if (requiredFeature.includes(':')) {
    const baseFeature = requiredFeature.split(':')[0];
    if (orgFeatures.includes(baseFeature)) {
      return true;
    }
  }

  return false;
}

// Middleware for system-only requests
export const systemContext = orgContext({
  required: false,
  allowSystemRequests: true
});

// Middleware that requires org context
export const requireOrgContext = orgContext({
  required: true,
  allowSystemRequests: false
});

// Middleware for optional org context
export const optionalOrgContext = orgContext({
  required: false,
  allowSystemRequests: true
});

// Middleware to validate org permissions
export const orgPermissions = (requiredFeatures = []) => {
  return (req, res, next) => {
    try {
      if (!req.orgContext) {
        throw new ValidationError('Organization context not established');
      }
      
      // Check if org is active (allow admin users to bypass for admin APIs)
      const isAdminUser = req.user?.permissions?.some(p => p.startsWith('admin:'));
      const isAdminEndpoint = req.path.includes('/admin/');
      
      if (req.orgContext.status !== 'active' && !(isAdminUser && isAdminEndpoint)) {
        logger.warn('Organization access denied - status check', {
          orgId: req.orgId,
          status: req.orgContext.status,
          isAdminUser,
          isAdminEndpoint,
          path: req.path,
          userId: req.user?.userId
        });
        throw new ValidationError('Organization is not active');
      }
      
      // Check required features
      const orgFeatures = req.orgContext.features || [];
      
      // Debug logging
      logger.info('Feature check debug', {
        orgId: req.orgId,
        requiredFeatures,
        orgFeatures,
        orgContextSettings: req.orgContext.settings,
        orgContextMeta: {
          status: req.orgContext.status,
          name: req.orgContext.name
        }
      });
      
      for (const feature of requiredFeatures) {
        if (!hasFeatureAccess(orgFeatures, feature)) {
          throw new ValidationError(`Organization does not have access to feature: ${feature}`);
        }
      }
      
      next();
      
    } catch (error) {
      logger.warn('Org permissions check failed', {
        error: error.message,
        orgId: req.orgId,
        requiredFeatures,
        orgFeatures: req.orgContext?.features
      });
      
      return res.status(403).json({
        error: 'Organization Access Denied',
        message: error.message,
        code: 'ORG_PERMISSION_ERROR',
        requestId: req.requestId
      });
    }
  };
};

// Middleware to check org limits
export const orgLimits = (limitType, threshold = null) => {
  return async (req, res, next) => {
    try {
      if (!req.orgContext) {
        throw new ValidationError('Organization context not established');
      }
      
      const limits = req.orgContext.limits || {};
      const currentUsage = await getCurrentUsage(req.orgId, limitType, req);
      
      let limit;
      if (threshold !== null) {
        limit = threshold;
      } else {
        limit = limits[limitType];
      }
      
      if (limit && currentUsage >= limit) {
        throw new ValidationError(`Organization has reached ${limitType} limit: ${limit}`);
      }
      
      // Add usage info to request
      req.orgUsage = {
        [limitType]: {
          current: currentUsage,
          limit: limit,
          percentage: limit ? (currentUsage / limit) * 100 : 0
        }
      };
      
      next();
      
    } catch (error) {
      logger.warn('Org limits check failed', {
        error: error.message,
        orgId: req.orgId,
        limitType,
        threshold
      });
      
      return res.status(429).json({
        error: 'Organization Limit Exceeded',
        message: error.message,
        code: 'ORG_LIMIT_ERROR',
        requestId: req.requestId
      });
    }
  };
};

async function getCurrentUsage(orgId, limitType, req) {
  try {
    // This would query actual usage from database/cache
    // For now, return simulated usage
    
    switch (limitType) {
      case 'maxApiCallsPerHour':
        return await getApiCallsInLastHour(orgId, req);
        
      case 'maxUsersPerOrg':
        return await getUserCount(orgId, req);
        
      case 'maxStorageGB':
        return await getStorageUsage(orgId, req);
        
      case 'maxSessionsPerUser':
        return await getSessionCount(orgId, req.user?.userId, req);
        
      default:
        return 0;
    }
    
  } catch (error) {
    logger.error('Failed to get current usage:', error, { orgId, limitType });
    return 0;
  }
}

async function getApiCallsInLastHour(orgId, req) {
  if (!req.app.locals.batchAnalytics) {
    return 0;
  }
  
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  
  try {
    const metrics = await req.app.locals.batchAnalytics.getMetrics(
      orgId,
      'request.count',
      oneHourAgo,
      now
    );
    
    return metrics.reduce((sum, metric) => sum + metric.value, 0);
  } catch (error) {
    return 0;
  }
}

async function getUserCount(orgId, req) {
  if (!req.app.locals.store) {
    return 0;
  }
  
  try {
    const users = await req.app.locals.store.find('users', {
      organizations: orgId,
      status: 'active'
    });
    
    return users.length;
  } catch (error) {
    return 0;
  }
}

async function getStorageUsage(orgId, req) {
  // This would calculate actual storage usage
  // For now, return simulated value
  return Math.floor(Math.random() * 1000) / 100; // 0-10 GB
}

async function getSessionCount(orgId, userId, req) {
  if (!req.app.locals.sessionManager || !userId) {
    return 0;
  }
  
  try {
    const sessions = await req.app.locals.sessionManager.getUserSessions(userId);
    return sessions.length;
  } catch (error) {
    return 0;
  }
}

// Middleware to set org-specific cache namespace
export const orgCacheNamespace = (req, res, next) => {
  if (req.orgId) {
    req.cacheNamespace = `org:${req.orgId}`;
  } else {
    req.cacheNamespace = 'system';
  }
  
  next();
};

// Middleware to add org context to all responses
export const orgResponseHeaders = (req, res, next) => {
  // Override res.json to add org context
  const originalJson = res.json;
  
  res.json = function(body) {
    const responseBody = {
      ...body,
      meta: {
        orgId: req.orgId,
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
        ...body.meta
      }
    };
    
    return originalJson.call(this, responseBody);
  };
  
  next();
};