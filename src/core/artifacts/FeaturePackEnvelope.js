/**
 * FeaturePackEnvelope - Base envelope for all feature packs
 *
 * Feature packs contain computed/derived data from offline analysis.
 * They are immutable once published.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../contracts/EnvelopeHeader.js';
import { registerSchema, SchemaIds } from '../contracts/registry.js';
import {
  BaseArtifactPayloadSchema,
  RiskClassificationSchema,
  EvidenceRefSchema
} from './BaseArtifact.js';

/**
 * Pack computation metadata
 */
export const ComputationMetadataSchema = z.object({
  computedAt: z.string().datetime(),
  computedBy: z.string().describe('Recipe or agent that computed this pack'),
  computeDurationMs: z.number().optional(),
  inputArtifactRefs: z.array(z.string()).optional().describe('Artifacts used as input'),
  algorithm: z.string().optional().describe('Algorithm used for computation'),
  algorithmVersion: z.string().optional()
});

/**
 * Pack data quality metrics
 */
export const DataQualitySchema = z.object({
  completeness: z.number().min(0).max(1).optional().describe('Fraction of data present'),
  accuracy: z.number().min(0).max(1).optional().describe('Estimated accuracy'),
  freshness: z.string().datetime().optional().describe('Data freshness timestamp'),
  coverage: z.number().min(0).max(1).optional().describe('Coverage of target domain'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence in results')
});

/**
 * Feature Pack payload
 */
export const FeaturePackPayloadSchema = BaseArtifactPayloadSchema.extend({
  artifactType: z.literal('feature_pack'),
  packType: z.string().describe('Type of pack (e.g., "hotspot", "coverage", "affinity")'),
  computation: ComputationMetadataSchema,
  dataQuality: DataQualitySchema.optional(),
  itemCount: z.number().optional().describe('Number of items in the pack'),
  items: z.array(z.any()).describe('Pack items (type depends on packType)'),
  aggregations: z.record(z.any()).optional().describe('Pre-computed aggregations'),
  indexes: z.record(z.any()).optional().describe('Lookup indexes for fast access')
});

/**
 * Full Feature Pack Envelope
 */
export const FeaturePackEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: FeaturePackPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a feature pack
 */
export function createFeaturePack(options) {
  const {
    name,
    description,
    version = '1.0.0',
    orgId,
    createdBy,
    packType,
    items = [],
    computation,
    dataQuality,
    aggregations,
    indexes,
    evidenceRefs,
    tags,
    traceId
  } = options;

  const now = new Date().toISOString();

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.ARTIFACT_PACK,
    schemaVersion: '1.0.0',
    userId: createdBy,
    action: 'create_pack',
    source: 'PackFactory',
    traceId
  });

  return {
    header,
    payload: {
      artifactId: crypto.randomUUID(),
      artifactType: 'feature_pack',
      name,
      description,
      version,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      createdBy,
      orgId,
      tags,
      riskClassification: 'LOW', // Packs are derived data, generally safe
      evidenceRefs,
      packType,
      computation: computation || {
        computedAt: now,
        computedBy: 'manual'
      },
      dataQuality,
      itemCount: items.length,
      items,
      aggregations,
      indexes
    },
    _meta: {
      validated: true,
      validatedAt: now
    }
  };
}

/**
 * Add items to a pack (only if draft)
 */
export function addPackItems(pack, items) {
  if (pack.payload.status !== 'draft') {
    throw new Error('Cannot modify non-draft pack');
  }

  pack.payload.items.push(...items);
  pack.payload.itemCount = pack.payload.items.length;
  pack.payload.updatedAt = new Date().toISOString();

  return pack;
}

/**
 * Finalize a pack (set to pending for review)
 */
export function finalizePack(pack) {
  pack.payload.status = 'pending';
  pack.payload.updatedAt = new Date().toISOString();
  return pack;
}

/**
 * Validate a feature pack
 */
export function validateFeaturePack(pack) {
  return FeaturePackEnvelopeSchema.safeParse(pack);
}

// Register schema on load
try {
  registerSchema(SchemaIds.ARTIFACT_PACK, '1.0.0', FeaturePackEnvelopeSchema);
} catch (e) {
  // Already registered
}

export default FeaturePackEnvelopeSchema;
