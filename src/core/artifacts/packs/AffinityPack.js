/**
 * AffinityPack - Pack for field/entity affinity analysis
 *
 * Identifies relationships and co-occurrence patterns between entities.
 */

import { z } from 'zod';
import { FeaturePackPayloadSchema, createFeaturePack } from '../FeaturePackEnvelope.js';
import { registerSchema, SchemaIds } from '../../contracts/registry.js';

/**
 * Affinity type - type of relationship
 */
export const AffinityTypeSchema = z.enum([
  'co_occurrence',    // Frequently appear together
  'dependency',       // One depends on another
  'derivation',       // One derived from another
  'semantic',         // Semantically related
  'workflow',         // Related in workflows
  'temporal',         // Time-based relationship
  'custom'            // Custom relationship type
]);

/**
 * Affinity item - a single affinity relationship
 */
export const AffinityItemSchema = z.object({
  sourceId: z.string().describe('Source entity ID'),
  sourceType: z.string().describe('Source entity type'),
  sourceName: z.string(),
  targetId: z.string().describe('Target entity ID'),
  targetType: z.string().describe('Target entity type'),
  targetName: z.string(),
  affinityType: AffinityTypeSchema,
  score: z.number().min(0).max(1).describe('Affinity score (0-1)'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence in the affinity'),
  bidirectional: z.boolean().default(false).describe('Whether relationship is bidirectional'),
  metrics: z.object({
    coOccurrenceCount: z.number().optional(),
    supportCount: z.number().optional(),
    lift: z.number().optional(),
    correlation: z.number().optional()
  }).optional(),
  context: z.object({
    discoveredIn: z.string().optional().describe('Where this affinity was discovered'),
    sampleCount: z.number().optional(),
    firstSeen: z.string().datetime().optional(),
    lastSeen: z.string().datetime().optional()
  }).optional(),
  tags: z.array(z.string()).optional()
});

/**
 * Affinity cluster - group of related entities
 */
export const AffinityClusterSchema = z.object({
  clusterId: z.string(),
  clusterName: z.string().optional(),
  members: z.array(z.object({
    entityId: z.string(),
    entityType: z.string(),
    entityName: z.string(),
    centralityScore: z.number().optional()
  })),
  cohesionScore: z.number().min(0).max(1).optional(),
  dominantAffinityType: AffinityTypeSchema.optional()
});

/**
 * Affinity Pack specific payload
 */
export const AffinityPackPayloadSchema = FeaturePackPayloadSchema.extend({
  packType: z.literal('affinity'),
  items: z.array(AffinityItemSchema),
  clusters: z.array(AffinityClusterSchema).optional(),
  thresholds: z.object({
    strong: z.number().default(0.8).describe('Threshold for strong affinity'),
    moderate: z.number().default(0.5).describe('Threshold for moderate affinity'),
    weak: z.number().default(0.2).describe('Threshold for weak affinity')
  }).optional(),
  aggregations: z.object({
    totalAffinities: z.number(),
    byType: z.record(z.number()),
    byStrength: z.object({
      strong: z.number(),
      moderate: z.number(),
      weak: z.number()
    }).optional(),
    averageScore: z.number(),
    clusterCount: z.number().optional(),
    topEntities: z.array(z.object({
      entityId: z.string(),
      entityName: z.string(),
      affinityCount: z.number()
    })).optional()
  }).optional(),
  indexes: z.object({
    bySource: z.record(z.array(z.number())).optional(),
    byTarget: z.record(z.array(z.number())).optional(),
    byType: z.record(z.array(z.number())).optional()
  }).optional()
});

/**
 * Create an affinity pack
 */
export function createAffinityPack(options) {
  const pack = createFeaturePack({
    ...options,
    packType: 'affinity',
    items: options.items || []
  });

  pack.payload.packType = 'affinity';
  if (options.thresholds) {
    pack.payload.thresholds = options.thresholds;
  }
  if (options.clusters) {
    pack.payload.clusters = options.clusters;
  }

  // Compute aggregations
  const items = pack.payload.items;
  const thresholds = pack.payload.thresholds || { strong: 0.8, moderate: 0.5, weak: 0.2 };

  const byType = items.reduce((acc, item) => {
    acc[item.affinityType] = (acc[item.affinityType] || 0) + 1;
    return acc;
  }, {});

  const byStrength = {
    strong: items.filter(i => i.score >= thresholds.strong).length,
    moderate: items.filter(i => i.score >= thresholds.moderate && i.score < thresholds.strong).length,
    weak: items.filter(i => i.score >= thresholds.weak && i.score < thresholds.moderate).length
  };

  // Find top entities by affinity count
  const entityCounts = {};
  items.forEach(item => {
    const sourceKey = `${item.sourceType}:${item.sourceId}`;
    const targetKey = `${item.targetType}:${item.targetId}`;
    entityCounts[sourceKey] = entityCounts[sourceKey] || { id: item.sourceId, name: item.sourceName, count: 0 };
    entityCounts[targetKey] = entityCounts[targetKey] || { id: item.targetId, name: item.targetName, count: 0 };
    entityCounts[sourceKey].count++;
    entityCounts[targetKey].count++;
  });

  const topEntities = Object.values(entityCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(e => ({
      entityId: e.id,
      entityName: e.name,
      affinityCount: e.count
    }));

  pack.payload.aggregations = {
    totalAffinities: items.length,
    byType,
    byStrength,
    averageScore: items.length > 0
      ? items.reduce((sum, item) => sum + item.score, 0) / items.length
      : 0,
    clusterCount: pack.payload.clusters?.length || 0,
    topEntities
  };

  // Build indexes for fast lookup
  pack.payload.indexes = {
    bySource: {},
    byTarget: {},
    byType: {}
  };

  items.forEach((item, index) => {
    const sourceKey = `${item.sourceType}:${item.sourceId}`;
    const targetKey = `${item.targetType}:${item.targetId}`;

    if (!pack.payload.indexes.bySource[sourceKey]) {
      pack.payload.indexes.bySource[sourceKey] = [];
    }
    pack.payload.indexes.bySource[sourceKey].push(index);

    if (!pack.payload.indexes.byTarget[targetKey]) {
      pack.payload.indexes.byTarget[targetKey] = [];
    }
    pack.payload.indexes.byTarget[targetKey].push(index);

    if (!pack.payload.indexes.byType[item.affinityType]) {
      pack.payload.indexes.byType[item.affinityType] = [];
    }
    pack.payload.indexes.byType[item.affinityType].push(index);
  });

  return pack;
}

/**
 * Add affinity item
 */
export function addAffinityItem(pack, item) {
  if (pack.payload.status !== 'draft') {
    throw new Error('Cannot modify non-draft pack');
  }

  pack.payload.items.push(item);
  pack.payload.itemCount = pack.payload.items.length;
  pack.payload.updatedAt = new Date().toISOString();

  return item;
}

/**
 * Get affinities for an entity
 */
export function getAffinitiesForEntity(pack, entityId, entityType) {
  const key = `${entityType}:${entityId}`;
  const sourceIndexes = pack.payload.indexes?.bySource?.[key] || [];
  const targetIndexes = pack.payload.indexes?.byTarget?.[key] || [];

  const indexes = [...new Set([...sourceIndexes, ...targetIndexes])];
  return indexes.map(i => pack.payload.items[i]);
}

/**
 * Get strong affinities
 */
export function getStrongAffinities(pack) {
  const threshold = pack.payload.thresholds?.strong || 0.8;
  return pack.payload.items.filter(item => item.score >= threshold);
}

/**
 * Find affinity path between two entities
 */
export function findAffinityPath(pack, sourceId, targetId, maxDepth = 3) {
  // BFS to find path
  const visited = new Set();
  const queue = [{ id: sourceId, path: [] }];

  while (queue.length > 0) {
    const { id, path } = queue.shift();

    if (id === targetId && path.length > 0) {
      return path;
    }

    if (path.length >= maxDepth || visited.has(id)) {
      continue;
    }

    visited.add(id);

    // Find all affinities from this entity
    const affinities = pack.payload.items.filter(
      item => item.sourceId === id || (item.bidirectional && item.targetId === id)
    );

    for (const aff of affinities) {
      const nextId = aff.sourceId === id ? aff.targetId : aff.sourceId;
      if (!visited.has(nextId)) {
        queue.push({
          id: nextId,
          path: [...path, aff]
        });
      }
    }
  }

  return null; // No path found
}

/**
 * Validate an affinity pack
 */
export function validateAffinityPack(pack) {
  return AffinityPackPayloadSchema.safeParse(pack.payload);
}

// Register schema on load
try {
  registerSchema(SchemaIds.PACK_AFFINITY, '1.0.0', AffinityPackPayloadSchema);
} catch (e) {
  // Already registered
}

export default AffinityPackPayloadSchema;
