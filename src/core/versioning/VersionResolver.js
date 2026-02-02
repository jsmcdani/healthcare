/**
 * VersionResolver - Resolves pinned vs active versions
 *
 * Resolution order:
 * 1. Explicit pin (if provided in request)
 * 2. Active approved version pointer (from registry)
 */

import { z } from 'zod';
import { getVersionRegistry } from './VersionRegistry.js';

/**
 * Version resolution request
 */
export const VersionResolutionRequestSchema = z.object({
  artifactId: z.string(),
  pinnedVersion: z.string().optional().describe('Explicit version pin'),
  allowDraft: z.boolean().default(false).describe('Allow draft versions'),
  allowDeprecated: z.boolean().default(false).describe('Allow deprecated versions'),
  requireActive: z.boolean().default(true).describe('Require an active version')
});

/**
 * Version resolution result
 */
export const VersionResolutionResultSchema = z.object({
  artifactId: z.string(),
  resolvedVersion: z.string().nullable(),
  resolutionSource: z.enum(['pinned', 'active', 'latest', 'none']),
  versionStatus: z.string().optional(),
  warning: z.string().optional()
});

/**
 * Version Resolver - resolves which version to use
 */
export class VersionResolver {
  constructor(options = {}) {
    this.registry = options.registry || getVersionRegistry();
    this.defaultAllowDraft = options.allowDraft || false;
    this.defaultAllowDeprecated = options.allowDeprecated || false;
  }

  /**
   * Resolve version for an artifact
   */
  resolve(request) {
    const {
      artifactId,
      pinnedVersion,
      allowDraft = this.defaultAllowDraft,
      allowDeprecated = this.defaultAllowDeprecated,
      requireActive = true
    } = request;

    // 1. Try explicit pin first
    if (pinnedVersion) {
      const entry = this.registry.get(artifactId, pinnedVersion);
      if (entry) {
        // Validate pinned version status
        const warning = this.validateVersionStatus(entry, allowDraft, allowDeprecated);
        return {
          artifactId,
          resolvedVersion: pinnedVersion,
          resolutionSource: 'pinned',
          versionStatus: entry.status,
          warning
        };
      }

      // Pinned version not found
      if (requireActive) {
        return {
          artifactId,
          resolvedVersion: null,
          resolutionSource: 'none',
          warning: `Pinned version ${pinnedVersion} not found`
        };
      }
    }

    // 2. Try active version pointer
    const activeVersion = this.registry.getActiveVersion(artifactId);
    if (activeVersion) {
      const entry = this.registry.get(artifactId, activeVersion);
      return {
        artifactId,
        resolvedVersion: activeVersion,
        resolutionSource: 'active',
        versionStatus: entry?.status
      };
    }

    // 3. Try latest non-archived version
    if (!requireActive) {
      const latestVersion = this.registry.getLatestVersion(artifactId);
      if (latestVersion) {
        const entry = this.registry.get(artifactId, latestVersion);
        const warning = this.validateVersionStatus(entry, allowDraft, allowDeprecated);
        return {
          artifactId,
          resolvedVersion: latestVersion,
          resolutionSource: 'latest',
          versionStatus: entry?.status,
          warning
        };
      }
    }

    // No version found
    return {
      artifactId,
      resolvedVersion: null,
      resolutionSource: 'none',
      warning: `No ${requireActive ? 'active ' : ''}version found for ${artifactId}`
    };
  }

  /**
   * Validate version status and return warning if applicable
   */
  validateVersionStatus(entry, allowDraft, allowDeprecated) {
    if (!entry) return 'Version entry not found';

    if (entry.status === 'archived') {
      return 'Version is archived';
    }

    if (entry.status === 'draft' && !allowDraft) {
      return 'Version is draft (not approved)';
    }

    if (entry.status === 'deprecated' && !allowDeprecated) {
      return `Version is deprecated${entry.deprecationReason ? ': ' + entry.deprecationReason : ''}`;
    }

    return undefined;
  }

  /**
   * Resolve multiple versions at once
   */
  resolveMany(requests) {
    return requests.map(req => this.resolve(req));
  }

  /**
   * Resolve with fallback chain
   */
  resolveWithFallback(artifactId, versionChain) {
    for (const version of versionChain) {
      const result = this.resolve({
        artifactId,
        pinnedVersion: version,
        requireActive: false
      });

      if (result.resolvedVersion) {
        return result;
      }
    }

    // Try active as final fallback
    return this.resolve({ artifactId });
  }

  /**
   * Check if a version is usable
   */
  isVersionUsable(artifactId, version, options = {}) {
    const result = this.resolve({
      artifactId,
      pinnedVersion: version,
      ...options
    });

    return result.resolvedVersion === version && !result.warning;
  }

  /**
   * Get all resolvable artifacts with their versions
   */
  getResolvableArtifacts() {
    const pointers = this.registry.listActivePointers();
    return pointers.map(p => ({
      artifactId: p.artifactId,
      activeVersion: p.activeVersion,
      status: p.entry?.status
    }));
  }
}

// Singleton instance
let resolverInstance = null;

/**
 * Get the global version resolver
 */
export function getVersionResolver() {
  if (!resolverInstance) {
    resolverInstance = new VersionResolver();
  }
  return resolverInstance;
}

/**
 * Resolve a version
 */
export function resolveVersion(artifactId, pinnedVersion = null) {
  return getVersionResolver().resolve({
    artifactId,
    pinnedVersion
  });
}

export default VersionResolver;
