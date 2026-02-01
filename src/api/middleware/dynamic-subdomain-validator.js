// api/middleware/dynamic-subdomain-validator.js
import { Logger } from '../../utils/logger.js';
import { detectEnvironment } from '../../../config/environments.js';

const logger = new Logger('SubdomainValidator');

/**
 * Dynamic subdomain validation middleware
 * Validates organization subdomains and loads org context
 */
export const dynamicSubdomainValidator = (options = {}) => {
  // Only /health truly doesn't need org context
  const pathsWithoutOrgContext = ['/health'];

  // Healthcare mode bypass
  const healthcareMode = process.env.HEALTHCARE_MODE === 'true';

  return async (req, res, next) => {
    try {
      // HEALTHCARE MODE: Skip all org validation
      if (healthcareMode) {
        req.orgContext = { orgId: 'healthcare', orgName: 'Healthcare Platform' };
        return next();
      }

      // CRITICAL: If x-org-id header is present, skip subdomain validation
      // This allows API calls with explicit org ID to bypass subdomain requirement
      const explicitOrgId = req.headers['x-org-id'];
      if (explicitOrgId) {
        logger.debug('x-org-id header present, skipping subdomain validation', {
          orgId: explicitOrgId,
          path: req.path
        });
        // Let org-context.js middleware handle the org loading
        return next();
      }

      // Skip org loading ONLY for paths that truly don't need it (health check)
      if (pathsWithoutOrgContext.includes(req.path)) {
        logger.debug('Health check path, skipping org loading', {
          path: req.path
        });
        return next();
      }

      // Detect environment based on request
      const envConfig = detectEnvironment(req);
      const host = envConfig.getHost(req);

      logger.debug('Environment detected', {
        environment: envConfig.name,
        host,
        description: envConfig.description
      });

      // Extract subdomain using environment-specific logic
      const subdomain = envConfig.extractSubdomain(host);
      let orgContext = null;

      // Attach environment config to request for other middleware
      req.envConfig = envConfig;

      // Load organization from database
      if (req.app.locals.store && subdomain) {
        try {
          const orgs = await req.app.locals.store.find('organizations', {
            subdomain: subdomain
          });

          if (orgs && orgs.length > 0) {
            orgContext = orgs[0];
            logger.debug('Organization found', {
              subdomain,
              orgName: orgContext.org_name,
              environment: envConfig.name
            });
          } else {
            logger.warn('Organization not found, using default', {
              subdomain,
              defaultOrg: envConfig.defaultOrg,
              environment: envConfig.name
            });

            // Try to load default organization
            if (subdomain !== envConfig.defaultOrg) {
              const defaultOrgs = await req.app.locals.store.find('organizations', {
                subdomain: envConfig.defaultOrg
              });

              if (defaultOrgs && defaultOrgs.length > 0) {
                orgContext = defaultOrgs[0];
                logger.info('Using default organization', {
                  defaultOrg: envConfig.defaultOrg,
                  environment: envConfig.name
                });
              }
            }
          }
        } catch (dbError) {
          logger.error('Database error loading organization', dbError);
        }
      }

      // If no org found, this is a critical error - org context is required
      if (!orgContext) {
        logger.error('Organization not found in database', {
          subdomain,
          environment: envConfig.name,
          defaultOrg: envConfig.defaultOrg
        });

        return res.status(404).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Organization Not Found</title></head>
          <body>
            <h1>Organization Not Found</h1>
            <p>Subdomain: <strong>${subdomain}</strong></p>
            <p>This organization does not exist in the system.</p>
            <p>Contact your administrator to set up this organization.</p>
          </body>
          </html>
        `);
      }

      // Attach context to request
      req.orgContext = orgContext;
      req.orgId = orgContext._key;
      req.subdomain = subdomain;

      // Add to response locals for templates
      res.locals.orgContext = orgContext;
      res.locals.subdomain = subdomain;
      res.locals.envConfig = envConfig;

      logger.debug('Subdomain validation complete', {
        environment: envConfig.name,
        host,
        subdomain,
        orgId: req.orgId,
        hasOrgContext: !!orgContext
      });

      next();

    } catch (error) {
      logger.error('Subdomain validation failed', error);

      // NO FALLBACKS - return error
      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head><title>System Error</title></head>
        <body>
          <h1>System Error</h1>
          <p>Failed to validate organization context.</p>
          <p>Error: ${error.message}</p>
          <p>Contact your administrator.</p>
        </body>
        </html>
      `);
    }
  };
};

export default dynamicSubdomainValidator;