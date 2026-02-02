/**
 * Healthcare Cache Management Tools
 *
 * Cache management specific to the healthcare platform.
 */

export const healthcareCacheTools = [
  {
    name: 'list_caches',
    description: 'List all healthcare caches and their status (size, hit rates, last cleared)',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async (orchestrator, input) => {
      const caches = [];

      // Redis cache info
      if (orchestrator?.redisClient) {
        try {
          const info = await orchestrator.redisClient.info('memory');
          const dbSize = await orchestrator.redisClient.dbSize();
          caches.push({
            name: 'redis',
            type: 'primary',
            status: 'connected',
            keys: dbSize,
            memoryInfo: info.split('\n').slice(0, 5).join(', ')
          });
        } catch (e) {
          caches.push({ name: 'redis', status: 'error', error: e.message });
        }
      } else {
        caches.push({ name: 'redis', status: 'not configured' });
      }

      // In-memory caches from orchestrator
      if (orchestrator?.cache) {
        caches.push({
          name: 'orchestrator.cache',
          type: 'in-memory',
          status: 'available',
          size: orchestrator.cache.size || 'unknown'
        });
      }

      // Knowledge engine cache
      if (orchestrator?.knowledgeEngine?.cache) {
        caches.push({
          name: 'knowledge-engine',
          type: 'in-memory',
          status: 'available'
        });
      }

      // Policy engine cache
      if (orchestrator?.policyEngine?.cache) {
        caches.push({
          name: 'policy-engine',
          type: 'in-memory',
          status: 'available'
        });
      }

      return {
        success: true,
        cacheCount: caches.length,
        caches
      };
    }
  },

  {
    name: 'clear_cache',
    description: 'Clear a specific cache or all caches. Use with caution - may impact performance temporarily.',
    input_schema: {
      type: 'object',
      properties: {
        cacheName: {
          type: 'string',
          description: 'Cache to clear: "redis", "knowledge", "policy", "all"',
          enum: ['redis', 'knowledge', 'policy', 'all']
        },
        pattern: {
          type: 'string',
          description: 'Optional: Redis key pattern to clear (e.g., "healthcare:*"). Only for redis cache.'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to execute cache clear'
        }
      },
      required: ['cacheName', 'confirm']
    },
    handler: async (orchestrator, input) => {
      if (!input.confirm) {
        return {
          success: false,
          error: 'Confirmation required. Set confirm: true to clear cache.'
        };
      }

      const results = [];
      const cacheName = input.cacheName;

      // Clear Redis
      if (cacheName === 'redis' || cacheName === 'all') {
        if (orchestrator?.redisClient) {
          try {
            if (input.pattern) {
              // Clear by pattern
              const keys = await orchestrator.redisClient.keys(input.pattern);
              if (keys.length > 0) {
                await orchestrator.redisClient.del(...keys);
                results.push({ cache: 'redis', cleared: keys.length, pattern: input.pattern });
              } else {
                results.push({ cache: 'redis', cleared: 0, pattern: input.pattern, note: 'No matching keys' });
              }
            } else {
              // Clear all (healthcare keys only for safety)
              const keys = await orchestrator.redisClient.keys('healthcare:*');
              if (keys.length > 0) {
                await orchestrator.redisClient.del(...keys);
              }
              results.push({ cache: 'redis', cleared: keys.length, pattern: 'healthcare:*' });
            }
          } catch (e) {
            results.push({ cache: 'redis', error: e.message });
          }
        } else {
          results.push({ cache: 'redis', skipped: 'not configured' });
        }
      }

      // Clear knowledge engine cache
      if (cacheName === 'knowledge' || cacheName === 'all') {
        if (orchestrator?.knowledgeEngine?.clearCache) {
          orchestrator.knowledgeEngine.clearCache();
          results.push({ cache: 'knowledge-engine', cleared: true });
        } else if (orchestrator?.knowledgeEngine?.cache) {
          orchestrator.knowledgeEngine.cache.clear?.();
          results.push({ cache: 'knowledge-engine', cleared: true });
        } else {
          results.push({ cache: 'knowledge-engine', skipped: 'not available' });
        }
      }

      // Clear policy engine cache
      if (cacheName === 'policy' || cacheName === 'all') {
        if (orchestrator?.policyEngine?.clearCache) {
          orchestrator.policyEngine.clearCache();
          results.push({ cache: 'policy-engine', cleared: true });
        } else if (orchestrator?.policyEngine?.cache) {
          orchestrator.policyEngine.cache.clear?.();
          results.push({ cache: 'policy-engine', cleared: true });
        } else {
          results.push({ cache: 'policy-engine', skipped: 'not available' });
        }
      }

      return {
        success: true,
        action: 'cache_cleared',
        results
      };
    }
  },

  {
    name: 'get_cache_stats',
    description: 'Get detailed statistics for a specific cache including hit/miss rates if available',
    input_schema: {
      type: 'object',
      properties: {
        cacheName: {
          type: 'string',
          description: 'Cache to get stats for: "redis"',
          enum: ['redis']
        }
      },
      required: ['cacheName']
    },
    handler: async (orchestrator, input) => {
      if (input.cacheName === 'redis') {
        if (!orchestrator?.redisClient) {
          return { success: false, error: 'Redis not configured' };
        }

        try {
          const info = await orchestrator.redisClient.info();
          const dbSize = await orchestrator.redisClient.dbSize();

          // Parse relevant stats
          const lines = info.split('\n');
          const stats = {};
          for (const line of lines) {
            if (line.includes(':')) {
              const [key, value] = line.split(':');
              if (['used_memory_human', 'connected_clients', 'total_commands_processed',
                   'keyspace_hits', 'keyspace_misses', 'uptime_in_seconds'].includes(key.trim())) {
                stats[key.trim()] = value.trim();
              }
            }
          }

          // Calculate hit rate
          const hits = parseInt(stats.keyspace_hits) || 0;
          const misses = parseInt(stats.keyspace_misses) || 0;
          const hitRate = hits + misses > 0 ? ((hits / (hits + misses)) * 100).toFixed(2) + '%' : 'N/A';

          return {
            success: true,
            cache: 'redis',
            totalKeys: dbSize,
            hitRate,
            stats
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      return { success: false, error: 'Unknown cache: ' + input.cacheName };
    }
  },

  {
    name: 'get_llm_cache_stats',
    description: 'Get LLM response cache statistics including hit rate, size, and cost savings',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async (orchestrator, input) => {
      // Get stats from the admin agent's pool
      const adminAgent = orchestrator?.healthcareAdminAgent;
      if (adminAgent?.pool) {
        const stats = adminAgent.pool.getStats();
        return {
          success: true,
          cache: 'llm-response',
          enabled: stats.cacheEnabled,
          size: stats.cacheSize,
          hits: stats.cacheHits,
          misses: stats.cacheMisses,
          hitRate: stats.cacheHitRate,
          usingRedis: stats.usingRedis,
          estimatedSavings: `${stats.cacheHits} API calls saved`
        };
      }

      return {
        success: false,
        error: 'LLM pool not available'
      };
    }
  },

  {
    name: 'clear_llm_cache',
    description: 'Clear the LLM response cache. Use when cached responses are stale or you want fresh AI responses.',
    input_schema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be true to clear the LLM cache'
        }
      },
      required: ['confirm']
    },
    handler: async (orchestrator, input) => {
      if (!input.confirm) {
        return {
          success: false,
          error: 'Confirmation required. Set confirm: true to clear LLM cache.'
        };
      }

      const adminAgent = orchestrator?.healthcareAdminAgent;
      if (adminAgent?.pool?.clearCache) {
        await adminAgent.pool.clearCache();
        return {
          success: true,
          action: 'llm_cache_cleared',
          message: 'LLM response cache has been cleared. Future queries will make fresh API calls.'
        };
      }

      return {
        success: false,
        error: 'LLM pool not available'
      };
    }
  },

  {
    name: 'warm_cache',
    description: 'Pre-warm caches with commonly accessed data to improve performance',
    input_schema: {
      type: 'object',
      properties: {
        cacheType: {
          type: 'string',
          description: 'Type of cache to warm: "knowledge", "policy"',
          enum: ['knowledge', 'policy']
        }
      },
      required: ['cacheType']
    },
    handler: async (orchestrator, input) => {
      const results = [];

      if (input.cacheType === 'knowledge') {
        // Pre-load common knowledge queries
        if (orchestrator?.knowledgeEngine) {
          try {
            // Trigger loading of common knowledge categories
            await orchestrator.knowledgeEngine.getRelevantKnowledge?.('phi_detection', {});
            await orchestrator.knowledgeEngine.getRelevantKnowledge?.('clinical_hours', {});
            await orchestrator.knowledgeEngine.getRelevantKnowledge?.('drug_interactions', {});
            results.push({ cache: 'knowledge', warmed: true, categories: ['phi_detection', 'clinical_hours', 'drug_interactions'] });
          } catch (e) {
            results.push({ cache: 'knowledge', error: e.message });
          }
        } else {
          results.push({ cache: 'knowledge', skipped: 'not available' });
        }
      }

      if (input.cacheType === 'policy') {
        // Pre-load policy packs
        if (orchestrator?.policyEngine) {
          try {
            const packs = orchestrator.policyEngine.getLoadedPacks?.() || [];
            results.push({ cache: 'policy', warmed: true, packsLoaded: packs.length });
          } catch (e) {
            results.push({ cache: 'policy', error: e.message });
          }
        } else {
          results.push({ cache: 'policy', skipped: 'not available' });
        }
      }

      return {
        success: true,
        action: 'cache_warmed',
        results
      };
    }
  }
];

export default healthcareCacheTools;
