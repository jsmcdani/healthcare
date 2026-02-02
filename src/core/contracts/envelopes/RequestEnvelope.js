/**
 * RequestEnvelope - API request wrapper contract
 *
 * Standardizes all API request payloads with validation.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../EnvelopeHeader.js';
import { SchemaIds } from '../schema-ids.js';

/**
 * Request context from API layer
 */
export const RequestContextSchema = z.object({
  orgId: z.string().describe('Organization identifier'),
  userId: z.string().optional().describe('Authenticated user'),
  sessionId: z.string().optional().describe('Session identifier'),
  userAgent: z.string().optional().describe('Client user agent'),
  clientIp: z.string().optional().describe('Client IP address'),
  requestPath: z.string().describe('API path'),
  requestMethod: z.string().describe('HTTP method')
});

/**
 * Request payload (generic, schema varies by endpoint)
 */
export const RequestPayloadSchema = z.object({
  context: RequestContextSchema,
  body: z.record(z.any()).describe('Request body parameters'),
  query: z.record(z.any()).optional().describe('Query string parameters'),
  pathParams: z.record(z.string()).optional().describe('URL path parameters')
});

/**
 * Full Request Envelope
 */
export const RequestEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: RequestPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a request envelope from Express request
 */
export function createRequestEnvelope(req, options = {}) {
  const {
    body = req.body || {},
    query = req.query || {},
    pathParams = req.params || {},
    schemaVersion = '1.0.0'
  } = options;

  const context = {
    orgId: req.orgId || req.body?.orgId || 'unknown',
    userId: req.userId || req.user?.id,
    sessionId: req.sessionId || req.session?.id,
    userAgent: req.get('user-agent'),
    clientIp: req.ip || req.connection?.remoteAddress,
    requestPath: req.path,
    requestMethod: req.method
  };

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.REQUEST,
    schemaVersion,
    userId: context.userId,
    sessionId: context.sessionId,
    action: `${req.method} ${req.path}`,
    source: 'API',
    traceId: req.get('x-trace-id')
  });

  return {
    header,
    payload: {
      context,
      body,
      query,
      pathParams
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };
}

/**
 * Validate a request envelope
 */
export function validateRequest(envelope) {
  return RequestEnvelopeSchema.safeParse(envelope);
}

export default RequestEnvelopeSchema;
