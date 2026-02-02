/**
 * ExpertReviewEnvelope - Contract for expert review requests and outcomes
 *
 * Routes outputs below confidence thresholds to domain experts,
 * captures their decisions, and maintains audit trail.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../contracts/schema-ids.js';

/**
 * Review trigger types
 */
export const ReviewTriggerTypeSchema = z.enum([
  'low_confidence',        // Confidence below threshold
  'assertion_failure',     // One or more assertions failed
  'llm_output',           // LLM-generated clinical content
  'novel_scenario',       // No similar prior decisions
  'calibration_deviation', // Deviation from expected benchmark
  'policy_required',      // Policy mandates review
  'manual_request'        // User requested review
]).describe('What triggered the need for review');

export const ReviewTriggerType = {
  LOW_CONFIDENCE: 'low_confidence',
  ASSERTION_FAILURE: 'assertion_failure',
  LLM_OUTPUT: 'llm_output',
  NOVEL_SCENARIO: 'novel_scenario',
  CALIBRATION_DEVIATION: 'calibration_deviation',
  POLICY_REQUIRED: 'policy_required',
  MANUAL_REQUEST: 'manual_request'
};

/**
 * Reviewer roles
 */
export const ReviewerRoleSchema = z.enum([
  'clinical_pharmacist',
  'physician',
  'nurse_specialist',
  'compliance_officer',
  'domain_expert',
  'medical_director',
  'supervisor'
]).describe('Required expertise for review');

export const ReviewerRole = {
  CLINICAL_PHARMACIST: 'clinical_pharmacist',
  PHYSICIAN: 'physician',
  NURSE_SPECIALIST: 'nurse_specialist',
  COMPLIANCE_OFFICER: 'compliance_officer',
  DOMAIN_EXPERT: 'domain_expert',
  MEDICAL_DIRECTOR: 'medical_director',
  SUPERVISOR: 'supervisor'
};

/**
 * Urgency levels
 */
export const UrgencyLevelSchema = z.enum([
  'routine',  // Standard processing time
  'urgent',   // Expedited review needed
  'stat'      // Immediate review required
]).describe('Urgency of the review');

export const UrgencyLevel = {
  ROUTINE: 'routine',
  URGENT: 'urgent',
  STAT: 'stat'
};

/**
 * Review decisions
 */
export const ReviewDecisionSchema = z.enum([
  'approve',    // Output is correct, can proceed
  'reject',     // Output is incorrect, cannot use
  'modify',     // Output needs modification (reviewer provides)
  'escalate'    // Needs higher-level review
]).describe('Expert decision on the reviewed output');

export const ReviewDecision = {
  APPROVE: 'approve',
  REJECT: 'reject',
  MODIFY: 'modify',
  ESCALATE: 'escalate'
};

/**
 * Review status
 */
export const ReviewStatusSchema = z.enum([
  'pending',      // Awaiting review
  'in_review',    // Being reviewed
  'approved',     // Approved
  'rejected',     // Rejected
  'modified',     // Approved with modifications
  'escalated',    // Escalated to higher authority
  'waived',       // Review waived (authorized)
  'expired'       // Review deadline passed
]).describe('Current status of the review');

export const ReviewStatus = {
  PENDING: 'pending',
  IN_REVIEW: 'in_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  MODIFIED: 'modified',
  ESCALATED: 'escalated',
  WAIVED: 'waived',
  EXPIRED: 'expired'
};

/**
 * Review target
 */
export const ReviewTargetSchema = z.object({
  artifactId: z.string().describe('ID of artifact being reviewed'),
  correctnessEnvelopeId: z.string().describe('ID of correctness envelope'),
  specificConcern: z.string().optional()
    .describe('Specific aspect requiring review'),
  outputSnapshot: z.any().optional()
    .describe('Snapshot of output for review context')
});

/**
 * Review trigger details
 */
export const ReviewTriggerSchema = z.object({
  type: ReviewTriggerTypeSchema,
  details: z.string().describe('Explanation of why review is needed'),
  threshold: z.number().optional()
    .describe('Threshold value that was not met'),
  actualValue: z.number().optional()
    .describe('Actual value that triggered review'),
  failedAssertions: z.array(z.string()).optional()
    .describe('IDs of failed assertions')
});

/**
 * Review requirements
 */
export const ReviewRequirementsSchema = z.object({
  reviewerRole: ReviewerRoleSchema,
  minimumReviewers: z.number().int().min(1).default(1),
  urgency: UrgencyLevelSchema,
  deadline: z.string().datetime().optional(),
  specialInstructions: z.string().optional()
});

/**
 * Individual reviewer decision
 */
export const ReviewerDecisionSchema = z.object({
  reviewerId: z.string(),
  reviewerName: z.string().optional(),
  role: ReviewerRoleSchema,
  decision: ReviewDecisionSchema,
  rationale: z.string().optional(),
  comments: z.string().optional(),
  timestamp: z.string().datetime(),
  timeSpentSeconds: z.number().int().optional()
});

/**
 * Review outcome
 */
export const ReviewOutcomeSchema = z.object({
  finalDecision: ReviewDecisionSchema.optional(),
  status: ReviewStatusSchema,
  reviewers: z.array(ReviewerDecisionSchema).optional(),
  modifiedOutput: z.any().optional()
    .describe('Modified output if decision is "modify"'),
  overallRationale: z.string().optional(),
  completedAt: z.string().datetime().optional(),
  escalatedTo: z.string().optional()
    .describe('ID of escalation review if escalated')
});

/**
 * Expert Review Payload
 */
export const ExpertReviewPayloadSchema = z.object({
  reviewId: z.string().uuid(),

  // What needs review
  target: ReviewTargetSchema,

  // Why review is needed
  trigger: ReviewTriggerSchema,

  // Review requirements
  requirements: ReviewRequirementsSchema,

  // Review outcome
  outcome: ReviewOutcomeSchema,

  // Audit
  requestedAt: z.string().datetime(),
  requestedBy: z.string().optional(),

  // Priority score (for queue ordering)
  priorityScore: z.number().int().min(0).max(100).optional()
});

/**
 * Full Expert Review Envelope
 */
export const ExpertReviewEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: ExpertReviewPayloadSchema,
  _meta: z.object({
    version: z.string().default('1.0.0'),
    parentReviewId: z.string().optional()
      .describe('If this is a re-review or escalation')
  }).optional()
});

/**
 * Create an expert review request
 */
export function createExpertReviewRequest(options) {
  const {
    target,
    trigger,
    reviewerRole,
    minimumReviewers = 1,
    urgency = UrgencyLevel.ROUTINE,
    deadline,
    specialInstructions,
    requestedBy,
    userId,
    sessionId,
    traceId,
    parentReviewId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.EXPERT_REVIEW,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'request_expert_review',
    source: 'ExpertReviewWorkflow',
    traceId
  });

  const now = new Date().toISOString();

  // Calculate priority score
  const priorityScore = calculatePriority(trigger, urgency);

  return {
    header,
    payload: {
      reviewId: crypto.randomUUID(),
      target,
      trigger,
      requirements: {
        reviewerRole,
        minimumReviewers,
        urgency,
        deadline,
        specialInstructions
      },
      outcome: {
        status: ReviewStatus.PENDING
      },
      requestedAt: now,
      requestedBy,
      priorityScore
    },
    _meta: {
      version: '1.0.0',
      parentReviewId
    }
  };
}

/**
 * Calculate priority score from trigger and urgency
 */
function calculatePriority(trigger, urgency) {
  let score = 50; // Base score

  // Adjust for urgency
  switch (urgency) {
    case UrgencyLevel.STAT: score += 40; break;
    case UrgencyLevel.URGENT: score += 20; break;
  }

  // Adjust for trigger type
  switch (trigger.type) {
    case ReviewTriggerType.ASSERTION_FAILURE: score += 20; break;
    case ReviewTriggerType.LOW_CONFIDENCE: score += 10; break;
    case ReviewTriggerType.CALIBRATION_DEVIATION: score += 15; break;
    case ReviewTriggerType.LLM_OUTPUT: score += 5; break;
  }

  return Math.min(100, score);
}

/**
 * Record a reviewer's decision
 */
export function recordReviewerDecision(reviewEnvelope, decision) {
  const {
    reviewerId,
    reviewerName,
    role,
    decisionValue,
    rationale,
    comments,
    timeSpentSeconds,
    modifiedOutput
  } = decision;

  const reviewerDecision = {
    reviewerId,
    reviewerName,
    role,
    decision: decisionValue,
    rationale,
    comments,
    timestamp: new Date().toISOString(),
    timeSpentSeconds
  };

  // Initialize reviewers array if needed
  if (!reviewEnvelope.payload.outcome.reviewers) {
    reviewEnvelope.payload.outcome.reviewers = [];
  }

  reviewEnvelope.payload.outcome.reviewers.push(reviewerDecision);

  // Update status
  reviewEnvelope.payload.outcome.status = ReviewStatus.IN_REVIEW;

  // Store modified output if provided
  if (modifiedOutput && decisionValue === ReviewDecision.MODIFY) {
    reviewEnvelope.payload.outcome.modifiedOutput = modifiedOutput;
  }

  // Check if review is complete
  const minReviewers = reviewEnvelope.payload.requirements.minimumReviewers;
  if (reviewEnvelope.payload.outcome.reviewers.length >= minReviewers) {
    finalizeReview(reviewEnvelope);
  }

  return reviewEnvelope;
}

/**
 * Finalize review based on reviewer decisions
 */
function finalizeReview(reviewEnvelope) {
  const decisions = reviewEnvelope.payload.outcome.reviewers || [];

  if (decisions.length === 0) {
    return;
  }

  // Determine final decision (majority or consensus)
  const decisionCounts = {};
  for (const d of decisions) {
    decisionCounts[d.decision] = (decisionCounts[d.decision] || 0) + 1;
  }

  // Find majority decision
  let finalDecision = null;
  let maxCount = 0;
  for (const [decision, count] of Object.entries(decisionCounts)) {
    if (count > maxCount) {
      maxCount = count;
      finalDecision = decision;
    }
  }

  // Map decision to status
  let status;
  switch (finalDecision) {
    case ReviewDecision.APPROVE:
      status = ReviewStatus.APPROVED;
      break;
    case ReviewDecision.REJECT:
      status = ReviewStatus.REJECTED;
      break;
    case ReviewDecision.MODIFY:
      status = ReviewStatus.MODIFIED;
      break;
    case ReviewDecision.ESCALATE:
      status = ReviewStatus.ESCALATED;
      break;
    default:
      status = ReviewStatus.PENDING;
  }

  reviewEnvelope.payload.outcome.finalDecision = finalDecision;
  reviewEnvelope.payload.outcome.status = status;
  reviewEnvelope.payload.outcome.completedAt = new Date().toISOString();
}

/**
 * Waive review (with authorization)
 */
export function waiveReview(reviewEnvelope, waiverId, reason) {
  reviewEnvelope.payload.outcome.status = ReviewStatus.WAIVED;
  reviewEnvelope.payload.outcome.overallRationale = `Review waived by ${waiverId}: ${reason}`;
  reviewEnvelope.payload.outcome.completedAt = new Date().toISOString();
  return reviewEnvelope;
}

/**
 * Mark review as expired
 */
export function expireReview(reviewEnvelope) {
  if (reviewEnvelope.payload.outcome.status === ReviewStatus.PENDING ||
      reviewEnvelope.payload.outcome.status === ReviewStatus.IN_REVIEW) {
    reviewEnvelope.payload.outcome.status = ReviewStatus.EXPIRED;
    reviewEnvelope.payload.outcome.completedAt = new Date().toISOString();
  }
  return reviewEnvelope;
}

/**
 * Validate an expert review envelope
 */
export function validateExpertReview(envelope) {
  return ExpertReviewEnvelopeSchema.safeParse(envelope);
}

export default ExpertReviewEnvelopeSchema;
