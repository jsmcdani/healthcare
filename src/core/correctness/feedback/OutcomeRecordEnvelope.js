/**
 * OutcomeRecordEnvelope - Contract for tracking decision outcomes
 *
 * Links decisions to their real-world outcomes, enabling learning
 * and calibration improvement over time.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../contracts/schema-ids.js';

/**
 * Outcome types
 */
export const OutcomeTypeSchema = z.enum([
  'patient_outcome',    // Direct patient health outcome
  'adverse_event',      // Adverse event occurred
  'near_miss',          // Near miss caught before harm
  'no_harm',            // Issue identified but no harm
  'positive_outcome',   // Positive expected outcome
  'neutral_outcome',    // No significant impact
  'unknown'             // Outcome not determined
]).describe('Type of outcome observed');

export const OutcomeType = {
  PATIENT_OUTCOME: 'patient_outcome',
  ADVERSE_EVENT: 'adverse_event',
  NEAR_MISS: 'near_miss',
  NO_HARM: 'no_harm',
  POSITIVE_OUTCOME: 'positive_outcome',
  NEUTRAL_OUTCOME: 'neutral_outcome',
  UNKNOWN: 'unknown'
};

/**
 * Outcome severity
 */
export const OutcomeSeveritySchema = z.enum([
  'none',       // No adverse effect
  'minor',      // Minor temporary effect
  'moderate',   // Required intervention
  'major',      // Significant lasting effect
  'severe'      // Severe harm or death
]).describe('Severity of the outcome');

export const OutcomeSeverity = {
  NONE: 'none',
  MINOR: 'minor',
  MODERATE: 'moderate',
  MAJOR: 'major',
  SEVERE: 'severe'
};

/**
 * Learning action types
 */
export const LearningActionSchema = z.enum([
  'update_calibration',  // Update calibration test cases
  'add_assertion',       // Add new assertion rule
  'modify_recipe',       // Modify recipe logic
  'update_knowledge',    // Update knowledge base
  'flag_pattern',        // Flag pattern for review
  'adjust_threshold',    // Adjust trigger thresholds
  'no_action'            // No action needed
]).describe('Type of learning action to take');

export const LearningAction = {
  UPDATE_CALIBRATION: 'update_calibration',
  ADD_ASSERTION: 'add_assertion',
  MODIFY_RECIPE: 'modify_recipe',
  UPDATE_KNOWLEDGE: 'update_knowledge',
  FLAG_PATTERN: 'flag_pattern',
  ADJUST_THRESHOLD: 'adjust_threshold',
  NO_ACTION: 'no_action'
};

/**
 * Decision reference
 */
export const DecisionRefSchema = z.object({
  artifactId: z.string().describe('ID of the original decision artifact'),
  correctnessEnvelopeId: z.string().optional()
    .describe('ID of the correctness envelope'),
  recipeId: z.string().optional(),
  timestamp: z.string().datetime()
    .describe('When the decision was made'),
  decisionSummary: z.string().optional()
    .describe('Brief summary of what was decided')
});

/**
 * Outcome details
 */
export const OutcomeDetailsSchema = z.object({
  type: OutcomeTypeSchema,
  description: z.string().describe('Description of what happened'),
  severity: OutcomeSeveritySchema.optional(),
  occurredAt: z.string().datetime().optional()
    .describe('When the outcome occurred'),
  discoveredAt: z.string().datetime().optional()
    .describe('When the outcome was discovered'),
  reportedBy: z.string().optional(),
  relatedEvents: z.array(z.string()).optional()
    .describe('IDs of related incidents or events')
});

/**
 * Retrospective assessment
 */
export const RetrospectiveAssessmentSchema = z.object({
  decisionWasCorrect: z.boolean().optional()
    .describe('In hindsight, was the decision correct?'),
  wouldChangeDecision: z.boolean().optional()
    .describe('Knowing the outcome, would a different decision be better?'),
  alternativeDecision: z.string().optional()
    .describe('What should have been decided instead'),
  rootCause: z.string().optional()
    .describe('Root cause if decision was incorrect'),
  contributingFactors: z.array(z.string()).optional()
    .describe('Factors that contributed to the outcome'),
  assessedBy: z.string(),
  assessedAt: z.string().datetime(),
  notes: z.string().optional()
});

/**
 * Learning action
 */
export const LearningActionDetailSchema = z.object({
  action: LearningActionSchema,
  description: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  assignedTo: z.string().optional(),
  implementedAt: z.string().datetime().optional(),
  implementedBy: z.string().optional(),
  verifiedAt: z.string().datetime().optional()
});

/**
 * Outcome Record Payload
 */
export const OutcomeRecordPayloadSchema = z.object({
  outcomeId: z.string().uuid(),

  // Link to original decision
  decisionRef: DecisionRefSchema,

  // What actually happened
  outcome: OutcomeDetailsSchema,

  // Was the decision correct in hindsight?
  retrospectiveAssessment: RetrospectiveAssessmentSchema.optional(),

  // Learning actions
  learningActions: z.array(LearningActionDetailSchema).optional(),

  // Categorization for analysis
  category: z.string().optional()
    .describe('Category for grouping similar outcomes'),
  tags: z.array(z.string()).optional(),

  // Status
  status: z.enum(['recorded', 'assessed', 'actioned', 'closed']).default('recorded'),

  // Audit
  recordedAt: z.string().datetime(),
  recordedBy: z.string().optional()
});

/**
 * Full Outcome Record Envelope
 */
export const OutcomeRecordEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: OutcomeRecordPayloadSchema,
  _meta: z.object({
    version: z.string().default('1.0.0'),
    linkedRecords: z.array(z.string()).optional()
      .describe('IDs of related outcome records')
  }).optional()
});

/**
 * Create an outcome record
 */
export function createOutcomeRecord(options) {
  const {
    decisionRef,
    outcome,
    retrospectiveAssessment,
    learningActions,
    category,
    tags,
    recordedBy,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.OUTCOME_RECORD,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'record_outcome',
    source: 'OutcomeTracker',
    traceId
  });

  const now = new Date().toISOString();

  return {
    header,
    payload: {
      outcomeId: crypto.randomUUID(),
      decisionRef,
      outcome: {
        ...outcome,
        discoveredAt: outcome.discoveredAt || now
      },
      retrospectiveAssessment,
      learningActions,
      category,
      tags,
      status: 'recorded',
      recordedAt: now,
      recordedBy
    },
    _meta: {
      version: '1.0.0'
    }
  };
}

/**
 * Add retrospective assessment to outcome record
 */
export function addRetrospectiveAssessment(outcomeRecord, assessment) {
  outcomeRecord.payload.retrospectiveAssessment = {
    ...assessment,
    assessedAt: assessment.assessedAt || new Date().toISOString()
  };
  outcomeRecord.payload.status = 'assessed';
  return outcomeRecord;
}

/**
 * Add learning action to outcome record
 */
export function addLearningAction(outcomeRecord, action) {
  if (!outcomeRecord.payload.learningActions) {
    outcomeRecord.payload.learningActions = [];
  }
  outcomeRecord.payload.learningActions.push(action);
  return outcomeRecord;
}

/**
 * Mark learning action as implemented
 */
export function markActionImplemented(outcomeRecord, actionIndex, implementedBy) {
  const actions = outcomeRecord.payload.learningActions;
  if (actions && actions[actionIndex]) {
    actions[actionIndex].implementedAt = new Date().toISOString();
    actions[actionIndex].implementedBy = implementedBy;

    // Update status if all actions are implemented
    const allImplemented = actions.every(a =>
      a.action === LearningAction.NO_ACTION || a.implementedAt
    );
    if (allImplemented) {
      outcomeRecord.payload.status = 'actioned';
    }
  }
  return outcomeRecord;
}

/**
 * Close outcome record
 */
export function closeOutcomeRecord(outcomeRecord) {
  outcomeRecord.payload.status = 'closed';
  return outcomeRecord;
}

/**
 * Validate an outcome record
 */
export function validateOutcomeRecord(envelope) {
  return OutcomeRecordEnvelopeSchema.safeParse(envelope);
}

export default OutcomeRecordEnvelopeSchema;
