/**
 * BaseArtifact - Common schema for all artifacts
 *
 * All artifacts (profiles, packs, proposals, reports) extend this base.
 * Provides: id, timestamp, version, auditTrace, evidenceRefs, riskClassification
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../contracts/EnvelopeHeader.js';
import { registerSchema, SchemaIds } from '../contracts/registry.js';

/**
 * Risk classification for artifacts
 */
export const RiskClassificationSchema = z.enum([
  'LOW',       // Safe to auto-publish
  'MEDIUM',    // Review recommended
  'HIGH',      // Approval required
  'CRITICAL'   // Multiple approvals required
]).describe('Risk classification of the artifact');

/**
 * Evidence reference - links to supporting data
 */
export const EvidenceRefSchema = z.object({
  refId: z.string().describe('Reference identifier'),
  refType: z.enum(['step_output', 'query_result', 'external_doc', 'prior_artifact']),
  uri: z.string().optional().describe('URI to evidence if external'),
  hash: z.string().optional().describe('Content hash for verification'),
  description: z.string().optional()
});

/**
 * Artifact lifecycle status
 */
export const ArtifactStatusSchema = z.enum([
  'draft',      // In progress, not finalized
  'pending',    // Awaiting review/approval
  'approved',   // Approved, ready for publication
  'published',  // Published and active
  'deprecated', // Superseded by newer version
  'archived'    // No longer active
]).describe('Artifact lifecycle status');

/**
 * Base artifact payload - common to all artifact types
 */
export const BaseArtifactPayloadSchema = z.object({
  artifactId: z.string().uuid().describe('Unique artifact identifier'),
  artifactType: z.string().describe('Type of artifact (e.g., "profile", "pack", "proposal")'),
  name: z.string().describe('Human-readable artifact name'),
  description: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).describe('Artifact content version (semver)'),
  status: ArtifactStatusSchema.default('draft'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().optional(),
  orgId: z.string().describe('Organization this artifact belongs to'),
  tags: z.array(z.string()).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).optional().describe('References to supporting evidence'),
  riskClassification: RiskClassificationSchema.optional(),
  metadata: z.record(z.any()).optional().describe('Additional type-specific metadata')
});

/**
 * Full Base Artifact Envelope
 */
export const BaseArtifactEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: BaseArtifactPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a base artifact envelope
 */
export function createBaseArtifact(options) {
  const {
    artifactType,
    name,
    description,
    version = '1.0.0',
    status = 'draft',
    orgId,
    createdBy,
    tags,
    evidenceRefs,
    riskClassification,
    metadata,
    traceId
  } = options;

  const now = new Date().toISOString();

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.ARTIFACT_BASE,
    schemaVersion: '1.0.0',
    userId: createdBy,
    action: 'create_artifact',
    source: 'ArtifactFactory',
    traceId
  });

  return {
    header,
    payload: {
      artifactId: crypto.randomUUID(),
      artifactType,
      name,
      description,
      version,
      status,
      createdAt: now,
      updatedAt: now,
      createdBy,
      orgId,
      tags,
      evidenceRefs,
      riskClassification,
      metadata
    },
    _meta: {
      validated: true,
      validatedAt: now
    }
  };
}

/**
 * Helper to extend base artifact with additional fields
 */
export function extendArtifactSchema(additionalFields) {
  return z.object({
    header: EnvelopeHeaderSchema,
    payload: BaseArtifactPayloadSchema.extend(additionalFields),
    _meta: z.object({
      validated: z.boolean(),
      validatedAt: z.string().datetime()
    }).optional()
  });
}

/**
 * Validate a base artifact
 */
export function validateBaseArtifact(artifact) {
  return BaseArtifactEnvelopeSchema.safeParse(artifact);
}

// Register schema on load
try {
  registerSchema(SchemaIds.ARTIFACT_BASE, '1.0.0', BaseArtifactEnvelopeSchema);
} catch (e) {
  // Already registered
}

export default BaseArtifactEnvelopeSchema;
