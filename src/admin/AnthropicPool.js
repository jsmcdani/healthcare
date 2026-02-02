/**
 * AnthropicPool - Rate-limited queue for Anthropic SDK calls
 *
 * Purpose: Provides pooling/queuing for admin agent tool calls
 * - Rate limiting (respects Anthropic API limits)
 * - Request queuing with priority
 * - Automatic retry with exponential backoff
 * - Circuit breaker for failed requests
 */

import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { Logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

export class AnthropicPool extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      // Rate limiting (Anthropic: 50 req/min for tier 1)
      maxRequestsPerMinute: config.maxRequestsPerMinute || 40, // Leave buffer
      maxConcurrent: config.maxConcurrent || 3,

      // Retry configuration
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,

      // Circuit breaker
      circuitBreakerThreshold: config.circuitBreakerThreshold || 5,
      circuitBreakerTimeout: config.circuitBreakerTimeout || 60000,

      // Queue
      queueTimeout: config.queueTimeout || 120000,

      // Response caching
      enableCache: config.enableCache !== false, // Default enabled
      cacheTTL: config.cacheTTL || 300000, // 5 minutes default
      maxCacheSize: config.maxCacheSize || 100, // Max cached responses

      ...config
    };

    this.logger = new Logger('AnthropicPool');

    // Initialize Anthropic client
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 0 // We handle retries ourselves
    });

    // Request tracking
    this.queue = [];
    this.activeRequests = 0;
    this.requestTimestamps = [];

    // Circuit breaker
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    this.circuitOpenUntil = null;

    // Response cache (in-memory, can use Redis if available)
    this.responseCache = new Map();
    this.redisClient = null;

    // Stats
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retriedRequests: 0,
      queuedRequests: 0,
      avgResponseTime: 0,
      circuitBreakerTrips: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }

  /**
   * Set Redis client for distributed caching
   */
  setRedisClient(redisClient) {
    this.redisClient = redisClient;
    this.logger.info('Redis client set for LLM response caching');
  }

  /**
   * Generate cache key from request params
   */
  getCacheKey(params) {
    // Hash the relevant parts of the request (excluding timestamps, etc.)
    const cacheableParams = {
      model: params.model,
      system: params.system,
      messages: params.messages,
      tools: params.tools?.map(t => t.name) // Just tool names, not full schema
    };
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify(cacheableParams))
      .digest('hex')
      .substring(0, 16);
    return `llm:response:${hash}`;
  }

  /**
   * Get cached response
   */
  async getCachedResponse(cacheKey) {
    if (!this.config.enableCache) return null;

    // Try Redis first
    if (this.redisClient) {
      try {
        const cached = await this.redisClient.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (e) {
        this.logger.debug('Redis cache read failed:', e.message);
      }
    }

    // Fall back to in-memory
    const entry = this.responseCache.get(cacheKey);
    if (entry && Date.now() < entry.expiresAt) {
      return entry.response;
    } else if (entry) {
      this.responseCache.delete(cacheKey); // Expired
    }

    return null;
  }

  /**
   * Cache a response
   */
  async cacheResponse(cacheKey, response) {
    if (!this.config.enableCache) return;

    // Try Redis first
    if (this.redisClient) {
      try {
        await this.redisClient.setEx(
          cacheKey,
          Math.floor(this.config.cacheTTL / 1000),
          JSON.stringify(response)
        );
        return;
      } catch (e) {
        this.logger.debug('Redis cache write failed:', e.message);
      }
    }

    // Fall back to in-memory with size limit
    if (this.responseCache.size >= this.config.maxCacheSize) {
      // Remove oldest entry
      const oldestKey = this.responseCache.keys().next().value;
      this.responseCache.delete(oldestKey);
    }

    this.responseCache.set(cacheKey, {
      response,
      expiresAt: Date.now() + this.config.cacheTTL
    });
  }

  /**
   * Clear LLM response cache
   */
  async clearCache() {
    // Clear in-memory
    this.responseCache.clear();

    // Clear Redis
    if (this.redisClient) {
      try {
        const keys = await this.redisClient.keys('llm:response:*');
        if (keys.length > 0) {
          await this.redisClient.del(...keys);
        }
        this.logger.info(`Cleared ${keys.length} cached LLM responses from Redis`);
      } catch (e) {
        this.logger.error('Failed to clear Redis cache:', e.message);
      }
    }

    this.logger.info('LLM response cache cleared');
  }

  /**
   * Queue a request to invoke Anthropic with tool calling
   */
  async invoke(params) {
    // Check cache first (only for cacheable requests)
    const skipCache = params.skipCache || false;
    if (!skipCache && this.config.enableCache) {
      const cacheKey = this.getCacheKey(params);
      const cachedResponse = await this.getCachedResponse(cacheKey);
      if (cachedResponse) {
        this.stats.cacheHits++;
        this.logger.debug('Cache hit', { cacheKey });
        return cachedResponse;
      }
      this.stats.cacheMisses++;
    }

    return new Promise((resolve, reject) => {
      const request = {
        id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        params,
        resolve,
        reject,
        retries: 0,
        enqueuedAt: Date.now(),
        priority: params.priority || 0,
        cacheKey: this.config.enableCache ? this.getCacheKey(params) : null
      };

      this.stats.totalRequests++;
      this.stats.queuedRequests++;

      // Add to queue (higher priority first)
      this.queue.push(request);
      this.queue.sort((a, b) => b.priority - a.priority);

      this.logger.debug('Request queued', {
        requestId: request.id,
        queueLength: this.queue.length,
        activeRequests: this.activeRequests
      });

      // Start processing
      this.processQueue();
    });
  }

  /**
   * Process queued requests with rate limiting
   */
  async processQueue() {
    // Check circuit breaker
    if (this.circuitOpen) {
      if (Date.now() < this.circuitOpenUntil) {
        this.logger.warn('Circuit breaker is open, delaying requests');
        return;
      } else {
        this.logger.info('Circuit breaker timeout expired, attempting to close');
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
      }
    }

    // Check if we can process more requests
    if (this.activeRequests >= this.config.maxConcurrent) {
      return; // Wait for active requests to complete
    }

    if (this.queue.length === 0) {
      return; // Nothing to process
    }

    // Check rate limit
    if (!this.canMakeRequest()) {
      const waitTime = this.getWaitTimeUntilNextSlot();
      this.logger.debug(`Rate limit reached, waiting ${waitTime}ms`);
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }

    // Get next request from queue
    const request = this.queue.shift();
    this.stats.queuedRequests--;

    // Check queue timeout
    const queueTime = Date.now() - request.enqueuedAt;
    if (queueTime > this.config.queueTimeout) {
      this.logger.warn('Request timed out in queue', {
        requestId: request.id,
        queueTime
      });
      request.reject(new Error(`Request timeout after ${queueTime}ms in queue`));
      this.processQueue(); // Process next
      return;
    }

    // Execute request
    this.activeRequests++;
    this.executeRequest(request)
      .then(() => {
        this.activeRequests--;
        this.processQueue(); // Process next
      })
      .catch(() => {
        this.activeRequests--;
        this.processQueue(); // Process next
      });
  }

  /**
   * Execute a single request with retry logic
   */
  async executeRequest(request) {
    const startTime = Date.now();

    try {
      this.logger.debug('Executing request', {
        requestId: request.id,
        attempt: request.retries + 1,
        maxRetries: this.config.maxRetries
      });

      // Track request timing for rate limiting
      this.requestTimestamps.push(Date.now());

      // Call Anthropic API
      const response = await this.client.messages.create(request.params);

      // Success
      const responseTime = Date.now() - startTime;
      this.updateStats('success', responseTime);
      this.consecutiveFailures = 0; // Reset circuit breaker

      // Cache the response (only cache end_turn responses, not tool_use)
      if (request.cacheKey && response.stop_reason === 'end_turn') {
        await this.cacheResponse(request.cacheKey, response);
        this.logger.debug('Response cached', { cacheKey: request.cacheKey });
      }

      this.logger.debug('Request completed successfully', {
        requestId: request.id,
        responseTime,
        stopReason: response.stop_reason
      });

      request.resolve(response);

    } catch (error) {
      // Handle failure
      this.logger.error('Request failed', {
        requestId: request.id,
        attempt: request.retries + 1,
        error: error.message
      });

      // Check if retryable
      const isRetryable = this.isRetryableError(error);
      const canRetry = request.retries < this.config.maxRetries;

      if (isRetryable && canRetry) {
        // Retry with exponential backoff
        request.retries++;
        this.stats.retriedRequests++;

        const delay = this.config.retryDelay * Math.pow(2, request.retries - 1);
        this.logger.info('Retrying request', {
          requestId: request.id,
          attempt: request.retries + 1,
          delay
        });

        setTimeout(() => {
          // Re-queue with priority
          request.priority = 10; // High priority for retries
          this.queue.unshift(request);
          this.stats.queuedRequests++;
          this.processQueue();
        }, delay);

      } else {
        // Final failure
        this.updateStats('failure', Date.now() - startTime);
        this.handleFailure(error);
        request.reject(error);
      }
    }
  }

  /**
   * Check if we can make a request without exceeding rate limits
   */
  canMakeRequest() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Clean old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);

    return this.requestTimestamps.length < this.config.maxRequestsPerMinute;
  }

  /**
   * Get wait time until next rate limit slot
   */
  getWaitTimeUntilNextSlot() {
    if (this.requestTimestamps.length === 0) {
      return 0;
    }

    const oldestTimestamp = this.requestTimestamps[0];
    const oneMinuteLater = oldestTimestamp + 60000;
    const waitTime = Math.max(0, oneMinuteLater - Date.now());

    return waitTime;
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(error) {
    // Rate limit errors
    if (error.status === 429) {
      return true;
    }

    // Server errors
    if (error.status >= 500) {
      return true;
    }

    // Network errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return true;
    }

    return false;
  }

  /**
   * Handle request failure (circuit breaker)
   */
  handleFailure(error) {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      this.logger.error('Circuit breaker opened', {
        consecutiveFailures: this.consecutiveFailures,
        timeout: this.config.circuitBreakerTimeout
      });

      this.circuitOpen = true;
      this.circuitOpenUntil = Date.now() + this.config.circuitBreakerTimeout;
      this.stats.circuitBreakerTrips++;

      this.emit('circuit:open', {
        consecutiveFailures: this.consecutiveFailures,
        reopenAt: this.circuitOpenUntil
      });
    }
  }

  /**
   * Update statistics
   */
  updateStats(result, responseTime) {
    if (result === 'success') {
      this.stats.successfulRequests++;
    } else {
      this.stats.failedRequests++;
    }

    // Update average response time
    const totalRequests = this.stats.successfulRequests + this.stats.failedRequests;
    this.stats.avgResponseTime = (
      (this.stats.avgResponseTime * (totalRequests - 1) + responseTime) /
      totalRequests
    );
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const cacheHitRate = this.stats.cacheHits + this.stats.cacheMisses > 0
      ? ((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100).toFixed(1) + '%'
      : 'N/A';

    return {
      ...this.stats,
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      circuitOpen: this.circuitOpen,
      requestsInLastMinute: this.requestTimestamps.length,
      cacheEnabled: this.config.enableCache,
      cacheSize: this.responseCache.size,
      cacheHitRate,
      usingRedis: !!this.redisClient
    };
  }

  /**
   * Clear the queue (for shutdown)
   */
  async shutdown() {
    this.logger.info('Shutting down AnthropicPool');

    // Reject all queued requests
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      request.reject(new Error('Pool shutdown'));
    }

    // Wait for active requests to complete
    while (this.activeRequests > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.logger.info('AnthropicPool shutdown complete');
  }
}
