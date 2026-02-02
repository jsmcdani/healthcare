/**
 * Assertions Module - Barrel export
 */

export {
  AssertionEngine,
  ValidationStrategy
} from './AssertionEngine.js';

export {
  CorrectnessAssertionEnvelopeSchema,
  CorrectnessAssertionPayloadSchema,
  AssertionTypes,
  AssertionTypeSchema,
  AssertionSeverity,
  AssertionSeveritySchema,
  ValidationMethodSchema,
  AssertionClaimSchema,
  EvidenceBasisSchema,
  ViolationSchema,
  UncertaintyBoundsSchema,
  ValidationResultSchema,
  createCorrectnessAssertion,
  createValidationResult,
  createViolation,
  validateCorrectnessAssertion
} from './CorrectnessAssertionEnvelope.js';

export * from './types/index.js';
