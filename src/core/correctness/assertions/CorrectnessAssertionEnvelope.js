/**
 * CorrectnessAssertionEnvelope - Contract for testable correctness claims
 *
 * Assertions are statements that can be validated against ground truth.
 * Each assertion has a claim, evidence basis, and validation result.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../contracts/schema-ids.js';

/**
 * Assertion types
 */
export const AssertionTypeSchema = z.enum([
  'CODE_VALID',           // Code exists in terminology
  'VALUE_IN_RANGE',       // Value within reference range
  'NO_CONTRAINDICATION',  // No drug/condition conflicts
  'GUIDELINE_ALIGNED',    // Matches clinical guideline
  'LOGICAL_CONSISTENT',   // No internal contradictions
  'TEMPORALLY_VALID',     // Timing makes clinical sense
  'COMPLETENESS',         // Required elements present
  'SEMANTIC_MATCH',       // Meaning alignment between terms
  'DOSAGE_APPROPRIATE',   // Dosage within safe limits
  'CUSTOM'                // Custom assertion type
]).describe('Type of correctness assertion');

/**
 * Assertion types as constants
 */
export const AssertionTypes = {
  CODE_VALID: 'CODE_VALID',
  VALUE_IN_RANGE: 'VALUE_IN_RANGE',
  NO_CONTRAINDICATION: 'NO_CONTRAINDICATION',
  GUIDELINE_ALIGNED: 'GUIDELINE_ALIGNED',
  LOGICAL_CONSISTENT: 'LOGICAL_CONSISTENT',
  TEMPORALLY_VALID: 'TEMPORALLY_VALID',
  COMPLETENESS: 'COMPLETENESS',
  SEMANTIC_MATCH: 'SEMANTIC_MATCH',
  DOSAGE_APPROPRIATE: 'DOSAGE_APPROPRIATE',
  CUSTOM: 'CUSTOM'
};

/**
 * Assertion severity levels
 */
export const AssertionSeveritySchema = z.enum([
  'critical',   // Must pass - failure blocks processing
  'major',      // Should pass - failure requires attention
  'minor',      // Nice to pass - failure is informational
  'advisory'    // Informational only
]).describe('Severity level of assertion failure');

export const AssertionSeverity = {
  CRITICAL: 'critical',
  MAJOR: 'major',
  MINOR: 'minor',
  ADVISORY: 'advisory'
};

/**
 * Validation method
 */
export const ValidationMethodSchema = z.enum([
  'automated',       // Validated by automated system
  'expert_review',   // Validated by human expert
  'calibration_match', // Validated against calibration benchmark
  'ground_truth',    // Validated against ground truth source
  'policy_rule'      // Validated by policy engine
]);

/**
 * Claim structure - what is being asserted
 */
export const AssertionClaimSchema = z.object({
  subject: z.string().describe('What entity (patient, medication, diagnosis)'),
  predicate: z.string().describe('What property or relationship'),
  object: z.any().describe('Expected value or state'),
  context: z.record(z.any()).optional()
    .describe('Additional context for the claim')
});

/**
 * Evidence supporting the assertion
 */
export const EvidenceBasisSchema = z.object({
  sourceId: z.string().describe('Ground truth source ID'),
  sourceVersion: z.string().optional(),
  sourceName: z.string().optional(),
  queryUsed: z.string().optional()
    .describe('Query or method used to retrieve evidence'),
  queryResult: z.any().optional()
    .describe('Raw result from the source'),
  resultSummary: z.string()
    .describe('Human-readable summary of evidence'),
  confidence: z.number().min(0).max(1)
    .describe('Confidence in this evidence')
});

/**
 * Violation detail when assertion fails
 */
export const ViolationSchema = z.object({
  code: z.string().describe('Machine-readable violation code'),
  message: z.string().describe('Human-readable violation message'),
  severity: AssertionSeveritySchema,
  groundTruthRef: z.string().optional()
    .describe('Reference to ground truth that contradicts assertion'),
  details: z.record(z.any()).optional()
    .describe('Additional violation details')
});

/**
 * Uncertainty bounds
 */
export const UncertaintyBoundsSchema = z.object({
  lower: z.number().min(0).max(1).describe('Lower confidence bound'),
  upper: z.number().min(0).max(1).describe('Upper confidence bound'),
  distribution: z.enum(['uniform', 'normal', 'beta']).optional()
    .describe('Assumed distribution')
});

/**
 * Validation result
 */
export const ValidationResultSchema = z.object({
  valid: z.boolean().describe('Whether assertion passed validation'),
  validatedAt: z.string().datetime(),
  validatedBy: ValidationMethodSchema,

  // If invalid
  violations: z.array(ViolationSchema).optional()
    .describe('Violations found if assertion failed'),

  // Uncertainty quantification
  confidence: z.number().min(0).max(1)
    .describe('Confidence in validation result'),
  uncertaintyBounds: UncertaintyBoundsSchema.optional(),

  // Additional info
  notes: z.string().optional(),
  durationMs: z.number().optional()
});

/**
 * Correctness Assertion Payload
 */
export const CorrectnessAssertionPayloadSchema = z.object({
  assertionId: z.string().uuid().describe('Unique assertion identifier'),
  assertionType: AssertionTypeSchema,

  // The claim being made
  claim: AssertionClaimSchema,

  // Evidence supporting the assertion
  evidenceBasis: z.array(EvidenceBasisSchema)
    .describe('Evidence from ground truth sources'),

  // Validation result (populated after validation)
  result: ValidationResultSchema.optional(),

  // Metadata
  severity: AssertionSeveritySchema.default('major'),
  description: z.string().optional()
    .describe('Human-readable description of what is being asserted'),
  tags: z.array(z.string()).optional()
});

/**
 * Full Correctness Assertion Envelope
 */
export const CorrectnessAssertionEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: CorrectnessAssertionPayloadSchema,
  _meta: z.object({
    createdAt: z.string().datetime(),
    validationAttempted: z.boolean(),
    sourceArtifactId: z.string().optional()
  }).optional()
});

/**
 * Create a correctness assertion envelope
 */
export function createCorrectnessAssertion(options) {
  const {
    assertionType,
    claim,
    evidenceBasis = [],
    severity = AssertionSeverity.MAJOR,
    description,
    tags,
    userId,
    sessionId,
    traceId,
    sourceArtifactId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.CORRECTNESS_ASSERTION,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'create_assertion',
    source: 'AssertionEngine',
    traceId
  });

  const now = new Date().toISOString();

  return {
    header,
    payload: {
      assertionId: crypto.randomUUID(),
      assertionType,
      claim,
      evidenceBasis,
      severity,
      description,
      tags
    },
    _meta: {
      createdAt: now,
      validationAttempted: false,
      sourceArtifactId
    }
  };
}

/**
 * Create a validation result
 */
export function createValidationResult(options) {
  const {
    valid,
    validatedBy,
    violations = [],
    confidence = valid ? 1.0 : 0.0,
    uncertaintyBounds,
    notes,
    durationMs
  } = options;

  return {
    valid,
    validatedAt: new Date().toISOString(),
    validatedBy,
    violations: valid ? undefined : violations,
    confidence,
    uncertaintyBounds,
    notes,
    durationMs
  };
}

/**
 * Create a violation
 */
export function createViolation(code, message, severity, details = {}) {
  return {
    code,
    message,
    severity,
    ...details
  };
}

/**
 * Validate an assertion envelope
 */
export function validateCorrectnessAssertion(envelope) {
  return CorrectnessAssertionEnvelopeSchema.safeParse(envelope);
}

export default CorrectnessAssertionEnvelopeSchema;
