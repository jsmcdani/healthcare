/**
 * Feature Packs Index
 *
 * Export all pack types for convenient importing.
 */

export {
  HotspotPackPayloadSchema,
  HotspotItemSchema,
  createHotspotPack,
  addHotspot,
  getTopHotspots,
  filterByType,
  validateHotspotPack
} from './HotspotPack.js';

export {
  DomainCoveragePackPayloadSchema,
  CoverageItemSchema,
  CoverageStatusSchema,
  createDomainCoveragePack,
  addCoverageItem,
  getCoverageGaps,
  getUndercoveredDomains,
  validateDomainCoveragePack
} from './DomainCoveragePack.js';

export {
  AffinityPackPayloadSchema,
  AffinityItemSchema,
  AffinityTypeSchema,
  AffinityClusterSchema,
  createAffinityPack,
  addAffinityItem,
  getAffinitiesForEntity,
  getStrongAffinities,
  findAffinityPath,
  validateAffinityPack
} from './AffinityPack.js';
