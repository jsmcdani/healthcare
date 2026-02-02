/**
 * Versioning Index
 *
 * Export all versioning-related components.
 */

export {
  VersionRegistry,
  VersionEntrySchema,
  ActiveVersionPointerSchema,
  getVersionRegistry,
  registerVersion,
  getActiveVersion
} from './VersionRegistry.js';

export {
  VersionResolver,
  VersionResolutionRequestSchema,
  VersionResolutionResultSchema,
  getVersionResolver,
  resolveVersion
} from './VersionResolver.js';
