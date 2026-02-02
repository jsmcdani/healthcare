/**
 * StepOutputEnvelope - Contract for recipe step outputs
 *
 * Every step in a recipe returns its output through this envelope.
 * The executor validates this after step execution.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../EnvelopeHeader.js';
import { registerSchema, SchemaIds } from '../registry.js';

/**
 * Step execution status
 */
export const StepStatusSchema = z.enum([
  'success',
  'skipped',
  'failed',
  'cached'
]).describe('Step execution status');

/**
 * Step output data - the result produced by the step
 */
export const StepOutputDataSchema = z.any().describe('Step output data (type depends on step)');

/**
 * Step execution metrics
 */
export const StepMetricsSchema = z.object({
  durationMs: z.number().describe('Execution time in milliseconds'),
  cached: z.boolean().default(false).describe('Whether result came from cache'),
  cacheKey: z.string().optional().describe('Cache key if cached'),
  retryCount: z.number().default(0).describe('Number of retries attempted')
});

/**
 * Step Output Envelope payload
 */
export const StepOutputPayloadSchema = z.object({
  stepId: z.string().describe('Step identifier'),
  stepType: z.string().describe('Step type executed'),
  status: StepStatusSchema,
  data: StepOutputDataSchema,
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    stack: z.string().optional()
  }).optional().describe('Error details if status is failed'),
  metrics: StepMetricsSchema.optional(),
  artifactRefs: z.array(z.string()).optional().describe('References to artifacts produced')
});

/**
 * Full Step Output Envelope
 */
export const StepOutputEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: StepOutputPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a step output envelope
 */
export function createStepOutputEnvelope(options) {
  const {
    stepId,
    stepType,
    status,
    data,
    error,
    metrics,
    artifactRefs,
    userId,
    sessionId,
    traceId,
    inputEnvelopeId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.STEP_OUTPUT,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'step_complete',
    source: 'StepRunner',
    traceId
  });

  // Link to input envelope if provided
  if (inputEnvelopeId) {
    header.auditTrace.correlationId = inputEnvelopeId;
  }

  return {
    header,
    payload: {
      stepId,
      stepType,
      status,
      data,
      error,
      metrics,
      artifactRefs
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };
}

/**
 * Validate a step output envelope
 */
export function validateStepOutput(envelope) {
  return StepOutputEnvelopeSchema.safeParse(envelope);
}

/**
 * Quick success envelope creation
 */
export function createSuccessOutput(stepId, stepType, data, metrics = {}) {
  return createStepOutputEnvelope({
    stepId,
    stepType,
    status: 'success',
    data,
    metrics: {
      durationMs: metrics.durationMs || 0,
      cached: metrics.cached || false,
      retryCount: 0
    }
  });
}

/**
 * Quick failure envelope creation
 */
export function createFailureOutput(stepId, stepType, error, metrics = {}) {
  return createStepOutputEnvelope({
    stepId,
    stepType,
    status: 'failed',
    data: null,
    error: {
      message: error.message || String(error),
      code: error.code,
      stack: error.stack
    },
    metrics: {
      durationMs: metrics.durationMs || 0,
      cached: false,
      retryCount: metrics.retryCount || 0
    }
  });
}

/**
 * Register the schema (call after module fully loaded)
 */
export function registerStepOutputSchema() {
  try {
    registerSchema(SchemaIds.STEP_OUTPUT, '1.0.0', StepOutputEnvelopeSchema);
  } catch (e) {
    // Already registered
  }
}

export default StepOutputEnvelopeSchema;
