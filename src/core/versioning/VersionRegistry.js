/**
 * VersionRegistry - Tracks active versions of artifacts
 *
 * Manages version lifecycle: draft -> pending -> active -> deprecated -> archived
 */

import { z } from 'zod';

/**
 * Version entry
 */
export const VersionEntrySchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: z.enum(['draft', 'pending', 'active', 'deprecated', 'archived']),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().optional(),
  deprecatedAt: z.string().datetime().optional(),
  archivedAt: z.string().datetime().optional(),
  createdBy: z.string().optional(),
  deprecationReason: z.string().optional(),
  supersededBy: z.string().optional().describe('Version that superseded this one'),
  metadata: z.record(z.any()).optional()
});

/**
 * Active version pointer
 */
export const ActiveVersionPointerSchema = z.object({
  artifactId: z.string(),
  activeVersion: z.string(),
  activatedAt: z.string().datetime(),
  activatedBy: z.string().optional()
});

/**
 * Version Registry - tracks all artifact versions
 */
export class VersionRegistry {
  constructor() {
    // Map of artifactId -> Map of version -> VersionEntry
    this.versions = new Map();
    // Map of artifactId -> active version string
    this.activePointers = new Map();
    // History log
    this.history = [];
  }

  /**
   * Register a new version
   */
  register(artifactId, version, options = {}) {
    const {
      artifactType,
      status = 'draft',
      createdBy,
      metadata
    } = options;

    if (!this.versions.has(artifactId)) {
      this.versions.set(artifactId, new Map());
    }

    const versions = this.versions.get(artifactId);

    if (versions.has(version)) {
      throw new Error(`Version ${version} already registered for ${artifactId}`);
    }

    const entry = {
      artifactId,
      artifactType,
      version,
      status,
      createdAt: new Date().toISOString(),
      createdBy,
      metadata
    };

    versions.set(version, entry);

    this.history.push({
      action: 'register',
      artifactId,
      version,
      timestamp: entry.createdAt
    });

    return entry;
  }

  /**
   * Activate a version (make it the current active version)
   */
  activate(artifactId, version, activatedBy = null) {
    const versions = this.versions.get(artifactId);
    if (!versions || !versions.has(version)) {
      throw new Error(`Version ${version} not found for ${artifactId}`);
    }

    const entry = versions.get(version);
    if (entry.status === 'archived') {
      throw new Error(`Cannot activate archived version ${version}`);
    }

    const now = new Date().toISOString();

    // Deprecate current active version
    const currentActive = this.activePointers.get(artifactId);
    if (currentActive) {
      const currentEntry = versions.get(currentActive);
      if (currentEntry && currentEntry.status === 'active') {
        currentEntry.status = 'deprecated';
        currentEntry.deprecatedAt = now;
        currentEntry.supersededBy = version;
      }
    }

    // Activate new version
    entry.status = 'active';
    entry.activatedAt = now;

    // Update pointer
    this.activePointers.set(artifactId, version);

    this.history.push({
      action: 'activate',
      artifactId,
      version,
      previousVersion: currentActive,
      activatedBy,
      timestamp: now
    });

    return entry;
  }

  /**
   * Deprecate a version
   */
  deprecate(artifactId, version, reason = '') {
    const versions = this.versions.get(artifactId);
    if (!versions || !versions.has(version)) {
      throw new Error(`Version ${version} not found for ${artifactId}`);
    }

    const entry = versions.get(version);
    entry.status = 'deprecated';
    entry.deprecatedAt = new Date().toISOString();
    entry.deprecationReason = reason;

    // If this was the active version, clear the pointer
    if (this.activePointers.get(artifactId) === version) {
      this.activePointers.delete(artifactId);
    }

    this.history.push({
      action: 'deprecate',
      artifactId,
      version,
      reason,
      timestamp: entry.deprecatedAt
    });

    return entry;
  }

  /**
   * Archive a version
   */
  archive(artifactId, version) {
    const versions = this.versions.get(artifactId);
    if (!versions || !versions.has(version)) {
      throw new Error(`Version ${version} not found for ${artifactId}`);
    }

    const entry = versions.get(version);

    if (entry.status === 'active') {
      throw new Error(`Cannot archive active version ${version}. Deprecate first.`);
    }

    entry.status = 'archived';
    entry.archivedAt = new Date().toISOString();

    this.history.push({
      action: 'archive',
      artifactId,
      version,
      timestamp: entry.archivedAt
    });

    return entry;
  }

  /**
   * Get a version entry
   */
  get(artifactId, version = null) {
    const versions = this.versions.get(artifactId);
    if (!versions) {
      return null;
    }

    const targetVersion = version || this.activePointers.get(artifactId);
    if (!targetVersion) {
      return null;
    }

    return versions.get(targetVersion) || null;
  }

  /**
   * Get active version
   */
  getActiveVersion(artifactId) {
    return this.activePointers.get(artifactId) || null;
  }

  /**
   * Get all versions for an artifact
   */
  listVersions(artifactId) {
    const versions = this.versions.get(artifactId);
    if (!versions) {
      return [];
    }

    return Array.from(versions.values())
      .sort((a, b) => this.compareVersions(b.version, a.version)); // Newest first
  }

  /**
   * Get all active version pointers
   */
  listActivePointers() {
    const pointers = [];
    for (const [artifactId, version] of this.activePointers) {
      pointers.push({
        artifactId,
        activeVersion: version,
        entry: this.get(artifactId, version)
      });
    }
    return pointers;
  }

  /**
   * Compare semver versions
   */
  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (parts1[i] > parts2[i]) return 1;
      if (parts1[i] < parts2[i]) return -1;
    }
    return 0;
  }

  /**
   * Get latest version (by semver, regardless of status)
   */
  getLatestVersion(artifactId, statusFilter = null) {
    const versions = this.listVersions(artifactId);
    if (statusFilter) {
      const filtered = versions.filter(v => v.status === statusFilter);
      return filtered[0]?.version || null;
    }
    return versions[0]?.version || null;
  }

  /**
   * Check if version exists
   */
  has(artifactId, version = null) {
    if (version) {
      return this.versions.get(artifactId)?.has(version) || false;
    }
    return this.versions.has(artifactId);
  }

  /**
   * Get history
   */
  getHistory(artifactId = null) {
    if (artifactId) {
      return this.history.filter(h => h.artifactId === artifactId);
    }
    return [...this.history];
  }

  /**
   * Export registry state
   */
  export() {
    const state = {
      versions: {},
      activePointers: Object.fromEntries(this.activePointers),
      exportedAt: new Date().toISOString()
    };

    for (const [artifactId, versions] of this.versions) {
      state.versions[artifactId] = Object.fromEntries(versions);
    }

    return state;
  }

  /**
   * Import registry state
   */
  import(state) {
    for (const [artifactId, versions] of Object.entries(state.versions || {})) {
      if (!this.versions.has(artifactId)) {
        this.versions.set(artifactId, new Map());
      }
      for (const [version, entry] of Object.entries(versions)) {
        this.versions.get(artifactId).set(version, entry);
      }
    }

    for (const [artifactId, version] of Object.entries(state.activePointers || {})) {
      this.activePointers.set(artifactId, version);
    }
  }

  /**
   * Clear the registry (for testing)
   */
  clear() {
    this.versions.clear();
    this.activePointers.clear();
    this.history = [];
  }
}

// Singleton instance
let registryInstance = null;

/**
 * Get the global version registry
 */
export function getVersionRegistry() {
  if (!registryInstance) {
    registryInstance = new VersionRegistry();
  }
  return registryInstance;
}

/**
 * Register a version in the global registry
 */
export function registerVersion(artifactId, version, options = {}) {
  return getVersionRegistry().register(artifactId, version, options);
}

/**
 * Get active version from the global registry
 */
export function getActiveVersion(artifactId) {
  return getVersionRegistry().getActiveVersion(artifactId);
}

export default VersionRegistry;
