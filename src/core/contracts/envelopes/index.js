/**
 * Envelope Schemas Index
 *
 * Export all envelope types for convenient importing.
 * No lazy registration - schemas are pure definitions.
 */

// Step envelopes
export {
  StepInputEnvelopeSchema,
  StepInputPayloadSchema,
  StepInputParamsSchema,
  StepContextSchema,
  PriorResultsSchema,
  createStepInputEnvelope,
  validateStepInput
} from './StepInputEnvelope.js';

export {
  StepOutputEnvelopeSchema,
  StepOutputPayloadSchema,
  StepOutputDataSchema,
  StepStatusSchema,
  StepMetricsSchema,
  createStepOutputEnvelope,
  validateStepOutput,
  createSuccessOutput,
  createFailureOutput
} from './StepOutputEnvelope.js';

// API envelopes
export {
  RequestEnvelopeSchema,
  RequestPayloadSchema,
  RequestContextSchema,
  createRequestEnvelope,
  validateRequest
} from './RequestEnvelope.js';

export {
  ResponseEnvelopeSchema,
  ResponsePayloadSchema,
  ResponseStatusSchema,
  ResponseMetaSchema,
  createSuccessResponse,
  createErrorResponse,
  createPartialResponse,
  validateResponse
} from './ResponseEnvelope.js';

// Error envelope
export {
  ErrorEnvelopeSchema,
  ErrorPayloadSchema,
  ErrorSeveritySchema,
  ErrorCategorySchema,
  RecoveryHintSchema,
  createErrorEnvelope,
  createValidationError,
  createContractError,
  createPolicyError,
  createStepError,
  validateErrorEnvelope
} from './ErrorEnvelope.js';
