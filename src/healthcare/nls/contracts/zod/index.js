/**
 * Zod-based Intent Contracts - Type-safe, deterministic validation
 *
 * These Zod schemas provide:
 * - Compile-time type inference
 * - Deterministic parsing (.parse() throws, .safeParse() returns result)
 * - Consistency with core contracts
 */

// Request envelope
export {
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
} from './IntentParseRequestEnvelope.js';

// Parse result envelope
export {
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
} from './IntentParseEnvelope.js';

// Confirmation envelope
export {
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
} from './IntentConfirmEnvelope.js';
