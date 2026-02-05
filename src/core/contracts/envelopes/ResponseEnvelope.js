/**
 * ResponseEnvelope - API response wrapper contract
 *
 * Standardizes all API responses with validation.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../EnvelopeHeader.js';
import { SchemaIds } from '../schema-ids.js';

/**
 * Response status
 */
export const ResponseStatusSchema = z.enum([
  'success',
  'partial',
  'error'
]).describe('Response status');

/**
 * Response metadata
 */
export const ResponseMetaSchema = z.object({
  duration: z.number().describe('Request processing time in ms'),
  cached: z.boolean().default(false),
  cacheKey: z.string().optional(),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    totalItems: z.number(),
    totalPages: z.number()
  }).optional(),
  warnings: z.array(z.string()).optional()
});

/**
 * Response payload
 */
export const ResponsePayloadSchema = z.object({
  status: ResponseStatusSchema,
  data: z.any().describe('Response data'),
  meta: ResponseMetaSchema.optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.any()).optional()
  }).optional()
});

/**
 * Full Response Envelope
 */
export const ResponseEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: ResponsePayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a success response envelope
 */
export function createSuccessResponse(data, options = {}) {
  const {
    requestEnvelopeId,
    duration = 0,
    cached = false,
    cacheKey,
    pagination,
    warnings,
    userId,
    sessionId,
    traceId,
    schemaVersion = '1.0.0'
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.RESPONSE,
    schemaVersion,
    userId,
    sessionId,
    action: 'response',
    source: 'API',
    traceId
  });

  // Link to request envelope
  if (requestEnvelopeId) {
    header.auditTrace.correlationId = requestEnvelopeId;
  }

  return {
    header,
    payload: {
      status: 'success',
      data,
      meta: {
        duration,
        cached,
        cacheKey,
        pagination,
        warnings
      }
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };
}

/**
 * Create an error response envelope
 */
export function createErrorResponse(error, options = {}) {
  const {
    requestEnvelopeId,
    duration = 0,
    userId,
    sessionId,
    traceId,
    schemaVersion = '1.0.0'
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.RESPONSE,
    schemaVersion,
    userId,
    sessionId,
    action: 'response_error',
    source: 'API',
    traceId
  });

  if (requestEnvelopeId) {
    header.auditTrace.correlationId = requestEnvelopeId;
  }

  return {
    header,
    payload: {
      status: 'error',
      data: null,
      meta: { duration },
      error: {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || String(error),
        details: error.details || {}
      }
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };
}

/**
 * Create a partial success response
 */
export function createPartialResponse(data, warnings, options = {}) {
  const response = createSuccessResponse(data, options);
  response.payload.status = 'partial';
  response.payload.meta.warnings = warnings;
  return response;
}

/**
 * Validate a response envelope
 */
export function validateResponse(envelope) {
  return ResponseEnvelopeSchema.safeParse(envelope);
}

export default ResponseEnvelopeSchema;
