// config/development.js
export default {
  // Development-specific overrides
  logging: {
    level: 'debug',
    format: 'simple'
  },
  
  // More permissive CORS for development
  cors: {
    origin: true,
    credentials: true
  },
  
  // Relaxed rate limiting for development
  rateLimit: {
    windowMs: 60000, // 1 minute
    maxRequests: 1000
  },
  
  // Development Redis settings
  redis: {
    retryDelayOnFailover: 50,
    maxRetriesPerRequest: 1
  },
  
  // Shorter timeouts for faster development cycles
  mcp: {
    connectionTimeout: 10000,
    poolSize: 2,
    maxPoolSize: 3
  },
  
  // More frequent health checks in development
  healthCheck: {
    interval: 10000,
    timeout: 3000
  },
  
  // Enable debug features
  debug: {
    enabled: true,
    mockSalesforce: process.env.MOCK_SALESFORCE === 'true',
    verboseLogging: true
  }
};