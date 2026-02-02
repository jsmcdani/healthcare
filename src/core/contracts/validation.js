/**
 * Validation Utilities - Core validation functions for contract enforcement
 *
 * These utilities provide:
 * - validate() - Validate data against a Zod schema
 * - wrapEnvelope() - Wrap data in a validated envelope with header
 * - unwrapEnvelope() - Extract and validate data from an envelope
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader, EnvelopeClass } from './EnvelopeHeader.js';

// Re-export EnvelopeClass for convenience
export { EnvelopeClass };

/**
 * Validation result type
 */
export class ValidationResult {
  constructor(success, data = null, errors = []) {
    this.success = success;
    this.data = data;
    this.errors = errors;
  }

  static ok(data) {
    return new ValidationResult(true, data, []);
  }

  static fail(errors) {
    return new ValidationResult(false, null, Array.isArray(errors) ? errors : [errors]);
  }
}

/**
 * Validate data against a Zod schema
 * @param {z.ZodSchema} schema - The Zod schema to validate against
 * @param {any} data - The data to validate
 * @param {string} envelopeClass - The envelope class (BOUNDARY, STORAGE, INTERNAL)
 * @returns {ValidationResult} - The validation result
 */
export function validate(schema, data, envelopeClass = EnvelopeClass.BOUNDARY) {
  const result = schema.safeParse(data);

  if (result.success) {
    return ValidationResult.ok(result.data);
  }

  const errors = result.error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
    expected: issue.expected,
    received: issue.received
  }));

  // For BOUNDARY class, failures are critical
  if (envelopeClass === EnvelopeClass.BOUNDARY) {
    return ValidationResult.fail(errors);
  }

  // For INTERNAL class, log warning but allow through with raw data
  if (envelopeClass === EnvelopeClass.INTERNAL) {
    console.warn('[VALIDATION] Internal envelope validation failed:', errors);
    return ValidationResult.ok(data);
  }

  return ValidationResult.fail(errors);
}

/**
 * Strict validation - throws on failure
 * Use for BOUNDARY class envelopes
 */
export function validateStrict(schema, data, context = '') {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errorMessages = result.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ValidationError(
      `Schema validation failed${context ? ` for ${context}` : ''}: ${errorMessages}`,
      result.error.issues
    );
  }

  return result.data;
}

/**
 * Custom validation error with structured error info
 */
export class ValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
    this.isValidationError = true;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      issues: this.issues
    };
  }
}

/**
 * Wrap data in a validated envelope
 * @param {z.ZodSchema} payloadSchema - Schema for the payload
 * @param {any} payload - The data payload
 * @param {object} headerOptions - Options for creating the envelope header
 * @returns {object} - The wrapped envelope
 */
export function wrapEnvelope(payloadSchema, payload, headerOptions) {
  // Validate payload
  const payloadResult = validate(payloadSchema, payload, EnvelopeClass.BOUNDARY);
  if (!payloadResult.success) {
    throw new ValidationError(
      `Payload validation failed: ${payloadResult.errors.map(e => e.message).join('; ')}`,
      payloadResult.errors
    );
  }

  // Create header
  const header = createEnvelopeHeader(headerOptions);

  return {
    header,
    payload: payloadResult.data,
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };
}

/**
 * Unwrap and validate an envelope
 * @param {z.ZodSchema} envelopeSchema - Schema for the full envelope
 * @param {object} envelope - The envelope to unwrap
 * @returns {object} - The validated envelope data
 */
export function unwrapEnvelope(envelopeSchema, envelope) {
  // Validate full envelope structure
  const result = validate(envelopeSchema, envelope, EnvelopeClass.BOUNDARY);
  if (!result.success) {
    throw new ValidationError(
      `Envelope validation failed: ${result.errors.map(e => e.message).join('; ')}`,
      result.errors
    );
  }

  return result.data;
}

/**
 * Create a validated envelope factory for a specific schema
 * @param {z.ZodSchema} payloadSchema - Schema for the payload
 * @param {string} schemaId - The schema identifier
 * @param {string} schemaVersion - The schema version
 * @returns {function} - Factory function for creating envelopes
 */
export function createEnvelopeFactory(payloadSchema, schemaId, schemaVersion) {
  return (payload, options = {}) => {
    return wrapEnvelope(payloadSchema, payload, {
      schemaId,
      schemaVersion,
      ...options
    });
  };
}

/**
 * Schema combinator - creates an envelope schema with header + payload
 */
export function createEnvelopeSchema(payloadSchema) {
  return z.object({
    header: EnvelopeHeaderSchema,
    payload: payloadSchema,
    _meta: z.object({
      validated: z.boolean(),
      validatedAt: z.string().datetime()
    }).optional()
  });
}

/**
 * Batch validate multiple items
 */
export function validateBatch(schema, items, options = {}) {
  const { stopOnFirstError = false } = options;
  const results = [];

  for (let i = 0; i < items.length; i++) {
    const result = validate(schema, items[i]);
    results.push({
      index: i,
      ...result
    });

    if (!result.success && stopOnFirstError) {
      break;
    }
  }

  return {
    success: results.every(r => r.success),
    results,
    failedCount: results.filter(r => !r.success).length
  };
}

export default {
  validate,
  validateStrict,
  wrapEnvelope,
  unwrapEnvelope,
  createEnvelopeFactory,
  createEnvelopeSchema,
  validateBatch,
  ValidationResult,
  ValidationError
};
