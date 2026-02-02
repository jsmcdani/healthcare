/**
 * GroundTruthRegistry - Central registry for authoritative knowledge sources
 *
 * Manages registration, health monitoring, and querying of external ground truth
 * sources like terminology systems, drug databases, clinical guidelines, and
 * reference ranges. These sources anchor correctness assertions to authority.
 */

import { Logger } from '../../../utils/logger.js';
import {
  GroundTruthSourceTypes,
  createGroundTruthSourceEnvelope,
  validateGroundTruthSource
} from './GroundTruthSourceEnvelope.js';
import { TerminologyAdapter } from './adapters/TerminologyAdapter.js';
import { DrugDataAdapter } from './adapters/DrugDataAdapter.js';
import { ReferenceRangeAdapter } from './adapters/ReferenceRangeAdapter.js';

/**
 * Registry status
 */
export const RegistryStatus = {
  INITIALIZING: 'initializing',
  READY: 'ready',
  DEGRADED: 'degraded',
  ERROR: 'error'
};

/**
 * Ground Truth Registry
 */
export class GroundTruthRegistry {
  constructor(options = {}) {
    this.logger = new Logger('GroundTruthRegistry');
    this.sources = new Map();
    this.adapters = new Map();
    this.status = RegistryStatus.INITIALIZING;
    this.healthCheckInterval = options.healthCheckInterval || 300000; // 5 minutes
    this.healthCheckTimer = null;
    this.initialized = false;
  }

  /**
   * Initialize the registry
   */
  async initialize() {
    this.logger.info('Initializing ground truth registry');

    try {
      // Initialize all registered adapters
      for (const [sourceId, adapter] of this.adapters.entries()) {
        try {
          await adapter.initialize();
          this.logger.debug('Adapter initialized', { sourceId });
        } catch (error) {
          this.logger.error('Adapter initialization failed', { sourceId, error: error.message });
        }
      }

      // Start health check monitoring
      this.startHealthMonitoring();

      this.status = RegistryStatus.READY;
      this.initialized = true;
      this.logger.info('Ground truth registry ready', { sourceCount: this.sources.size });

      return true;
    } catch (error) {
      this.status = RegistryStatus.ERROR;
      this.logger.error('Registry initialization failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Register a ground truth source
   */
  async registerSource(sourceConfig, adapterConfig = null) {
    const sourceId = sourceConfig.sourceId;

    this.logger.info('Registering ground truth source', { sourceId, type: sourceConfig.type });

    // Create and validate envelope
    const envelope = createGroundTruthSourceEnvelope(sourceConfig);
    const validation = validateGroundTruthSource(envelope);

    if (!validation.success) {
      throw new Error(`Invalid source configuration: ${validation.error.message}`);
    }

    // Store source envelope
    this.sources.set(sourceId, envelope);

    // Create adapter if config provided
    if (adapterConfig) {
      const adapter = this.createAdapter(sourceConfig.type, {
        ...adapterConfig,
        sourceId,
        sourceName: sourceConfig.name,
        sourceVersion: sourceConfig.version
      });

      this.adapters.set(sourceId, adapter);

      // Initialize if registry is already running
      if (this.initialized) {
        await adapter.initialize();
      }
    }

    this.logger.info('Source registered', { sourceId });
    return envelope;
  }

  /**
   * Create appropriate adapter for source type
   */
  createAdapter(sourceType, config) {
    switch (sourceType) {
      case GroundTruthSourceTypes.TERMINOLOGY:
        return new TerminologyAdapter(config);

      case GroundTruthSourceTypes.DRUG_DATA:
      case GroundTruthSourceTypes.CONTRAINDICATION:
        return new DrugDataAdapter(config);

      case GroundTruthSourceTypes.REFERENCE_RANGE:
        return new ReferenceRangeAdapter(config);

      default:
        throw new Error(`Unsupported source type: ${sourceType}`);
    }
  }

  /**
   * Get a registered source
   */
  getSource(sourceId) {
    return this.sources.get(sourceId);
  }

  /**
   * Get adapter for a source
   */
  getAdapter(sourceId) {
    return this.adapters.get(sourceId);
  }

  /**
   * List all registered sources
   */
  listSources(filter = {}) {
    const sources = [];

    for (const [id, envelope] of this.sources.entries()) {
      const payload = envelope.payload;

      // Apply filters
      if (filter.type && payload.type !== filter.type) continue;
      if (filter.status && payload.status !== filter.status) continue;

      sources.push({
        sourceId: id,
        name: payload.name,
        type: payload.type,
        version: payload.version,
        status: payload.status,
        lastUpdated: payload.lastUpdated,
        hasAdapter: this.adapters.has(id)
      });
    }

    return sources;
  }

  /**
   * Query a source by ID
   */
  async querySource(sourceId, queryType, params) {
    const adapter = this.adapters.get(sourceId);

    if (!adapter) {
      throw new Error(`No adapter registered for source: ${sourceId}`);
    }

    const result = await adapter.query(queryType, params);

    // Update query statistics
    const source = this.sources.get(sourceId);
    if (source) {
      source.payload.queryCount = (source.payload.queryCount || 0) + 1;
      source.payload.lastQueried = new Date().toISOString();
    }

    return result;
  }

  /**
   * Query across all sources of a given type
   */
  async queryByType(sourceType, queryType, params) {
    const results = [];

    for (const [sourceId, envelope] of this.sources.entries()) {
      if (envelope.payload.type !== sourceType) continue;
      if (envelope.payload.status !== 'active') continue;

      const adapter = this.adapters.get(sourceId);
      if (!adapter) continue;

      try {
        const result = await adapter.query(queryType, params);
        results.push({
          sourceId,
          sourceName: envelope.payload.name,
          result
        });
      } catch (error) {
        this.logger.warn('Query failed for source', { sourceId, error: error.message });
      }
    }

    return results;
  }

  /**
   * Validate a code against terminology sources
   */
  async validateCode(code, system) {
    const terminologySources = this.listSources({ type: GroundTruthSourceTypes.TERMINOLOGY });

    for (const source of terminologySources) {
      const adapter = this.getAdapter(source.sourceId);
      if (!adapter) continue;

      const result = await adapter.validateCode(code, system);
      if (result.found) {
        return result;
      }
    }

    return { found: false, code, system };
  }

  /**
   * Check for drug interaction
   */
  async checkDrugInteraction(drugA, drugB) {
    const drugSources = this.listSources({ type: GroundTruthSourceTypes.DRUG_DATA });

    for (const source of drugSources) {
      const adapter = this.getAdapter(source.sourceId);
      if (!adapter) continue;

      const result = await adapter.checkInteraction(drugA, drugB);
      if (result.found && result.data?.interactionFound) {
        return result;
      }
    }

    // Also check contraindication sources
    const contraSources = this.listSources({ type: GroundTruthSourceTypes.CONTRAINDICATION });

    for (const source of contraSources) {
      const adapter = this.getAdapter(source.sourceId);
      if (!adapter) continue;

      const result = await adapter.checkInteraction(drugA, drugB);
      if (result.found && result.data?.interactionFound) {
        return result;
      }
    }

    return { found: true, data: { interactionFound: false, drugA, drugB } };
  }

  /**
   * Evaluate a lab value against reference ranges
   */
  async evaluateLabValue(test, value, unit, patientContext = {}) {
    const rangeSources = this.listSources({ type: GroundTruthSourceTypes.REFERENCE_RANGE });

    for (const source of rangeSources) {
      const adapter = this.getAdapter(source.sourceId);
      if (!adapter) continue;

      const result = await adapter.evaluateValue(test, value, unit, patientContext);
      if (result.found) {
        return result;
      }
    }

    return { found: false, test, value, unit };
  }

  /**
   * Health check all sources
   */
  async checkHealth() {
    const results = [];
    let healthyCount = 0;
    let unhealthyCount = 0;

    for (const [sourceId, adapter] of this.adapters.entries()) {
      try {
        const health = await adapter.healthCheck();
        results.push({
          sourceId,
          ...health
        });

        // Update source status
        const source = this.sources.get(sourceId);
        if (source) {
          source._meta = source._meta || {};
          source._meta.lastHealthCheck = health.checkedAt;
          source._meta.isHealthy = health.healthy;

          if (health.healthy) {
            healthyCount++;
          } else {
            unhealthyCount++;
          }
        }
      } catch (error) {
        results.push({
          sourceId,
          healthy: false,
          error: error.message,
          checkedAt: new Date().toISOString()
        });
        unhealthyCount++;
      }
    }

    // Update registry status
    if (unhealthyCount === 0) {
      this.status = RegistryStatus.READY;
    } else if (healthyCount > 0) {
      this.status = RegistryStatus.DEGRADED;
    } else {
      this.status = RegistryStatus.ERROR;
    }

    return {
      registryStatus: this.status,
      healthyCount,
      unhealthyCount,
      totalSources: this.sources.size,
      results,
      checkedAt: new Date().toISOString()
    };
  }

  /**
   * Start periodic health monitoring
   */
  startHealthMonitoring() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      await this.checkHealth();
    }, this.healthCheckInterval);

    this.logger.debug('Health monitoring started', {
      intervalMs: this.healthCheckInterval
    });
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Remove a source
   */
  async removeSource(sourceId) {
    const adapter = this.adapters.get(sourceId);

    if (adapter) {
      await adapter.shutdown();
      this.adapters.delete(sourceId);
    }

    this.sources.delete(sourceId);
    this.logger.info('Source removed', { sourceId });
  }

  /**
   * Shutdown the registry
   */
  async shutdown() {
    this.logger.info('Shutting down ground truth registry');

    this.stopHealthMonitoring();

    // Shutdown all adapters
    for (const [sourceId, adapter] of this.adapters.entries()) {
      try {
        await adapter.shutdown();
      } catch (error) {
        this.logger.warn('Adapter shutdown error', { sourceId, error: error.message });
      }
    }

    this.adapters.clear();
    this.sources.clear();
    this.status = RegistryStatus.INITIALIZING;
    this.initialized = false;

    this.logger.info('Registry shutdown complete');
  }

  /**
   * Get registry statistics
   */
  getStats() {
    const stats = {
      status: this.status,
      totalSources: this.sources.size,
      totalAdapters: this.adapters.size,
      byType: {},
      byStatus: {},
      adapterStats: []
    };

    // Count by type and status
    for (const envelope of this.sources.values()) {
      const type = envelope.payload.type;
      const status = envelope.payload.status;

      stats.byType[type] = (stats.byType[type] || 0) + 1;
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    }

    // Collect adapter stats
    for (const [sourceId, adapter] of this.adapters.entries()) {
      stats.adapterStats.push(adapter.getStats());
    }

    return stats;
  }

  /**
   * Create registry with default healthcare sources
   */
  static async createWithDefaults(options = {}) {
    const registry = new GroundTruthRegistry(options);

    // Register terminology source
    await registry.registerSource({
      sourceId: 'terminology-fhir',
      name: 'FHIR Terminology Server',
      type: GroundTruthSourceTypes.TERMINOLOGY,
      version: '1.0.0',
      publisher: 'Local',
      licenseType: 'internal',
      updateFrequency: 'quarterly',
      adapter: {
        adapterType: options.fhirEndpoint ? 'fhir' : 'embedded',
        adapterClass: 'TerminologyAdapter'
      }
    }, {
      fhirEndpoint: options.fhirEndpoint
    });

    // Register reference ranges with defaults
    await registry.registerSource({
      sourceId: 'reference-ranges',
      name: 'Lab Reference Ranges',
      type: GroundTruthSourceTypes.REFERENCE_RANGE,
      version: '1.0.0',
      publisher: 'Internal',
      licenseType: 'internal',
      updateFrequency: 'annual',
      adapter: {
        adapterType: 'embedded',
        adapterClass: 'ReferenceRangeAdapter'
      }
    }, {
      defaultRanges: ReferenceRangeAdapter.getCommonReferenceRanges()
    });

    // Register drug data source
    await registry.registerSource({
      sourceId: 'drug-interactions',
      name: 'Drug Interaction Database',
      type: GroundTruthSourceTypes.DRUG_DATA,
      version: '1.0.0',
      publisher: 'Internal',
      licenseType: 'internal',
      updateFrequency: 'daily',
      adapter: {
        adapterType: 'embedded',
        adapterClass: 'DrugDataAdapter'
      }
    }, {});

    await registry.initialize();

    return registry;
  }
}

export default GroundTruthRegistry;
