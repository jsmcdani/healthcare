/**
 * EnvelopeHeader - Standard header required on ALL envelopes
 *
 * Every envelope crossing a boundary (API, step I/O, storage) MUST include this header.
 * This ensures traceability, versioning, and audit compliance.
 */

import { z } from 'zod';

/**
 * Audit trace for tracking the origin and context of an envelope
 */
export const AuditTraceSchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  action: z.string().describe('The action being performed (e.g., "execute_step", "create_profile")'),
  source: z.string().describe('The source system/component (e.g., "RecipeExecutor", "API")'),
  timestamp: z.string().datetime().optional(),
  correlationId: z.string().uuid().optional()
});

/**
 * Standard envelope header - REQUIRED on all boundary-crossing data
 */
export const EnvelopeHeaderSchema = z.object({
  envelopeId: z.string().uuid().describe('Unique identifier for this envelope instance'),
  schemaId: z.string().describe('Schema identifier (e.g., "step.output.v1", "artifact.profile.v1")'),
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/).describe('Semantic version of the schema'),
  timestamp: z.string().datetime().describe('ISO 8601 timestamp of envelope creation'),
  traceId: z.string().optional().describe('Cross-request correlation ID for distributed tracing'),
  auditTrace: AuditTraceSchema.describe('Audit information for compliance')
});

/**
 * Envelope class (BOUNDARY, STORAGE, INTERNAL)
 * Determines validation strictness
 */
export const EnvelopeClass = {
  BOUNDARY: 'BOUNDARY',   // Required validation - executor rejects on failure
  STORAGE: 'STORAGE',     // Required validation - no write without validation
  INTERNAL: 'INTERNAL'    // Recommended validation - events, telemetry, logs
};

/**
 * Create a new envelope header with auto-generated fields
 */
export function createEnvelopeHeader(options) {
  const {
    schemaId,
    schemaVersion,
    userId,
    sessionId,
    action,
    source,
    traceId
  } = options;

  const now = new Date().toISOString();

  return {
    envelopeId: crypto.randomUUID(),
    schemaId,
    schemaVersion,
    timestamp: now,
    traceId: traceId || crypto.randomUUID(),
    auditTrace: {
      userId,
      sessionId,
      action,
      source,
      timestamp: now,
      correlationId: crypto.randomUUID()
    }
  };
}

/**
 * Validate an envelope header
 */
export function validateHeader(header) {
  return EnvelopeHeaderSchema.safeParse(header);
}

export default EnvelopeHeaderSchema;
