/**
 * Cosmos DB Gremlin Tools for Healthcare Admin Agent
 *
 * Graph database operations using Cosmos DB Gremlin API
 * Supports multiple database connections (primary, secondary, etc.)
 */

import { CosmosGremlinClient } from '../../../database/CosmosGremlinClient.js';

export const cosmosGremlinTools = [
  // ============================================
  // MULTI-DATABASE MANAGEMENT TOOLS
  // ============================================
  {
    name: 'list_gremlin_databases',
    description: 'List all configured Gremlin database connections and their status.',
    input_schema: {
      type: 'object',
      properties: {}
    },
    handler: async (orchestrator, input) => {
      try {
        const connections = CosmosGremlinClient.listConnections();

        // Also show available but not connected databases
        const available = [
          {
            alias: 'primary',
            endpoint: process.env.COSMOS_GREMLIN_ENDPOINT || 'ws://localhost:8901/gremlin',
            status: connections.find(c => c.alias === 'primary')?.initialized ? 'connected' : 'available'
          },
          {
            alias: 'secondary',
            endpoint: process.env.COSMOS_GREMLIN_ENDPOINT_SECONDARY || 'ws://localhost:8902/gremlin',
            status: connections.find(c => c.alias === 'secondary')?.initialized ? 'connected' : 'available'
          }
        ];

        return {
          success: true,
          activeConnections: connections,
          availableDatabases: available,
          currentPrimary: orchestrator.cosmosGremlinClient?.config?.endpoint || 'not set'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'connect_gremlin_database',
    description: 'Connect to a Gremlin database by alias (primary, secondary) or custom endpoint.',
    input_schema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Database alias (primary, secondary) or custom name',
          default: 'secondary'
        },
        endpoint: {
          type: 'string',
          description: 'Optional custom endpoint URL (e.g., ws://localhost:8902/gremlin)'
        },
        database: {
          type: 'string',
          description: 'Optional database name'
        },
        container: {
          type: 'string',
          description: 'Optional container/graph name'
        }
      },
      required: ['alias']
    },
    handler: async (orchestrator, input) => {
      try {
        const config = {};
        if (input.endpoint) config.endpoint = input.endpoint;
        if (input.database) config.database = input.database;
        if (input.container) config.container = input.container;

        const client = CosmosGremlinClient.getClient(input.alias, config);

        if (!client.initialized) {
          await client.initialize();
        }

        const stats = await client.getStats();

        return {
          success: true,
          alias: input.alias,
          endpoint: client.config.endpoint,
          database: client.config.database,
          container: client.config.container,
          initialized: client.initialized,
          stats: {
            vertices: stats.vertices,
            edges: stats.edges
          }
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'query_gremlin_database',
    description: 'Execute a Gremlin query against a specific database by alias.',
    input_schema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Database alias (primary, secondary)',
          default: 'primary'
        },
        query: {
          type: 'string',
          description: 'Gremlin query to execute'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return',
          default: 100
        }
      },
      required: ['query']
    },
    handler: async (orchestrator, input) => {
      try {
        const client = CosmosGremlinClient.getClient(input.alias || 'primary');

        if (!client.initialized) {
          return { success: false, error: `Database '${input.alias}' not connected. Use connect_gremlin_database first.` };
        }

        let query = input.query;
        if (!query.includes('.limit(') && input.limit) {
          // Add limit if query ends with traversal
          if (query.match(/\)$/)) {
            query = query.replace(/\)$/, `.limit(${input.limit}))`);
          }
        }

        const results = await client.query(query);

        return {
          success: true,
          alias: input.alias || 'primary',
          endpoint: client.config.endpoint,
          query: input.query,
          resultCount: results.length,
          results: results.slice(0, input.limit || 100)
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'compare_gremlin_databases',
    description: 'Compare statistics between two Gremlin databases.',
    input_schema: {
      type: 'object',
      properties: {
        database1: {
          type: 'string',
          description: 'First database alias',
          default: 'primary'
        },
        database2: {
          type: 'string',
          description: 'Second database alias',
          default: 'secondary'
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db1 = input.database1 || 'primary';
        const db2 = input.database2 || 'secondary';

        const client1 = CosmosGremlinClient.getClient(db1);
        const client2 = CosmosGremlinClient.getClient(db2);

        const results = { [db1]: null, [db2]: null };

        if (client1.initialized) {
          results[db1] = await client1.getStats();
        } else {
          results[db1] = { error: 'Not connected' };
        }

        if (client2.initialized) {
          results[db2] = await client2.getStats();
        } else {
          results[db2] = { error: 'Not connected' };
        }

        return {
          success: true,
          comparison: results,
          differences: {
            vertices: (results[db1]?.vertices || 0) - (results[db2]?.vertices || 0),
            edges: (results[db1]?.edges || 0) - (results[db2]?.edges || 0)
          }
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  // ============================================
  // ORIGINAL TOOLS (use primary database)
  // ============================================
  {
    name: 'gremlin_query',
    description: 'Execute a Gremlin query against Cosmos DB graph. Use for custom graph traversals and analysis.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gremlin query to execute (e.g., "g.V().hasLabel(\'Field\').count()")'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return',
          default: 100
        }
      },
      required: ['query']
    },
    handler: async (orchestrator, input) => {
      try {
        const cosmosClient = orchestrator.cosmosGremlinClient;
        if (!cosmosClient?.initialized) {
          return { success: false, error: 'Cosmos Gremlin client not initialized' };
        }

        // Add limit if not in query
        let query = input.query;
        if (!query.includes('.limit(') && input.limit) {
          query = query.replace(/\)$/, `.limit(${input.limit})`);
        }

        const results = await cosmosClient.query(query);

        return {
          success: true,
          query: input.query,
          resultCount: results.length,
          results: results.slice(0, input.limit || 100)
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'get_graph_stats',
    description: 'Get vertex and edge counts by label from the healthcare graph.',
    input_schema: {
      type: 'object',
      properties: {
        includeDetails: {
          type: 'boolean',
          description: 'Include detailed breakdown by label',
          default: true
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const cosmosClient = orchestrator.cosmosGremlinClient;
        if (!cosmosClient?.initialized) {
          return { success: false, error: 'Cosmos Gremlin client not initialized' };
        }

        const stats = await cosmosClient.getStats();

        return {
          success: true,
          stats: {
            totalVertices: stats.vertices,
            totalEdges: stats.edges,
            vertexLabels: input.includeDetails ? stats.vertexLabels : Object.keys(stats.vertexLabels).length,
            edgeLabels: input.includeDetails ? stats.edgeLabels : Object.keys(stats.edgeLabels).length
          }
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'find_phi_automations',
    description: 'Find all automations (Flows, Apex, etc.) that access PHI-classified fields.',
    input_schema: {
      type: 'object',
      properties: {
        phiClassification: {
          type: 'string',
          enum: ['DIRECT_IDENTIFIER', 'QUASI_IDENTIFIER', 'SENSITIVE', 'ALL'],
          description: 'PHI classification level to search for',
          default: 'ALL'
        },
        automationType: {
          type: 'string',
          enum: ['Flow', 'ApexClass', 'ValidationRule', 'ALL'],
          description: 'Type of automation to search',
          default: 'ALL'
        },
        limit: {
          type: 'number',
          default: 50
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const cosmosClient = orchestrator.cosmosGremlinClient;
        if (!cosmosClient?.initialized) {
          return { success: false, error: 'Cosmos Gremlin client not initialized' };
        }

        // Build query based on filters
        let phiFilter = input.phiClassification === 'ALL'
          ? ".has('sensitivity', 'PHI')"
          : `.has('phiClassification', '${input.phiClassification}')`;

        let autoFilter = input.automationType === 'ALL'
          ? ''
          : `.hasLabel('${input.automationType}')`;

        const query = `
          g.V().hasLabel('Field')${phiFilter}
           .inE('READS_FIELD', 'WRITES_FIELD')
           .outV()${autoFilter}
           .dedup()
           .limit(${input.limit || 50})
           .project('id', 'label', 'name', 'accessType')
           .by(id)
           .by(label)
           .by('fullName')
           .by(__.inE().label())
        `;

        const results = await cosmosClient.query(query);

        return {
          success: true,
          phiClassification: input.phiClassification,
          automationType: input.automationType,
          count: results.length,
          automations: results
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'get_field_access_paths',
    description: 'Trace all automations that read or write a specific field.',
    input_schema: {
      type: 'object',
      properties: {
        fieldId: {
          type: 'string',
          description: 'Field ID (e.g., "Patient__c.SSN__c")'
        },
        direction: {
          type: 'string',
          enum: ['inbound', 'outbound', 'both'],
          description: 'Direction of access to trace',
          default: 'both'
        }
      },
      required: ['fieldId']
    },
    handler: async (orchestrator, input) => {
      try {
        const cosmosClient = orchestrator.cosmosGremlinClient;
        if (!cosmosClient?.initialized) {
          return { success: false, error: 'Cosmos Gremlin client not initialized' };
        }

        const results = { readers: [], writers: [] };

        if (input.direction === 'inbound' || input.direction === 'both') {
          const readers = await cosmosClient.query(`
            g.V('${input.fieldId}')
             .inE('READS_FIELD')
             .outV()
             .project('id', 'label', 'name')
             .by(id)
             .by(label)
             .by('fullName')
          `);
          results.readers = readers;
        }

        if (input.direction === 'outbound' || input.direction === 'both') {
          const writers = await cosmosClient.query(`
            g.V('${input.fieldId}')
             .inE('WRITES_FIELD')
             .outV()
             .project('id', 'label', 'name')
             .by(id)
             .by(label)
             .by('fullName')
          `);
          results.writers = writers;
        }

        return {
          success: true,
          fieldId: input.fieldId,
          readerCount: results.readers.length,
          writerCount: results.writers.length,
          accessPaths: results
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'audit_graph_permissions',
    description: 'Audit the permission graph to identify who has access to what data.',
    input_schema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['Field', 'Object', 'Flow', 'ALL'],
          description: 'Type of resource to audit',
          default: 'Field'
        },
        sensitivityFilter: {
          type: 'string',
          enum: ['PHI', 'PII', 'SENSITIVE', 'ALL'],
          description: 'Filter by sensitivity level',
          default: 'PHI'
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const cosmosClient = orchestrator.cosmosGremlinClient;
        if (!cosmosClient?.initialized) {
          return { success: false, error: 'Cosmos Gremlin client not initialized' };
        }

        const labelFilter = input.targetType === 'ALL' ? '' : `.hasLabel('${input.targetType}')`;
        const sensFilter = input.sensitivityFilter === 'ALL' ? '' : `.has('sensitivity', '${input.sensitivityFilter}')`;

        const query = `
          g.V()${labelFilter}${sensFilter}
           .project('resource', 'sensitivity', 'accessedBy')
           .by(id)
           .by('sensitivity')
           .by(__.inE('READS_FIELD', 'WRITES_FIELD', 'DISPLAYS').outV().label().fold())
           .limit(100)
        `;

        const results = await cosmosClient.query(query);

        // Summarize
        const summary = {
          totalResources: results.length,
          byAccessorType: {}
        };

        for (const r of results) {
          for (const accessor of (r.accessedBy || [])) {
            summary.byAccessorType[accessor] = (summary.byAccessorType[accessor] || 0) + 1;
          }
        }

        return {
          success: true,
          targetType: input.targetType,
          sensitivityFilter: input.sensitivityFilter,
          summary,
          details: results.slice(0, 50)
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];
