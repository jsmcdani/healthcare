// config/production.js
export default {
  // Production-specific overrides
  logging: {
    level: 'warn',
    format: 'json'
  },
  
  // Strict security settings
  security: {
    cookieSecure: true,
    cookieHttpOnly: true,
    cookieSameSite: 'strict'
  },
  
  // Production CORS settings
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : false,
    credentials: true
  },
  
  // Production rate limiting
  rateLimit: {
    windowMs: 900000, // 15 minutes
    maxRequests: 100,
    standardHeaders: true,
    legacyHeaders: false
  },
  
  // Production Redis settings
  redis: {
    retryDelayOnFailover: 200,
    maxRetriesPerRequest: 5,
    lazyConnect: true,
    keepAlive: 30000
  },
  
  // Production MCP settings
  mcp: {
    poolSize: 5,
    maxPoolSize: 10,
    connectionTimeout: 30000,
    requestTimeout: 60000
  },
  
  // Production health check settings
  healthCheck: {
    interval: 30000,
    timeout: 5000,
    retries: 3
  },
  
  // Production analytics
  analytics: {
    retentionDays: 90,
    batchSize: 500,
    aggregationInterval: 60000 // 1 minute
  },
  
  // Performance optimizations
  performance: {
    compression: true,
    cacheHeaders: true,
    etag: true,
    trustProxy: true
  }
};