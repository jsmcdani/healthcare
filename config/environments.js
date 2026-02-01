// config/environments.js
// Environment-specific configurations for middleware behavior

export const environments = {
  development: {
    name: 'development',
    hostPattern: /localhost|127\.0\.0\.1|0\.0\.0\.0/,
    description: 'Local development - npm run dev',

    // Host detection
    getHost: (req) => req.get('Host'),
    getRealIP: (req) => req.ip,

    // Authentication - OPTIONAL IN DEV
    requireAuth: false,  // Skip auth in DEV for faster development
    cookieDomain: null,
    secure: false,
    authRedirect: '/login',

    // Organization handling
    allowDirectIP: true,
    defaultOrg: 'cscsw-full',
    allowSystemAdminLogin: true,  // Allow system admins to login to any org subdomain

    // Subdomain handling
    extractSubdomain: (host) => {
      // For localhost:3001, always use default org
      return 'cscsw-full';
    }
  },

  container: {
    name: 'container',
    hostPattern: /172\.|192\.168\.|host\.docker\.internal|docker\.internal/,
    description: 'Docker container environment',

    // Host detection
    getHost: (req) => req.get('Host'),
    getRealIP: (req) => req.get('X-Real-IP') || req.ip,

    // Authentication
    requireAuth: true,  // Auth required in container testing
    cookieDomain: null,
    secure: false,
    authRedirect: '/login',

    // Organization handling
    allowDirectIP: true,
    defaultOrg: 'cscsw-full',
    allowSystemAdminLogin: true,  // Allow system admins to login to any org subdomain

    // Subdomain handling
    extractSubdomain: (host) => {
      // For container testing, allow subdomain simulation
      if (host.includes('.')) {
        const parts = host.split('.');
        return parts[0] !== 'localhost' ? parts[0] : 'cscsw-full';
      }
      return 'cscsw-full';
    }
  },

  production: {
    name: 'production',
    hostPattern: /agentservient\.com$/,
    description: 'Production - behind Cloudflare/Nginx',

    // Host detection - check proxy headers first
    getHost: (req) => {
      return req.get('X-Forwarded-Host') ||
             req.get('X-Original-Host') ||
             req.get('Host');
    },
    getRealIP: (req) => {
      return req.get('CF-Connecting-IP') ||  // Cloudflare
             req.get('X-Forwarded-For')?.split(',')[0] ||
             req.get('X-Real-IP') ||
             req.ip;
    },

    // Authentication
    requireAuth: true,  // Auth required in production
    cookieDomain: '.agentservient.com',
    secure: true,
    authRedirect: (req, envConfig) => {
      const host = envConfig.getHost(req);
      return `https://${host}/login`;
    },

    // Organization handling
    allowDirectIP: false,
    defaultOrg: 'cscsw-full',
    allowSystemAdminLogin: true,  // Allow system admins to login to any org subdomain

    // Subdomain handling
    extractSubdomain: (host) => {
      // Extract subdomain from cscsw-full.agentservient.com
      const match = host.match(/^([^.]+)\.agentservient\.com$/);
      return match ? match[1] : 'cscsw-full';
    }
  }
};

/**
 * Detect environment based on request
 */
export function detectEnvironment(req) {
  const host = req.get('X-Forwarded-Host') || req.get('Host') || 'localhost';

  // Check each environment pattern
  for (const config of Object.values(environments)) {
    if (config.hostPattern.test(host)) {
      return config;
    }
  }

  // Default to development if no match
  return environments.development;
}

/**
 * Get environment-specific redirect URL
 */
export function getRedirectUrl(req, envConfig, path = '/login') {
  if (typeof envConfig.authRedirect === 'function') {
    return envConfig.authRedirect(req, envConfig);
  }

  return envConfig.authRedirect || path;
}

/**
 * Get environment-specific cookie options
 */
export function getCookieOptions(envConfig, customOptions = {}) {
  const baseOptions = {
    httpOnly: true,
    secure: envConfig.secure,
    // Use 'none' in production to allow cookies in same-domain iframes
    // Requires secure: true (HTTPS) in production
    sameSite: envConfig.secure ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  };

  if (envConfig.cookieDomain) {
    baseOptions.domain = envConfig.cookieDomain;
  }

  return { ...baseOptions, ...customOptions };
}

export default {
  environments,
  detectEnvironment,
  getRedirectUrl,
  getCookieOptions
};