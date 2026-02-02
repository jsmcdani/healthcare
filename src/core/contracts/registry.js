/**
 * Schema Version Registry
 *
 * Central registry for all contract schemas with version tracking.
 * Supports:
 * - Schema registration with version
 * - Active version pointers
 * - Schema lookup by ID and version
 * - Deprecation tracking
 */

import { z } from 'zod';

/**
 * Schema entry in the registry
 */
const SchemaEntrySchema = z.object({
  schemaId: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  schema: z.any(), // Zod schema
  deprecated: z.boolean().default(false),
  deprecatedAt: z.string().datetime().optional(),
  deprecationMessage: z.string().optional(),
  registeredAt: z.string().datetime(),
  registeredBy: z.string().optional()
});

/**
 * Schema Registry - manages all contract schemas
 */
class SchemaRegistry {
  constructor() {
    // Map of schemaId -> Map of version -> SchemaEntry
    this.schemas = new Map();
    // Map of schemaId -> active version string
    this.activeVersions = new Map();
    // Registration log for audit
    this.registrationLog = [];
  }

  /**
   * Register a schema with version
   */
  register(schemaId, version, schema, options = {}) {
    const { deprecated = false, registeredBy = 'system' } = options;

    if (!this.schemas.has(schemaId)) {
      this.schemas.set(schemaId, new Map());
    }

    const versions = this.schemas.get(schemaId);

    if (versions.has(version)) {
      throw new Error(`Schema ${schemaId} version ${version} already registered`);
    }

    const entry = {
      schemaId,
      version,
      schema,
      deprecated,
      registeredAt: new Date().toISOString(),
      registeredBy
    };

    versions.set(version, entry);

    // If this is the first version or explicitly marked active, set as active
    if (!this.activeVersions.has(schemaId)) {
      this.activeVersions.set(schemaId, version);
    }

    this.registrationLog.push({
      action: 'register',
      schemaId,
      version,
      timestamp: entry.registeredAt
    });

    return entry;
  }

  /**
   * Get a schema by ID and optional version
   * If no version specified, returns active version
   */
  get(schemaId, version = null) {
    const versions = this.schemas.get(schemaId);
    if (!versions) {
      return null;
    }

    const targetVersion = version || this.activeVersions.get(schemaId);
    if (!targetVersion) {
      return null;
    }

    return versions.get(targetVersion) || null;
  }

  /**
   * Get the schema object (Zod schema) directly
   */
  getSchema(schemaId, version = null) {
    const entry = this.get(schemaId, version);
    return entry?.schema || null;
  }

  /**
   * Set the active version for a schema
   */
  setActiveVersion(schemaId, version) {
    const versions = this.schemas.get(schemaId);
    if (!versions || !versions.has(version)) {
      throw new Error(`Schema ${schemaId} version ${version} not found`);
    }

    const entry = versions.get(version);
    if (entry.deprecated) {
      console.warn(`Setting deprecated schema ${schemaId} v${version} as active`);
    }

    this.activeVersions.set(schemaId, version);

    this.registrationLog.push({
      action: 'setActive',
      schemaId,
      version,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Deprecate a schema version
   */
  deprecate(schemaId, version, message = '') {
    const entry = this.get(schemaId, version);
    if (!entry) {
      throw new Error(`Schema ${schemaId} version ${version} not found`);
    }

    entry.deprecated = true;
    entry.deprecatedAt = new Date().toISOString();
    entry.deprecationMessage = message;

    this.registrationLog.push({
      action: 'deprecate',
      schemaId,
      version,
      message,
      timestamp: entry.deprecatedAt
    });
  }

  /**
   * List all versions of a schema
   */
  listVersions(schemaId) {
    const versions = this.schemas.get(schemaId);
    if (!versions) {
      return [];
    }

    return Array.from(versions.values()).map(entry => ({
      version: entry.version,
      deprecated: entry.deprecated,
      isActive: this.activeVersions.get(schemaId) === entry.version,
      registeredAt: entry.registeredAt
    }));
  }

  /**
   * List all registered schemas
   */
  listSchemas() {
    const result = [];
    for (const [schemaId, versions] of this.schemas) {
      result.push({
        schemaId,
        activeVersion: this.activeVersions.get(schemaId),
        versionCount: versions.size,
        versions: this.listVersions(schemaId)
      });
    }
    return result;
  }

  /**
   * Check if a schema exists
   */
  has(schemaId, version = null) {
    if (version) {
      return this.schemas.get(schemaId)?.has(version) || false;
    }
    return this.schemas.has(schemaId);
  }

  /**
   * Get the active version of a schema
   */
  getActiveVersion(schemaId) {
    return this.activeVersions.get(schemaId) || null;
  }

  /**
   * Export registry state (for persistence)
   */
  export() {
    const state = {
      schemas: {},
      activeVersions: Object.fromEntries(this.activeVersions),
      exportedAt: new Date().toISOString()
    };

    for (const [schemaId, versions] of this.schemas) {
      state.schemas[schemaId] = {};
      for (const [version, entry] of versions) {
        // Note: schema itself is not serializable, only metadata
        state.schemas[schemaId][version] = {
          schemaId: entry.schemaId,
          version: entry.version,
          deprecated: entry.deprecated,
          deprecatedAt: entry.deprecatedAt,
          deprecationMessage: entry.deprecationMessage,
          registeredAt: entry.registeredAt,
          registeredBy: entry.registeredBy
        };
      }
    }

    return state;
  }

  /**
   * Clear the registry (for testing)
   */
  clear() {
    this.schemas.clear();
    this.activeVersions.clear();
    this.registrationLog = [];
  }
}

// Singleton instance
let registryInstance = null;

/**
 * Get the global schema registry instance
 */
export function getSchemaRegistry() {
  if (!registryInstance) {
    registryInstance = new SchemaRegistry();
  }
  return registryInstance;
}

/**
 * Register a schema in the global registry
 */
export function registerSchema(schemaId, version, schema, options = {}) {
  return getSchemaRegistry().register(schemaId, version, schema, options);
}

/**
 * Get a schema from the global registry
 */
export function getRegisteredSchema(schemaId, version = null) {
  return getSchemaRegistry().getSchema(schemaId, version);
}

// Re-export SchemaIds from dedicated file (breaks circular deps)
export { SchemaIds } from './schema-ids.js';

export { SchemaRegistry };
export default getSchemaRegistry;
