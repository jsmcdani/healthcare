/**
 * IntentConfirmEnvelope - Zod schema for user confirmation of parsed intents
 *
 * P3: Clarify, don't guess (userAcknowledged for explicit consent)
 * P5: Auditability (confirmationSource tracking)
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../../../core/contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../../../core/contracts/schema-ids.js';

/**
 * How the confirmation was provided
 */
export const ConfirmationSourceSchema = z.enum([
  'user_selection',      // User selected from options
  'user_typed',          // User typed explicit confirmation
  'system_auto',         // Auto-confirmed (high confidence, non-clinical)
  'clinical_override'    // Clinician override with acknowledgment
]).describe('How the confirmation was provided');

export const ConfirmationSource = {
  USER_SELECTION: 'user_selection',
  USER_TYPED: 'user_typed',
  SYSTEM_AUTO: 'system_auto',
  CLINICAL_OVERRIDE: 'clinical_override'
};

/**
 * Confirmed parameter with modification tracking
 */
export const ConfirmedParameterSchema = z.object({
  name: z.string().describe('Parameter name'),
  value: z.unknown().describe('Confirmed value'),
  userModified: z.boolean().default(false)
    .describe('True if user changed this from the parsed value')
});

/**
 * Intent confirm payload
 */
export const IntentConfirmPayloadSchema = z.object({
  parseEnvelopeId: z.string().uuid()
    .describe('Reference to the original parse envelope'),
  confirmedIntentId: z.string()
    .describe('The intent the user confirmed'),
  confirmedParameters: z.array(ConfirmedParameterSchema).default([]),

  // P3: Explicit user acknowledgment
  userAcknowledged: z.boolean()
    .describe('Explicit user acknowledgment that this is the intended action'),
  confirmationSource: ConfirmationSourceSchema.default('user_selection')
    .describe('P5: How the confirmation was provided for audit'),

  additionalContext: z.string().optional()
    .describe('Optional user notes or context')
});

/**
 * Full Intent Confirm Envelope
 */
export const IntentConfirmEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: IntentConfirmPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Confirmation response - what to do next
 */
export const ConfirmResponseSchema = z.object({
  confirmed: z.boolean().describe('Whether confirmation was successful'),
  parseEnvelope: z.unknown().optional().describe('Updated parse envelope if needed'),
  routing: z.object({
    intentId: z.string(),
    recipeId: z.string().optional(),
    parameters: z.record(z.unknown()).optional()
  }).optional().describe('Routing info for execution'),
  readyForExecution: z.boolean().describe('Whether ready to execute'),
  error: z.string().optional().describe('Error message if confirmation failed')
});

/**
 * Create an intent confirm envelope
 */
export function createIntentConfirm(options) {
  const {
    parseEnvelopeId,
    confirmedIntentId,
    confirmedParameters = [],
    userAcknowledged,
    confirmationSource = 'user_selection',
    additionalContext,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.INTENT_CONFIRM,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'confirm_intent',
    source: 'NaturalLanguageService',
    traceId
  });

  const envelope = {
    header,
    payload: {
      parseEnvelopeId,
      confirmedIntentId,
      confirmedParameters,
      userAcknowledged,
      confirmationSource,
      additionalContext
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };

  return IntentConfirmEnvelopeSchema.parse(envelope);
}

/**
 * Helper for explicit user confirmation (most common case)
 */
export function createUserConfirm(options) {
  return createIntentConfirm({
    ...options,
    userAcknowledged: true,
    confirmationSource: 'user_selection'
  });
}

/**
 * Helper for system auto-confirmation (high confidence, non-clinical)
 */
export function createAutoConfirm(options) {
  return createIntentConfirm({
    ...options,
    userAcknowledged: false,
    confirmationSource: 'system_auto'
  });
}

/**
 * Create a confirmation response
 */
export function createConfirmResponse(options) {
  const response = {
    confirmed: options.confirmed,
    parseEnvelope: options.parseEnvelope,
    routing: options.routing,
    readyForExecution: options.readyForExecution,
    error: options.error
  };

  return ConfirmResponseSchema.parse(response);
}

/**
 * Validate a confirmation envelope (safe - returns result object)
 */
export function validateConfirmation(confirm) {
  return IntentConfirmEnvelopeSchema.safeParse(confirm);
}

/**
 * Validate a confirmation response (safe - returns result object)
 */
export function validateConfirmResponse(response) {
  return ConfirmResponseSchema.safeParse(response);
}

export default {
  IntentConfirmEnvelopeSchema,
  IntentConfirmPayloadSchema,
  ConfirmedParameterSchema,
  ConfirmResponseSchema,
  ConfirmationSource,
  ConfirmationSourceSchema,
  createIntentConfirm,
  createUserConfirm,
  createAutoConfirm,
  createConfirmResponse,
  validateConfirmation,
  validateConfirmResponse
};
