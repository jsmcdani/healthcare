/**
 * Cosmos DB Gremlin Client
 * Replaces ArangoDB for graph operations in Metalligent Healthcare
 *
 * Supports both:
 * - Local Emulator (dev): ws://localhost:8901/gremlin (no SSL)
 * - Azure Cosmos DB (prod): wss://{account}.gremlin.cosmos.azure.com:443/
 */

import Gremlin from 'gremlin';
import { Logger } from '../utils/logger.js';

const { driver, structure } = Gremlin;
const { Graph } = structure;

export class CosmosGremlinClient {
  constructor(config = {}) {
    this.logger = new Logger('CosmosGremlinClient');

    // Environment-based configuration
    this.config = {
      // Local emulator defaults - uses ws:// (no SSL) for local emulator
      endpoint: config.endpoint || process.env.COSMOS_GREMLIN_ENDPOINT || 'ws://localhost:8901/gremlin',
      primaryKey: config.primaryKey || process.env.COSMOS_PRIMARY_KEY || 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==', // Emulator key
      database: config.database || process.env.COSMOS_DATABASE || 'metalligent',
      container: config.container || process.env.COSMOS_CONTAINER || 'healthcare-graph',

      // Connection settings
      traversalSource: 'g',
      rejectUnauthorized: config.rejectUnauthorized ?? false, // False for local emulator (self-signed cert)
      mimeType: 'application/vnd.gremlin-v2.0+json'
    };

    this.client = null;
    this.initialized = false;
  }

  /**
   * Initialize connection to Cosmos DB Gremlin
   */
  async initialize() {
    try {
      this.logger.info('Initializing Cosmos DB Gremlin connection...', {
        endpoint: this.config.endpoint,
        database: this.config.database,
        container: this.config.container
      });

      // Build authenticator
      const authenticator = new Gremlin.driver.auth.PlainTextSaslAuthenticator(
        `/dbs/${this.config.database}/colls/${this.config.container}`,
        this.config.primaryKey
      );

      // Create client
      this.client = new Gremlin.driver.Client(
        this.config.endpoint,
        {
          authenticator,
          traversalSource: this.config.traversalSource,
          rejectUnauthorized: this.config.rejectUnauthorized,
          mimeType: this.config.mimeType
        }
      );

      // Test connection
      await this.client.open();
      const result = await this.client.submit('g.V().count()');
      const count = result.first();

      this.logger.info('Cosmos DB Gremlin connected', { vertexCount: count });
      this.initialized = true;

      return { success: true, vertexCount: count };

    } catch (error) {
      this.logger.error('Failed to connect to Cosmos DB Gremlin:', error);
      throw error;
    }
  }

  /**
   * Execute a Gremlin query with retry logic for rate limiting
   * Logs every query for debugging/understanding the system
   */
  async query(gremlinQuery, bindings = {}, retries = 3) {
    if (!this.initialized) {
      throw new Error('CosmosGremlinClient not initialized');
    }

    const startTime = Date.now();
    const queryId = `gremlin_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // Log query start
    this.logger.info(`🔷 GREMLIN QUERY [${queryId}]`, {
      query: gremlinQuery.substring(0, 200) + (gremlinQuery.length > 200 ? '...' : ''),
      bindings: Object.keys(bindings).length > 0 ? bindings : undefined
    });

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this.client.submit(gremlinQuery, bindings);
        const resultArray = result.toArray();
        const duration = Date.now() - startTime;

        // Log query success with results
        this.logger.info(`✅ GREMLIN RESULT [${queryId}]`, {
          duration: `${duration}ms`,
          resultCount: resultArray.length,
          firstResult: resultArray.length > 0 ? JSON.stringify(resultArray[0]).substring(0, 100) : null
        });

        return resultArray;
      } catch (error) {
        // Handle rate limiting (429) with retry
        if (error.message && error.message.includes('RequestRateTooLargeException')) {
          const retryAfter = this.extractRetryAfter(error.message) || 100;
          if (attempt < retries) {
            this.logger.warn(`⏳ GREMLIN RETRY [${queryId}] Rate limited, waiting ${retryAfter}ms (attempt ${attempt + 1}/${retries})`);
            await this.delay(retryAfter + 50);
            continue;
          }
        }
        const duration = Date.now() - startTime;
        this.logger.error(`❌ GREMLIN ERROR [${queryId}]`, {
          duration: `${duration}ms`,
          query: gremlinQuery,
          error: error.message
        });
        throw error;
      }
    }
  }

  /**
   * Extract retry-after value from error message
   */
  extractRetryAfter(errorMessage) {
    const match = errorMessage.match(/RetryAfterInMs:\s*(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Add a vertex (node)
   * Cosmos DB Gremlin requires a partition key (pk) on every vertex
   */
  async addVertex(label, properties = {}) {
    // Ensure partition key exists - use id or label as default
    const pk = properties.pk || properties.id || label;

    let query = `g.addV('${label}')`;

    // Add partition key first (required by Cosmos DB)
    query += `.property('pk', '${pk}')`;

    for (const [key, value] of Object.entries(properties)) {
      if (value !== null && value !== undefined && key !== 'pk') {
        const escapedValue = typeof value === 'string' ? value.replace(/'/g, "\\'") : value;
        query += `.property('${key}', '${escapedValue}')`;
      }
    }

    const result = await this.query(query);
    return result[0];
  }

  /**
   * Add an edge between vertices
   */
  async addEdge(fromId, toId, label, properties = {}) {
    let query = `g.V('${fromId}').addE('${label}').to(g.V('${toId}'))`;

    for (const [key, value] of Object.entries(properties)) {
      if (value !== null && value !== undefined) {
        const escapedValue = typeof value === 'string' ? value.replace(/'/g, "\\'") : value;
        query += `.property('${key}', '${escapedValue}')`;
      }
    }

    const result = await this.query(query);
    return result[0];
  }

  /**
   * Get vertex by ID
   */
  async getVertex(id) {
    const result = await this.query(`g.V('${id}')`);
    return result[0] || null;
  }

  /**
   * Get vertices by label
   */
  async getVerticesByLabel(label, limit = 100) {
    const result = await this.query(`g.V().hasLabel('${label}').limit(${limit})`);
    return result;
  }

  /**
   * Get outgoing edges from a vertex
   */
  async getOutEdges(vertexId, edgeLabel = null) {
    const labelFilter = edgeLabel ? `.hasLabel('${edgeLabel}')` : '';
    const result = await this.query(`g.V('${vertexId}').outE()${labelFilter}`);
    return result;
  }

  /**
   * Get incoming edges to a vertex
   */
  async getInEdges(vertexId, edgeLabel = null) {
    const labelFilter = edgeLabel ? `.hasLabel('${edgeLabel}')` : '';
    const result = await this.query(`g.V('${vertexId}').inE()${labelFilter}`);
    return result;
  }

  /**
   * Traverse graph from vertex following edge pattern
   */
  async traverse(startVertexId, pattern) {
    // pattern example: "outE('READS_FIELD').inV()"
    const result = await this.query(`g.V('${startVertexId}').${pattern}`);
    return result;
  }

  /**
   * Drop all vertices and edges (use with caution!)
   */
  async dropAll() {
    await this.query('g.V().drop()');
    this.logger.warn('All vertices and edges dropped');
  }

  /**
   * Close connection
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.initialized = false;
      this.logger.info('Cosmos DB Gremlin connection closed');
    }
  }

  /**
   * Get graph statistics
   */
  async getStats() {
    const [vertexCount] = await this.query('g.V().count()');
    const [edgeCount] = await this.query('g.E().count()');

    // Get label distribution
    const vertexLabels = await this.query('g.V().label().groupCount()');
    const edgeLabels = await this.query('g.E().label().groupCount()');

    return {
      vertices: vertexCount,
      edges: edgeCount,
      vertexLabels: vertexLabels[0] || {},
      edgeLabels: edgeLabels[0] || {}
    };
  }
}

export default CosmosGremlinClient;
