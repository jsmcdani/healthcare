/**
 * BaseAdapter - Abstract base class for ground truth source adapters
 *
 * Adapters query external authoritative sources (terminologies, drug databases,
 * guidelines) and return standardized responses for correctness validation.
 */

import { Logger } from '../../../../utils/logger.js';

/**
 * Standard query result structure
 */
export class QueryResult {
  constructor(options = {}) {
    this.found = options.found ?? false;
    this.data = options.data ?? null;
    this.source = options.source ?? null;
    this.version = options.version ?? null;
    this.queriedAt = options.queriedAt ?? new Date().toISOString();
    this.confidence = options.confidence ?? (options.found ? 1.0 : 0.0);
    this.cacheHit = options.cacheHit ?? false;
    this.latencyMs = options.latencyMs ?? 0;
    this.error = options.error ?? null;
  }

  static found(data, options = {}) {
    return new QueryResult({ found: true, data, ...options });
  }

  static notFound(options = {}) {
    return new QueryResult({ found: false, ...options });
  }

  static error(error, options = {}) {
    return new QueryResult({
      found: false,
      error: typeof error === 'string' ? error : error.message,
      ...options
    });
  }
}

/**
 * Abstract base adapter for ground truth sources
 */
export class BaseAdapter {
  constructor(config) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter is abstract and cannot be instantiated directly');
    }

    this.config = config;
    this.sourceId = config.sourceId;
    this.sourceName = config.sourceName;
    this.sourceVersion = config.sourceVersion;
    this.logger = new Logger(`Adapter:${config.sourceId}`);
    this.cache = new Map();
    this.cacheEnabled = config.cachePolicy?.enabled ?? true;
    this.cacheTTL = config.cachePolicy?.ttlSeconds ?? 3600;
    this.timeout = config.timeout ?? 30000;
    this.queryCount = 0;
    this.errorCount = 0;
    this.lastError = null;
  }

  /**
   * Initialize the adapter connection
   * Override in subclasses for connection setup
   */
  async initialize() {
    this.logger.info('Initializing adapter', { sourceId: this.sourceId });
    return true;
  }

  /**
   * Check if the source is healthy
   * Override in subclasses for health checks
   */
  async healthCheck() {
    return {
      healthy: true,
      sourceId: this.sourceId,
      checkedAt: new Date().toISOString(),
      latencyMs: 0
    };
  }

  /**
   * Query the source - must be implemented by subclasses
   * @param {string} queryType - Type of query (e.g., 'validate_code', 'lookup')
   * @param {object} params - Query parameters
   * @returns {Promise<QueryResult>}
   */
  async query(queryType, params) {
    throw new Error('query() must be implemented by subclass');
  }

  /**
   * Validate a code exists in the terminology
   * @param {string} code - The code to validate
   * @param {string} system - The code system (e.g., 'ICD-10', 'SNOMED')
   * @returns {Promise<QueryResult>}
   */
  async validateCode(code, system) {
    return this.query('validate_code', { code, system });
  }

  /**
   * Lookup detailed information for a code
   * @param {string} code - The code to lookup
   * @param {string} system - The code system
   * @returns {Promise<QueryResult>}
   */
  async lookupCode(code, system) {
    return this.query('lookup', { code, system });
  }

  /**
   * Search for codes by description
   * @param {string} text - Search text
   * @param {string} system - The code system
   * @param {number} limit - Maximum results
   * @returns {Promise<QueryResult>}
   */
  async searchCodes(text, system, limit = 10) {
    return this.query('search', { text, system, limit });
  }

  /**
   * Execute query with caching, timeout, and error handling
   */
  async executeWithWrapper(queryType, params, queryFn) {
    const startTime = Date.now();
    const cacheKey = this.buildCacheKey(queryType, params);

    // Check cache first
    if (this.cacheEnabled) {
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.logger.debug('Cache hit', { queryType, cacheKey });
        return new QueryResult({
          ...cached,
          cacheHit: true,
          latencyMs: Date.now() - startTime
        });
      }
    }

    // Execute query with timeout
    try {
      const result = await Promise.race([
        queryFn(),
        this.createTimeout()
      ]);

      this.queryCount++;
      const latencyMs = Date.now() - startTime;

      const queryResult = result instanceof QueryResult
        ? result
        : QueryResult.found(result, {
            source: this.sourceId,
            version: this.sourceVersion,
            latencyMs
          });

      // Cache successful results
      if (this.cacheEnabled && queryResult.found) {
        this.setInCache(cacheKey, queryResult);
      }

      return queryResult;

    } catch (error) {
      this.errorCount++;
      this.lastError = {
        message: error.message,
        timestamp: new Date().toISOString()
      };

      this.logger.error('Query failed', {
        queryType,
        params,
        error: error.message
      });

      return QueryResult.error(error, {
        source: this.sourceId,
        latencyMs: Date.now() - startTime
      });
    }
  }

  /**
   * Build a cache key from query parameters
   */
  buildCacheKey(queryType, params) {
    return `${this.sourceId}:${queryType}:${JSON.stringify(params)}`;
  }

  /**
   * Get from cache if not expired
   */
  getFromCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.cacheTTL * 1000) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Store in cache
   */
  setInCache(key, result) {
    this.cache.set(key, {
      result,
      timestamp: Date.now()
    });
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Create a timeout promise
   */
  createTimeout() {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Query timeout after ${this.timeout}ms`));
      }, this.timeout);
    });
  }

  /**
   * Get adapter statistics
   */
  getStats() {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      sourceVersion: this.sourceVersion,
      queryCount: this.queryCount,
      errorCount: this.errorCount,
      cacheSize: this.cache.size,
      lastError: this.lastError
    };
  }

  /**
   * Shutdown the adapter
   */
  async shutdown() {
    this.clearCache();
    this.logger.info('Adapter shutdown', { sourceId: this.sourceId });
  }
}

export default BaseAdapter;
