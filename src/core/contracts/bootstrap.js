/**
 * Contract Bootstrap - One-time schema registration
 *
 * Call this once at application startup to register all schemas.
 * No circular dependencies - imports schemas after they're fully defined.
 */

import { registerSchema } from './registry.js';
import { SchemaIds } from './schema-ids.js';

// Import all schemas (they're now pure, no side effects)
import { StepInputEnvelopeSchema } from './envelopes/StepInputEnvelope.js';
import { StepOutputEnvelopeSchema } from './envelopes/StepOutputEnvelope.js';
import { ErrorEnvelopeSchema } from './envelopes/ErrorEnvelope.js';
import { RequestEnvelopeSchema } from './envelopes/RequestEnvelope.js';
import { ResponseEnvelopeSchema } from './envelopes/ResponseEnvelope.js';

let initialized = false;

/**
 * Register all contract schemas in the registry
 * Safe to call multiple times - only runs once
 */
export function bootstrapContracts() {
  if (initialized) {
    return;
  }

  // Register envelope schemas
  const schemas = [
    [SchemaIds.STEP_INPUT, '1.0.0', StepInputEnvelopeSchema],
    [SchemaIds.STEP_OUTPUT, '1.0.0', StepOutputEnvelopeSchema],
    [SchemaIds.ERROR, '1.0.0', ErrorEnvelopeSchema],
    [SchemaIds.REQUEST, '1.0.0', RequestEnvelopeSchema],
    [SchemaIds.RESPONSE, '1.0.0', ResponseEnvelopeSchema]
  ];

  for (const [schemaId, version, schema] of schemas) {
    try {
      registerSchema(schemaId, version, schema);
    } catch (e) {
      // Already registered - ignore
    }
  }

  initialized = true;
}

/**
 * Check if contracts have been bootstrapped
 */
export function isBootstrapped() {
  return initialized;
}

/**
 * Reset bootstrap state (for testing only)
 */
export function resetBootstrap() {
  initialized = false;
}

export default bootstrapContracts;
