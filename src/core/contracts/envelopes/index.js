/**
 * Envelope Schemas Index
 *
 * Export all envelope types for convenient importing.
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
  validateErrorEnvelope,
  registerErrorSchema
} from './ErrorEnvelope.js';

// Export all register functions for lazy initialization
export { registerStepInputSchema } from './StepInputEnvelope.js';
export { registerStepOutputSchema } from './StepOutputEnvelope.js';
export { registerRequestSchema } from './RequestEnvelope.js';
export { registerResponseSchema } from './ResponseEnvelope.js';

/**
 * Register all envelope schemas in the registry
 * Call this after all modules are loaded to avoid circular deps
 */
export async function registerAllEnvelopeSchemas() {
  const stepInput = await import('./StepInputEnvelope.js');
  const stepOutput = await import('./StepOutputEnvelope.js');
  const error = await import('./ErrorEnvelope.js');
  const request = await import('./RequestEnvelope.js');
  const response = await import('./ResponseEnvelope.js');

  stepInput.registerStepInputSchema();
  stepOutput.registerStepOutputSchema();
  error.registerErrorSchema();
  request.registerRequestSchema();
  response.registerResponseSchema();
}
