/**
 * IntentParseEnvelope - Zod schema for NLS intent parsing results
 *
 * P1: Closed-world intent universe (OUTSIDE_ALLOWLIST reason)
 * P4: Dual confidence (parseConfidence vs decisionConfidence)
 * P5: Auditability (tier, ruleTableVersion in trace)
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../../../core/contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../../../core/contracts/schema-ids.js';

/**
 * Parameter source - where did this value come from?
 */
export const ParameterSourceSchema = z.enum([
  'explicit',   // User provided directly in input
  'inferred',   // Extracted by parser/LLM
  'default',    // System default value
  'context'     // From request context (e.g., patientId)
]).describe('Source of the parameter value');

export const ParameterSource = {
  EXPLICIT: 'explicit',
  INFERRED: 'inferred',
  DEFAULT: 'default',
  CONTEXT: 'context'
};

/**
 * Clarification reasons - P1, P3
 */
export const ClarificationReasonSchema = z.enum([
  'ambiguous_intent',
  'missing_required_parameter',
  'multiple_intent_matches',
  'low_confidence',
  'unknown_entity',
  'outside_allowlist'  // P1: Intent not in closed-world allowlist
]).describe('Why clarification is needed');

export const ClarificationReason = {
  AMBIGUOUS_INTENT: 'ambiguous_intent',
  MISSING_REQUIRED_PARAMETER: 'missing_required_parameter',
  MULTIPLE_INTENT_MATCHES: 'multiple_intent_matches',
  LOW_CONFIDENCE: 'low_confidence',
  UNKNOWN_ENTITY: 'unknown_entity',
  OUTSIDE_ALLOWLIST: 'outside_allowlist'
};

/**
 * Intent family classification
 */
export const IntentFamilySchema = z.enum([
  'clinical',
  'administrative',
  'system'
]).describe('Intent family classification');

export const IntentFamily = {
  CLINICAL: 'clinical',
  ADMINISTRATIVE: 'administrative',
  SYSTEM: 'system'
};

/**
 * P2: Deterministic-first tiers
 */
export const ParseTierSchema = z.enum(['1', '2', '3']).transform(Number).describe('Resolution tier');

export const ParseTier = {
  TIER_1_EXPLICIT: 1,  // Slash command triggers
  TIER_2_PATTERN: 2,   // Regex pattern matching
  TIER_3_LLM: 3        // LLM-based classification
};

/**
 * Extracted parameter with source tracking
 */
export const ParameterSchema = z.object({
  name: z.string().describe('Parameter name'),
  value: z.unknown().describe('Parameter value'),
  source: ParameterSourceSchema,
  confidence: z.number().min(0).max(1).describe('Confidence in this parameter value')
});

/**
 * Clarification option for user selection
 */
export const ClarificationOptionSchema = z.object({
  label: z.string().describe('Display label'),
  value: z.string().describe('Selection value'),
  intentId: z.string().describe('Intent this option maps to')
});

/**
 * Clarification details when intent is unclear
 */
export const ClarificationSchema = z.object({
  reason: ClarificationReasonSchema,
  message: z.string().describe('User-facing clarification message'),
  options: z.array(ClarificationOptionSchema).optional().describe('Suggested alternatives'),
  missingParameters: z.array(z.string()).optional().describe('Required parameters not found')
});

/**
 * Rule match details for audit
 */
export const RuleMatchSchema = z.object({
  pattern: z.string().describe('Pattern or trigger that matched'),
  confidence: z.number().min(0).max(1),
  tier: z.number().int().min(1).max(3).optional()
});

/**
 * Parse trace for auditability - P5
 */
export const ParseTraceSchema = z.object({
  parserUsed: z.enum(['rule-based', 'llm', 'hybrid', 'confirmed'])
    .describe('Which parser resolved the intent'),
  tier: z.number().int().min(1).max(3).optional()
    .describe('P2: Which tier resolved the intent'),
  ruleMatches: z.array(RuleMatchSchema).default([])
    .describe('All patterns that matched'),
  llmInvoked: z.boolean().default(false)
    .describe('Was LLM used?'),
  parseTimeMs: z.number().int()
    .describe('Time to parse in milliseconds'),
  ruleTableVersion: z.string().optional()
    .describe('P5: Version of rule table for reproducibility')
});

/**
 * Intent parse result payload
 */
export const IntentParsePayloadSchema = z.object({
  intentId: z.string().nullable().describe('Classified intent ID (null if clarification needed)'),
  intentFamily: IntentFamilySchema,
  parameters: z.array(ParameterSchema).default([]),

  // P4: Dual confidence
  parseConfidence: z.number().min(0).max(1)
    .describe('Classification certainty: how confident we understood the intent'),
  decisionConfidence: z.number().min(0).max(1).optional()
    .describe('Clinical appropriateness: how confident this is the right action (clinical only)'),

  requiresClarification: z.boolean()
    .describe('Whether user clarification is needed'),
  clarification: ClarificationSchema.optional(),

  originalText: z.string().describe('Original user input'),
  trace: ParseTraceSchema.describe('Audit trace for reproducibility')
});

/**
 * Full Intent Parse Envelope
 */
export const IntentParseEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: IntentParsePayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create an intent parse envelope
 */
export function createIntentParseEnvelope(options) {
  const {
    intentId,
    intentFamily = 'system',
    parameters = [],
    parseConfidence,
    decisionConfidence,
    requiresClarification,
    clarification,
    originalText,
    trace,
    correlationId,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.INTENT_PARSE,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'intent_parsed',
    source: 'NaturalLanguageService',
    traceId
  });

  // Add correlationId to auditTrace if provided
  if (correlationId) {
    header.auditTrace.correlationId = correlationId;
  }

  const envelope = {
    header,
    payload: {
      intentId,
      intentFamily,
      parameters,
      parseConfidence,
      decisionConfidence,
      requiresClarification,
      clarification,
      originalText,
      trace
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };

  return IntentParseEnvelopeSchema.parse(envelope);
}

/**
 * Create a clarification envelope (intent unclear)
 */
export function createClarificationEnvelope(options) {
  return createIntentParseEnvelope({
    intentId: null,
    intentFamily: options.intentFamily || 'system',
    parameters: options.parameters || [],
    parseConfidence: options.parseConfidence || 0,
    requiresClarification: true,
    clarification: options.clarification,
    originalText: options.originalText,
    trace: options.trace,
    correlationId: options.correlationId,
    userId: options.userId,
    sessionId: options.sessionId,
    traceId: options.traceId
  });
}

/**
 * Create a success envelope (intent resolved)
 */
export function createSuccessEnvelope(options) {
  return createIntentParseEnvelope({
    intentId: options.intentId,
    intentFamily: options.intentFamily,
    parameters: options.parameters,
    parseConfidence: options.parseConfidence,
    decisionConfidence: options.decisionConfidence,
    requiresClarification: false,
    originalText: options.originalText,
    trace: options.trace,
    correlationId: options.correlationId,
    userId: options.userId,
    sessionId: options.sessionId,
    traceId: options.traceId
  });
}

/**
 * P1: Create envelope for intent outside allowlist
 */
export function createOutsideAllowlistEnvelope(options) {
  return createClarificationEnvelope({
    intentFamily: 'system',
    parameters: [],
    parseConfidence: 0,
    clarification: {
      reason: ClarificationReason.OUTSIDE_ALLOWLIST,
      message: options.message || 'The requested action is not recognized. Please use /help to see available commands.',
      options: options.suggestedIntents || []
    },
    originalText: options.originalText,
    trace: options.trace,
    correlationId: options.correlationId,
    userId: options.userId,
    sessionId: options.sessionId,
    traceId: options.traceId
  });
}

/**
 * Validate an intent parse envelope (safe - returns result object)
 */
export function validateParseEnvelope(envelope) {
  return IntentParseEnvelopeSchema.safeParse(envelope);
}

export default {
  IntentParseEnvelopeSchema,
  IntentParsePayloadSchema,
  ParseTraceSchema,
  ParameterSchema,
  ClarificationSchema,
  ParameterSource,
  ParameterSourceSchema,
  ClarificationReason,
  ClarificationReasonSchema,
  IntentFamily,
  IntentFamilySchema,
  ParseTier,
  ParseTierSchema,
  createIntentParseEnvelope,
  createClarificationEnvelope,
  createSuccessEnvelope,
  createOutsideAllowlistEnvelope,
  validateParseEnvelope
};
