/**
 * IntentParseRequestEnvelope - Zod schema for NLS intent parsing requests
 *
 * P1: Closed-world intent universe (allowlist only)
 * P2: Deterministic-first (explicit → rules → optional LLM)
 * P3: Clarify, don't guess
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../../../core/contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../../../core/contracts/schema-ids.js';

/**
 * Clinical modes that affect intent interpretation
 */
export const ClinicalModeSchema = z.enum([
  'standard',
  'emergency_triage',
  'phi_protection',
  'medication_safety',
  'staging_readiness'
]).describe('Active clinical mode affecting intent interpretation');

export const ClinicalMode = {
  STANDARD: 'standard',
  EMERGENCY_TRIAGE: 'emergency_triage',
  PHI_PROTECTION: 'phi_protection',
  MEDICATION_SAFETY: 'medication_safety',
  STAGING_READINESS: 'staging_readiness'
};

/**
 * Request context - who, where, what patient
 */
export const RequestContextSchema = z.object({
  userId: z.string().optional().describe('User making the request'),
  orgId: z.string().optional().describe('Organization context'),
  patientId: z.string().optional().describe('Patient context for clinical intents'),
  sessionId: z.string().optional().describe('Conversation session ID'),
  previousIntentId: z.string().optional().describe('Previous intent in conversation'),
  clinicalMode: ClinicalModeSchema.default('standard'),
  timezone: z.string().optional().describe('User timezone'),
  locale: z.string().default('en-US').describe('Language/region')
});

/**
 * Parsing constraints - P2: control deterministic-first behavior
 */
export const RequestConstraintsSchema = z.object({
  allowLLMParse: z.boolean()
    .default(true)
    .describe('If false, only use rule-based parsing (tier 1-2)'),
  forceConfirm: z.boolean()
    .default(false)
    .describe('If true, always require user confirmation even at high confidence'),
  maxParseTimeMs: z.number()
    .int()
    .min(100)
    .max(30000)
    .default(5000)
    .describe('Maximum time for parsing before timeout')
});

/**
 * Request payload
 */
export const IntentParseRequestPayloadSchema = z.object({
  rawText: z.string()
    .min(1)
    .max(2000)
    .describe('User input text to parse'),
  context: RequestContextSchema.default({}),
  constraints: RequestConstraintsSchema.default({})
});

/**
 * Full Intent Parse Request Envelope
 */
export const IntentParseRequestEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: IntentParseRequestPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create an intent parse request envelope
 */
export function createIntentParseRequest(options) {
  const {
    rawText,
    context = {},
    constraints = {},
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.INTENT_PARSE_REQUEST,
    schemaVersion: '1.0.0',
    userId: userId || context.userId,
    sessionId: sessionId || context.sessionId,
    action: 'parse_intent',
    source: 'NaturalLanguageService',
    traceId
  });

  const envelope = {
    header,
    payload: {
      rawText,
      context,
      constraints
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };

  // Validate with Zod - throws on error
  return IntentParseRequestEnvelopeSchema.parse(envelope);
}

/**
 * Create a simple request (shorthand)
 */
export function createSimpleRequest(rawText, context = {}, constraints = {}) {
  return createIntentParseRequest({ rawText, context, constraints });
}

/**
 * Create request with deterministic-only parsing (no LLM) - P2
 */
export function createDeterministicRequest(rawText, context = {}) {
  return createIntentParseRequest({
    rawText,
    context,
    constraints: { allowLLMParse: false }
  });
}

/**
 * Create request that always requires confirmation - P3
 */
export function createConfirmationRequest(rawText, context = {}) {
  return createIntentParseRequest({
    rawText,
    context,
    constraints: { forceConfirm: true }
  });
}

/**
 * Validate an intent parse request (safe - returns result object)
 */
export function validateRequest(request) {
  return IntentParseRequestEnvelopeSchema.safeParse(request);
}

/**
 * Type inference
 */
export const IntentParseRequestEnvelope = IntentParseRequestEnvelopeSchema;

export default {
  IntentParseRequestEnvelopeSchema,
  RequestContextSchema,
  RequestConstraintsSchema,
  ClinicalModeSchema,
  ClinicalMode,
  createIntentParseRequest,
  createSimpleRequest,
  createDeterministicRequest,
  createConfirmationRequest,
  validateRequest
};
