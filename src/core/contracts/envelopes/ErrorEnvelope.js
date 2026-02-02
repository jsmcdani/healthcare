/**
 * ErrorEnvelope - Structured error format for all error responses
 *
 * Provides consistent error handling across all boundaries.
 * Includes error classification, severity, and recovery hints.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../EnvelopeHeader.js';
import { SchemaIds } from '../schema-ids.js';

/**
 * Error severity levels
 */
export const ErrorSeveritySchema = z.enum([
  'low',       // Informational, non-blocking
  'medium',    // Degraded functionality
  'high',      // Feature unavailable
  'critical'   // System failure
]).describe('Error severity level');

/**
 * Error category for classification
 */
export const ErrorCategorySchema = z.enum([
  'validation',    // Schema/input validation failure
  'authorization', // Permission/access denied
  'not_found',     // Resource not found
  'conflict',      // Resource conflict (e.g., duplicate)
  'rate_limit',    // Rate limiting triggered
  'timeout',       // Operation timed out
  'dependency',    // External dependency failure
  'internal',      // Internal system error
  'policy',        // Policy violation
  'contract'       // Contract/schema violation
]).describe('Error category');

/**
 * Recovery hint for error handling
 */
export const RecoveryHintSchema = z.object({
  action: z.enum(['retry', 'skip', 'escalate', 'abort', 'fallback']),
  message: z.string(),
  retryAfterMs: z.number().optional(),
  fallbackValue: z.any().optional()
});

/**
 * Error payload
 */
export const ErrorPayloadSchema = z.object({
  code: z.string().describe('Error code (e.g., "VALIDATION_FAILED", "STEP_TIMEOUT")'),
  message: z.string().describe('Human-readable error message'),
  category: ErrorCategorySchema,
  severity: ErrorSeveritySchema,
  details: z.record(z.any()).optional().describe('Additional error details'),
  path: z.string().optional().describe('JSON path or location of error'),
  source: z.object({
    component: z.string(),
    operation: z.string().optional(),
    stepId: z.string().optional(),
    recipeId: z.string().optional()
  }).describe('Error source information'),
  stack: z.string().optional().describe('Stack trace (only in development)'),
  recoveryHint: RecoveryHintSchema.optional(),
  relatedErrors: z.array(z.lazy(() => ErrorPayloadSchema)).optional()
});

/**
 * Full Error Envelope
 */
export const ErrorEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: ErrorPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create an error envelope
 */
export function createErrorEnvelope(options) {
  const {
    code,
    message,
    category,
    severity,
    details,
    path,
    source,
    stack,
    recoveryHint,
    relatedErrors,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.ERROR,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'error',
    source: source?.component || 'unknown',
    traceId
  });

  // Only include stack in development
  const includeStack = process.env.NODE_ENV !== 'production';

  return {
    header,
    payload: {
      code,
      message,
      category,
      severity,
      details,
      path,
      source,
      stack: includeStack ? stack : undefined,
      recoveryHint,
      relatedErrors
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };
}

/**
 * Create validation error envelope
 */
export function createValidationError(message, details, source) {
  return createErrorEnvelope({
    code: 'VALIDATION_FAILED',
    message,
    category: 'validation',
    severity: 'medium',
    details,
    source: {
      component: source || 'Validator',
      operation: 'validate'
    },
    recoveryHint: {
      action: 'abort',
      message: 'Fix validation errors and retry'
    }
  });
}

/**
 * Create contract violation error envelope
 */
export function createContractError(schemaId, issues, source) {
  return createErrorEnvelope({
    code: 'CONTRACT_VIOLATION',
    message: `Schema validation failed for ${schemaId}`,
    category: 'contract',
    severity: 'high',
    details: { schemaId, issues },
    source: {
      component: source?.component || 'ContractValidator',
      operation: source?.operation || 'validate'
    },
    recoveryHint: {
      action: 'abort',
      message: 'Data does not conform to contract schema'
    }
  });
}

/**
 * Create policy violation error envelope
 */
export function createPolicyError(policy, violation, source) {
  return createErrorEnvelope({
    code: 'POLICY_VIOLATION',
    message: `Policy ${policy} violation: ${violation}`,
    category: 'policy',
    severity: 'high',
    details: { policy, violation },
    source: {
      component: source?.component || 'PolicyEngine',
      operation: source?.operation || 'evaluate'
    },
    recoveryHint: {
      action: 'escalate',
      message: 'Policy violation requires approval or adjustment'
    }
  });
}

/**
 * Create step execution error envelope
 */
export function createStepError(stepId, recipeId, error, recoverable = false) {
  return createErrorEnvelope({
    code: 'STEP_EXECUTION_FAILED',
    message: error.message || String(error),
    category: 'internal',
    severity: recoverable ? 'medium' : 'high',
    details: { stepId, recipeId, originalError: error.code || error.name },
    source: {
      component: 'RecipeExecutor',
      operation: 'executeStep',
      stepId,
      recipeId
    },
    stack: error.stack,
    recoveryHint: recoverable
      ? { action: 'retry', message: 'Step can be retried', retryAfterMs: 1000 }
      : { action: 'abort', message: 'Step failure is not recoverable' }
  });
}

/**
 * Validate an error envelope
 */
export function validateErrorEnvelope(envelope) {
  return ErrorEnvelopeSchema.safeParse(envelope);
}

export default ErrorEnvelopeSchema;
