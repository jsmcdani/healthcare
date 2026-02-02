/**
 * CorrectnessEnvelope - Wraps decision artifacts with correctness metadata
 *
 * Every decision/output gains a correctness envelope that documents:
 * - What assertions were checked
 * - What evidence supports the claims
 * - What the uncertainty bounds are
 * - Whether expert review is required
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../contracts/EnvelopeHeader.js';
import { SchemaIds } from '../contracts/schema-ids.js';
import { CorrectnessAssertionEnvelopeSchema } from './assertions/CorrectnessAssertionEnvelope.js';

/**
 * Correctness status levels
 */
export const CorrectnessStatusSchema = z.enum([
  'VALIDATED',           // All assertions passed
  'PARTIALLY_VALIDATED', // Some assertions passed, some couldn't be checked
  'UNVALIDATED',         // No assertions could be checked
  'FAILED',              // One or more assertions failed
  'REQUIRES_REVIEW'      // Confidence below threshold, needs human review
]).describe('Overall correctness validation status');

export const CorrectnessStatus = {
  VALIDATED: 'VALIDATED',
  PARTIALLY_VALIDATED: 'PARTIALLY_VALIDATED',
  UNVALIDATED: 'UNVALIDATED',
  FAILED: 'FAILED',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW'
};

/**
 * Uncertainty levels
 */
export const UncertaintyLevelSchema = z.enum([
  'CERTAIN',          // High confidence, deterministic
  'HIGH_CONFIDENCE',  // Very confident
  'MODERATE',         // Some uncertainty
  'LOW_CONFIDENCE',   // Significant uncertainty
  'UNCERTAIN'         // Cannot reliably assess
]).describe('Level of uncertainty in the assessment');

export const UncertaintyLevel = {
  CERTAIN: 'CERTAIN',
  HIGH_CONFIDENCE: 'HIGH_CONFIDENCE',
  MODERATE: 'MODERATE',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  UNCERTAIN: 'UNCERTAIN'
};

/**
 * Target reference (what this envelope validates)
 */
export const TargetRefSchema = z.object({
  artifactId: z.string().describe('ID of the decision artifact'),
  artifactType: z.string().describe('Type of artifact (e.g., DecisionArtifact, RecipeOutput)'),
  outputField: z.string().optional()
    .describe('Specific field within the artifact being validated')
});

/**
 * Ground truth source reference
 */
export const GroundTruthRefSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string().optional(),
  version: z.string().optional(),
  queriedAt: z.string().datetime()
});

/**
 * Uncertainty details
 */
export const UncertaintyDetailsSchema = z.object({
  level: UncertaintyLevelSchema,
  factors: z.array(z.string())
    .describe('What contributes to uncertainty'),
  recommendation: z.string().optional()
    .describe('Recommendation for handling uncertainty')
});

/**
 * Assessment metrics
 */
export const AssessmentMetricsSchema = z.object({
  totalAssertions: z.number().int(),
  passedAssertions: z.number().int(),
  failedAssertions: z.number().int(),
  uncheckableAssertions: z.number().int(),
  overallConfidence: z.number().min(0).max(1),
  criticalFailures: z.number().int().default(0)
});

/**
 * Review requirement
 */
export const ReviewRequirementSchema = z.object({
  required: z.boolean(),
  reason: z.string().optional(),
  reviewerRole: z.string().optional()
    .describe('Required reviewer role (e.g., clinical_pharmacist, physician)'),
  deadline: z.string().datetime().optional(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected', 'waived']).optional(),
  reviewId: z.string().optional()
    .describe('Reference to ExpertReview if created')
});

/**
 * Calibration reference
 */
export const CalibrationRefSchema = z.object({
  benchmarkId: z.string().optional(),
  benchmarkScore: z.number().min(0).max(1).optional(),
  deviationFromExpected: z.number().optional(),
  calibrationRunId: z.string().optional()
});

/**
 * Correctness assessment
 */
export const CorrectnessAssessmentSchema = z.object({
  // Overall status
  status: CorrectnessStatusSchema,

  // Assertion results
  assertions: z.array(CorrectnessAssertionEnvelopeSchema),

  // Summary metrics
  metrics: AssessmentMetricsSchema,

  // Evidence provenance
  groundTruthSources: z.array(GroundTruthRefSchema),

  // Uncertainty quantification
  uncertainty: UncertaintyDetailsSchema
});

/**
 * Correctness Envelope Payload
 */
export const CorrectnessEnvelopePayloadSchema = z.object({
  // Reference to what this validates
  targetRef: TargetRefSchema,

  // The assessment
  assessment: CorrectnessAssessmentSchema,

  // Review requirements
  reviewRequirement: ReviewRequirementSchema.optional(),

  // Calibration reference
  calibration: CalibrationRefSchema.optional(),

  // Overall verdict
  verdict: z.object({
    canProceed: z.boolean()
      .describe('Whether the output is safe to use'),
    blockedBy: z.array(z.string()).optional()
      .describe('List of blocking issues if cannot proceed'),
    warnings: z.array(z.string()).optional()
      .describe('Non-blocking warnings')
  })
});

/**
 * Full Correctness Envelope
 */
export const CorrectnessEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: CorrectnessEnvelopePayloadSchema,
  _meta: z.object({
    evaluatedAt: z.string().datetime(),
    evaluationDurationMs: z.number().optional(),
    evaluatorVersion: z.string().optional()
  }).optional()
});

/**
 * Create a correctness envelope
 */
export function createCorrectnessEnvelope(options) {
  const {
    targetRef,
    assertions,
    status,
    groundTruthSources = [],
    uncertainty,
    reviewRequirement,
    calibration,
    userId,
    sessionId,
    traceId,
    evaluationDurationMs
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.CORRECTNESS_ENVELOPE,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'evaluate_correctness',
    source: 'CorrectnessEvaluator',
    traceId
  });

  // Calculate metrics from assertions
  const metrics = calculateMetrics(assertions);

  // Determine verdict
  const verdict = determineVerdict(status, metrics, reviewRequirement);

  const now = new Date().toISOString();

  return {
    header,
    payload: {
      targetRef,
      assessment: {
        status,
        assertions,
        metrics,
        groundTruthSources,
        uncertainty: uncertainty || calculateUncertainty(metrics)
      },
      reviewRequirement,
      calibration,
      verdict
    },
    _meta: {
      evaluatedAt: now,
      evaluationDurationMs,
      evaluatorVersion: '1.0.0'
    }
  };
}

/**
 * Calculate metrics from assertions
 */
function calculateMetrics(assertions) {
  const total = assertions.length;
  let passed = 0;
  let failed = 0;
  let uncheckable = 0;
  let criticalFailures = 0;
  let totalConfidence = 0;
  let confidenceCount = 0;

  for (const assertion of assertions) {
    const result = assertion.payload?.result;

    if (!result || !assertion._meta?.validationAttempted) {
      uncheckable++;
      continue;
    }

    if (result.valid) {
      passed++;
    } else {
      failed++;

      // Check for critical failures
      const severity = assertion.payload?.severity;
      if (severity === 'critical') {
        criticalFailures++;
      }
    }

    // Accumulate confidence
    if (typeof result.confidence === 'number') {
      totalConfidence += result.confidence;
      confidenceCount++;
    }
  }

  return {
    totalAssertions: total,
    passedAssertions: passed,
    failedAssertions: failed,
    uncheckableAssertions: uncheckable,
    overallConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
    criticalFailures
  };
}

/**
 * Calculate uncertainty from metrics
 */
function calculateUncertainty(metrics) {
  const confidence = metrics.overallConfidence;
  const factors = [];

  // Determine level
  let level;
  if (confidence >= 0.95) {
    level = UncertaintyLevel.CERTAIN;
  } else if (confidence >= 0.85) {
    level = UncertaintyLevel.HIGH_CONFIDENCE;
  } else if (confidence >= 0.65) {
    level = UncertaintyLevel.MODERATE;
  } else if (confidence >= 0.4) {
    level = UncertaintyLevel.LOW_CONFIDENCE;
  } else {
    level = UncertaintyLevel.UNCERTAIN;
  }

  // Identify factors
  if (metrics.uncheckableAssertions > 0) {
    factors.push(`${metrics.uncheckableAssertions} assertion(s) could not be validated`);
  }
  if (confidence < 0.7) {
    factors.push('Low average validation confidence');
  }
  if (metrics.totalAssertions === 0) {
    factors.push('No assertions to validate');
  }

  // Recommendation
  let recommendation;
  if (level === UncertaintyLevel.UNCERTAIN || level === UncertaintyLevel.LOW_CONFIDENCE) {
    recommendation = 'Expert review recommended before proceeding';
  } else if (factors.length > 0) {
    recommendation = 'Review uncertainty factors before proceeding';
  }

  return { level, factors, recommendation };
}

/**
 * Determine verdict from assessment
 */
function determineVerdict(status, metrics, reviewRequirement) {
  const blockedBy = [];
  const warnings = [];

  // Critical failures block
  if (metrics.criticalFailures > 0) {
    blockedBy.push(`${metrics.criticalFailures} critical assertion(s) failed`);
  }

  // Review required blocks
  if (reviewRequirement?.required && reviewRequirement.reviewStatus !== 'approved') {
    blockedBy.push('Expert review required');
  }

  // Add warnings
  if (metrics.failedAssertions > metrics.criticalFailures) {
    warnings.push(`${metrics.failedAssertions - metrics.criticalFailures} non-critical assertion(s) failed`);
  }
  if (metrics.uncheckableAssertions > 0) {
    warnings.push(`${metrics.uncheckableAssertions} assertion(s) could not be checked`);
  }
  if (status === CorrectnessStatus.PARTIALLY_VALIDATED) {
    warnings.push('Only partial validation achieved');
  }

  return {
    canProceed: blockedBy.length === 0,
    blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Validate a correctness envelope
 */
export function validateCorrectnessEnvelope(envelope) {
  return CorrectnessEnvelopeSchema.safeParse(envelope);
}

/**
 * Get correctness status from metrics
 */
export function getStatusFromMetrics(metrics) {
  if (metrics.criticalFailures > 0) {
    return CorrectnessStatus.FAILED;
  }
  if (metrics.totalAssertions === 0) {
    return CorrectnessStatus.UNVALIDATED;
  }
  if (metrics.failedAssertions > 0) {
    return CorrectnessStatus.FAILED;
  }
  if (metrics.uncheckableAssertions > 0) {
    return CorrectnessStatus.PARTIALLY_VALIDATED;
  }
  if (metrics.overallConfidence < 0.7) {
    return CorrectnessStatus.REQUIRES_REVIEW;
  }
  return CorrectnessStatus.VALIDATED;
}

export default CorrectnessEnvelopeSchema;
