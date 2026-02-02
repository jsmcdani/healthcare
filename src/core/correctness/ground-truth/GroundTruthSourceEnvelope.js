/**
 * GroundTruthSourceEnvelope - Contract for authoritative external knowledge sources
 *
 * Tracks ground truth sources like terminology systems (ICD-10, SNOMED CT),
 * drug databases (RxNorm, First Databank), clinical guidelines, and reference ranges.
 * These sources anchor correctness claims to external authority.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../contracts/schema-ids.js';

/**
 * Ground truth source types
 */
export const GroundTruthSourceTypeSchema = z.enum([
  'terminology',       // ICD-10, SNOMED CT, LOINC, CPT
  'drug_data',         // RxNorm, First Databank, Medi-Span, Drugs@FDA
  'guideline',         // NICE, AHA, USPSTF, IDSA clinical guidelines
  'reference_range',   // Lab reference ranges by demographics
  'formulary',         // Insurance formulary lists
  'contraindication',  // Drug-drug, drug-condition interactions
  'regulatory'         // FDA, CMS regulations
]).describe('Type of ground truth source');

/**
 * Ground truth source types as constants
 */
export const GroundTruthSourceTypes = {
  TERMINOLOGY: 'terminology',
  DRUG_DATA: 'drug_data',
  GUIDELINE: 'guideline',
  REFERENCE_RANGE: 'reference_range',
  FORMULARY: 'formulary',
  CONTRAINDICATION: 'contraindication',
  REGULATORY: 'regulatory'
};

/**
 * Update frequency options
 */
export const UpdateFrequencySchema = z.enum([
  'realtime',    // Continuous updates
  'daily',       // Daily updates
  'weekly',      // Weekly updates
  'monthly',     // Monthly updates
  'quarterly',   // Quarterly updates (e.g., ICD updates)
  'annual',      // Annual updates
  'as_published' // Updates when new version published
]).describe('How frequently the source is updated');

/**
 * Source adapter configuration
 */
export const AdapterConfigSchema = z.object({
  adapterType: z.enum(['rest_api', 'fhir', 'database', 'file', 'embedded'])
    .describe('Type of adapter for querying this source'),
  adapterClass: z.string()
    .describe('Fully qualified adapter class name'),
  connectionRef: z.string().optional()
    .describe('Reference to secure connection configuration'),
  timeout: z.number().int().positive().default(30000)
    .describe('Query timeout in milliseconds'),
  cachePolicy: z.object({
    enabled: z.boolean().default(true),
    ttlSeconds: z.number().int().positive().default(3600),
    invalidateOn: z.array(z.string()).optional()
  }).optional()
});

/**
 * Quality and certification info
 */
export const SourceQualitySchema = z.object({
  certifications: z.array(z.string()).optional()
    .describe('Certifications (e.g., ONC certified, HIPAA compliant)'),
  accuracyBenchmark: z.number().min(0).max(1).optional()
    .describe('Published accuracy benchmark'),
  coverage: z.string().optional()
    .describe('Coverage description (e.g., "US medications", "ICD-10-CM 2024")'),
  knownLimitations: z.array(z.string()).optional()
    .describe('Known limitations or gaps in the source')
});

/**
 * Ground truth source payload
 */
export const GroundTruthSourcePayloadSchema = z.object({
  sourceId: z.string().describe('Unique source identifier'),
  name: z.string().describe('Human-readable source name'),
  type: GroundTruthSourceTypeSchema,

  // Versioning
  version: z.string().describe('Source version (e.g., "2024.1")'),
  effectiveDate: z.string().datetime()
    .describe('When this version became effective'),
  expirationDate: z.string().datetime().optional()
    .describe('When this version expires (if known)'),

  // Provenance
  publisher: z.string().describe('Organization publishing this source'),
  licenseType: z.string().describe('License type (e.g., "UMLS", "proprietary", "open")'),
  attribution: z.string().optional()
    .describe('Required attribution text'),

  // Update info
  updateFrequency: UpdateFrequencySchema,
  lastUpdated: z.string().datetime()
    .describe('When the source data was last updated'),
  nextExpectedUpdate: z.string().datetime().optional(),

  // Access configuration
  adapter: AdapterConfigSchema,

  // Quality metrics
  quality: SourceQualitySchema.optional(),

  // Status
  status: z.enum(['active', 'deprecated', 'pending', 'error']).default('active'),

  // Usage tracking
  queryCount: z.number().int().default(0),
  lastQueried: z.string().datetime().optional(),

  // Metadata
  tags: z.array(z.string()).optional(),
  description: z.string().optional()
});

/**
 * Full Ground Truth Source Envelope
 */
export const GroundTruthSourceEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: GroundTruthSourcePayloadSchema,
  _meta: z.object({
    registeredAt: z.string().datetime(),
    registeredBy: z.string().optional(),
    lastHealthCheck: z.string().datetime().optional(),
    isHealthy: z.boolean().default(true)
  }).optional()
});

/**
 * Create a ground truth source envelope
 */
export function createGroundTruthSourceEnvelope(options) {
  const {
    sourceId,
    name,
    type,
    version,
    effectiveDate,
    expirationDate,
    publisher,
    licenseType,
    attribution,
    updateFrequency,
    lastUpdated,
    nextExpectedUpdate,
    adapter,
    quality,
    status,
    tags,
    description,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.GROUND_TRUTH_SOURCE,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'register_ground_truth_source',
    source: 'GroundTruthRegistry',
    traceId
  });

  const now = new Date().toISOString();

  return {
    header,
    payload: {
      sourceId,
      name,
      type,
      version,
      effectiveDate: effectiveDate || now,
      expirationDate,
      publisher,
      licenseType,
      attribution,
      updateFrequency,
      lastUpdated: lastUpdated || now,
      nextExpectedUpdate,
      adapter,
      quality,
      status: status || 'active',
      queryCount: 0,
      tags,
      description
    },
    _meta: {
      registeredAt: now,
      registeredBy: userId,
      isHealthy: true
    }
  };
}

/**
 * Validate a ground truth source envelope
 */
export function validateGroundTruthSource(envelope) {
  return GroundTruthSourceEnvelopeSchema.safeParse(envelope);
}

export default GroundTruthSourceEnvelopeSchema;
