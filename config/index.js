// config/index.js
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config();

const env = process.env.NODE_ENV || 'development';

// Load environment-specific config
let envConfig = {};
try {
  const envConfigModule = await import(`./${env}.js`);
  envConfig = envConfigModule.default || envConfigModule;
} catch (error) {
  console.warn(`Could not load ${env}.js config, using defaults`);
}

// Base configuration
const defaultMetadataSnapshotCollections = [
  'metadata_objects',
  'metadata_fields',
  'metadata_flows',
  'metadata_code',
  'metadata_ui',
  'metadata_security',
  'metadata_record_types',
  'metadata_global_value_sets',
  'object_relationships',
  'dependencies'
];

const baseConfig = {
  env,
  port: parseInt(process.env.PORT) || 3000,
  websocketPort: parseInt(process.env.WEBSOCKET_PORT) || 3001,
  host: process.env.HOST || 'localhost',
  
  // JWT Configuration
  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    algorithm: 'HS256'
  },
  
  // Redis Configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || '',
    url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
    db: parseInt(process.env.REDIS_DB) || 0,
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'servient:',
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3
  },
  
  // ArangoDB Configuration
  arango: {
    url: process.env.ARANGODB_URL || process.env.ARANGO_URL || 'http://localhost:8529',
    database: process.env.ARANGODB_DATABASE || process.env.ARANGO_DATABASE || 'servient',
    username: process.env.ARANGODB_USERNAME || process.env.ARANGO_USERNAME || 'root',
    password: process.env.ARANGODB_PASSWORD || process.env.ARANGO_PASSWORD || '',
    auth: {
      username: process.env.ARANGODB_USERNAME || process.env.ARANGO_USERNAME || 'root',
      password: process.env.ARANGODB_PASSWORD || process.env.ARANGO_PASSWORD || ''
    },
    baseCollections: [
      'sessions',
      'analytics',
      'generated_code',
      'salesforce_metadata',
      'request_logs',
      'error_logs',
      'ir_plans'  // IR Plan storage for workflow transformation
    ]
  },
  
  // Salesforce Configuration
  salesforce: {
    loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
    username: process.env.SF_USERNAME || '',
    password: process.env.SF_PASSWORD || '',
    clientId: process.env.SF_CLIENT_ID || '',
    clientSecret: process.env.SF_CLIENT_SECRET || '',
    apiVersion: process.env.SF_API_VERSION || '59.0'
  },
  
  // MCP Configuration
  mcp: {
    serverName: process.env.MCP_SERVER_NAME || 'servient-mcp',
    serverVersion: process.env.MCP_SERVER_VERSION || '1.0.0',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || process.env.DEFAULT_MODEL_CLAUDE || 'claude-3-5-sonnet-20240620',
    maxTokens: parseInt(process.env.MCP_MAX_TOKENS) || 4000,
    temperature: parseFloat(process.env.MCP_TEMPERATURE) || 0.7,
    poolSize: parseInt(process.env.MCP_POOL_SIZE) || 5,
    maxPoolSize: parseInt(process.env.MCP_MAX_POOL_SIZE) || 10,
    connectionTimeout: parseInt(process.env.MCP_CONNECTION_TIMEOUT) || 30000
  },
  
  // LLM configuration defaults
  llm: {
    defaultProvider: process.env.LLM_PROVIDER || 'ANTHROPIC',
    defaultTemperature: parseFloat(process.env.LLM_TEMPERATURE || '0.7'),
    defaultMaxTokens: parseInt(process.env.LLM_MAX_TOKENS || '4000', 10),
    defaultTimeout: parseInt(process.env.LLM_TIMEOUT || '90000', 10),
    retryAttempts: parseInt(process.env.LLM_RETRY_ATTEMPTS || '3', 10)
  },
  
  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'logs/servient.log',
    maxFiles: parseInt(process.env.LOG_MAX_FILES) || 5,
    maxSize: process.env.LOG_MAX_SIZE || '10m',
    format: process.env.LOG_FORMAT || 'json'
  },
  
  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    skipSuccessfulRequests: false,
    skipFailedRequests: false
  },
  
  // WebSocket Configuration
  websocket: {
    heartbeatInterval: parseInt(process.env.WS_HEARTBEAT_INTERVAL) || 30000,
    maxConnections: parseInt(process.env.WS_MAX_CONNECTIONS) || 1000,
    compression: process.env.WS_COMPRESSION !== 'false',
    maxPayload: parseInt(process.env.WS_MAX_PAYLOAD) || 1024 * 1024 // 1MB
  },
  
  // Health Check Configuration
  healthCheck: {
    interval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000,
    timeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT) || 5000,
    retries: parseInt(process.env.HEALTH_CHECK_RETRIES) || 3
  },
  
  // Analytics Configuration
  analytics: {
    retentionDays: parseInt(process.env.ANALYTICS_RETENTION_DAYS) || 30,
    batchSize: parseInt(process.env.ANALYTICS_BATCH_SIZE) || 100,
    aggregationInterval: parseInt(process.env.ANALYTICS_AGGREGATION_INTERVAL) || 300000 // 5 minutes
  },
  
  // CORS Configuration
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    credentials: process.env.CORS_CREDENTIALS !== 'false',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-ID', 'X-Request-ID']
  },
  
  // Multi-Org Configuration
  multiOrg: {
    enabled: process.env.MULTI_ORG_ENABLED !== 'false',
    maxOrgs: parseInt(process.env.MAX_ORGS) || 100,
    isolation: process.env.ORG_ISOLATION || 'strict' // strict, loose
  },

  // Metadata Ingestion Configuration
  metadataIngestion: {
    defaultOrgId: process.env.DEFAULT_ORG_ID || 'cscsw-full',
    detectionInterval: parseInt(process.env.METADATA_DETECTION_INTERVAL) || 86400000, // 24 hours
    enabled: process.env.METADATA_INGESTION_ENABLED !== 'false'
  },
  
  // Dedicated metadata snapshot storage (daily refresh)
  metadataSnapshots: {
    enabled: process.env.METADATA_SNAPSHOTS_ENABLED !== 'false',
    connection: {
      url: process.env.METADATA_ARANGODB_URL || process.env.ARANGODB_URL || process.env.ARANGO_URL || 'http://localhost:8529',
      database: process.env.METADATA_ARANGODB_DATABASE || 'servient_metadata_snapshots',
      username: process.env.METADATA_ARANGODB_USERNAME || process.env.ARANGODB_USERNAME || process.env.ARANGO_USERNAME || 'root',
      password: process.env.METADATA_ARANGODB_PASSWORD || process.env.ARANGODB_PASSWORD || process.env.ARANGO_PASSWORD || '',
      auth: {
        username: process.env.METADATA_ARANGODB_USERNAME || process.env.ARANGODB_USERNAME || process.env.ARANGO_USERNAME || 'root',
        password: process.env.METADATA_ARANGODB_PASSWORD || process.env.ARANGODB_PASSWORD || process.env.ARANGO_PASSWORD || ''
      },
      baseCollections: [...defaultMetadataSnapshotCollections]
    }
  },

  // Security Configuration
  security: {
    sessionSecret: process.env.SESSION_SECRET || 'your-session-secret-change-this',
    cookieSecure: process.env.NODE_ENV === 'production',
    cookieMaxAge: parseInt(process.env.COOKIE_MAX_AGE) || 86400000, // 24 hours
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS) || 12
  }
};

// Deep merge with environment-specific config
const config = {
  ...baseConfig,
  ...envConfig,
  // Deep merge specific nested configs
  redis: {
    ...baseConfig.redis,
    ...(envConfig.redis || {})
  },
  arango: {
    ...baseConfig.arango,
    ...(envConfig.arango || {})
  },
  mcp: {
    ...baseConfig.mcp,
    ...(envConfig.mcp || {})
  },
  logging: {
    ...baseConfig.logging,
    ...(envConfig.logging || {})
  },
  llm: {
    ...baseConfig.llm,
    ...(envConfig.llm || {})
  },
  healthCheck: {
    ...baseConfig.healthCheck,
    ...(envConfig.healthCheck || {})
  },
  cors: {
    ...baseConfig.cors,
    ...(envConfig.cors || {})
  },
  rateLimit: {
    ...baseConfig.rateLimit,
    ...(envConfig.rateLimit || {})
  },

  metadataSnapshots: {
    ...baseConfig.metadataSnapshots,
    ...(envConfig.metadataSnapshots || {}),
    connection: {
      ...baseConfig.metadataSnapshots.connection,
      ...(envConfig.metadataSnapshots?.connection || {})
    }
  }
};

// Validate required configuration
const requiredEnvVars = [
  'ANTHROPIC_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

export default config;
