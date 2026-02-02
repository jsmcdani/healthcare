/**
 * HotspotPack - Pack for hotspot analysis results
 *
 * Identifies high-activity or high-impact areas in the system.
 */

import { z } from 'zod';
import { FeaturePackPayloadSchema, createFeaturePack } from '../FeaturePackEnvelope.js';
import { registerSchema, SchemaIds } from '../../contracts/registry.js';

/**
 * Hotspot item - a single hotspot entry
 */
export const HotspotItemSchema = z.object({
  entityId: z.string().describe('ID of the hotspot entity'),
  entityType: z.string().describe('Type of entity (e.g., "field", "object", "workflow")'),
  entityName: z.string(),
  score: z.number().describe('Hotspot score (higher = more activity)'),
  rank: z.number().optional().describe('Rank among all hotspots'),
  metrics: z.object({
    accessCount: z.number().optional(),
    modificationCount: z.number().optional(),
    errorCount: z.number().optional(),
    dependencyCount: z.number().optional(),
    complexityScore: z.number().optional()
  }).optional(),
  trend: z.enum(['increasing', 'stable', 'decreasing']).optional(),
  lastActivityAt: z.string().datetime().optional(),
  relatedEntities: z.array(z.object({
    entityId: z.string(),
    entityType: z.string(),
    relationship: z.string()
  })).optional(),
  recommendations: z.array(z.string()).optional()
});

/**
 * Hotspot Pack specific payload
 */
export const HotspotPackPayloadSchema = FeaturePackPayloadSchema.extend({
  packType: z.literal('hotspot'),
  items: z.array(HotspotItemSchema),
  thresholds: z.object({
    high: z.number().describe('Score threshold for high priority'),
    medium: z.number().describe('Score threshold for medium priority'),
    low: z.number().describe('Score threshold for low priority')
  }).optional(),
  timePeriod: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }).optional(),
  aggregations: z.object({
    totalHotspots: z.number(),
    byType: z.record(z.number()),
    byTrend: z.record(z.number()),
    averageScore: z.number(),
    maxScore: z.number()
  }).optional()
});

/**
 * Create a hotspot pack
 */
export function createHotspotPack(options) {
  const pack = createFeaturePack({
    ...options,
    packType: 'hotspot',
    items: options.items || []
  });

  // Add hotspot-specific fields
  pack.payload.packType = 'hotspot';
  if (options.thresholds) {
    pack.payload.thresholds = options.thresholds;
  }
  if (options.timePeriod) {
    pack.payload.timePeriod = options.timePeriod;
  }

  // Compute aggregations
  const items = pack.payload.items;
  pack.payload.aggregations = {
    totalHotspots: items.length,
    byType: items.reduce((acc, item) => {
      acc[item.entityType] = (acc[item.entityType] || 0) + 1;
      return acc;
    }, {}),
    byTrend: items.reduce((acc, item) => {
      if (item.trend) {
        acc[item.trend] = (acc[item.trend] || 0) + 1;
      }
      return acc;
    }, {}),
    averageScore: items.length > 0
      ? items.reduce((sum, item) => sum + item.score, 0) / items.length
      : 0,
    maxScore: items.length > 0
      ? Math.max(...items.map(item => item.score))
      : 0
  };

  return pack;
}

/**
 * Add hotspot to pack
 */
export function addHotspot(pack, hotspot) {
  if (pack.payload.status !== 'draft') {
    throw new Error('Cannot modify non-draft pack');
  }

  const rank = pack.payload.items.length + 1;
  const item = { ...hotspot, rank };

  pack.payload.items.push(item);
  pack.payload.itemCount = pack.payload.items.length;
  pack.payload.updatedAt = new Date().toISOString();

  // Re-sort by score and update ranks
  pack.payload.items.sort((a, b) => b.score - a.score);
  pack.payload.items.forEach((item, index) => {
    item.rank = index + 1;
  });

  return item;
}

/**
 * Get top hotspots
 */
export function getTopHotspots(pack, count = 10) {
  return pack.payload.items.slice(0, count);
}

/**
 * Filter hotspots by type
 */
export function filterByType(pack, entityType) {
  return pack.payload.items.filter(item => item.entityType === entityType);
}

/**
 * Validate a hotspot pack
 */
export function validateHotspotPack(pack) {
  return HotspotPackPayloadSchema.safeParse(pack.payload);
}

// Register schema on load
try {
  registerSchema(SchemaIds.PACK_HOTSPOT, '1.0.0', HotspotPackPayloadSchema);
} catch (e) {
  // Already registered
}

export default HotspotPackPayloadSchema;
