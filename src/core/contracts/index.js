/**
 * Contracts Index - Export all contract infrastructure
 *
 * This is the main entry point for the contract-first architecture.
 * Importing this module auto-bootstraps schema registration.
 *
 * Usage:
 * import { validate, EnvelopeHeaderSchema, createStepInputEnvelope } from './core/contracts';
 */

// Bootstrap schemas on import (runs once)
import { bootstrapContracts, isBootstrapped } from './bootstrap.js';
bootstrapContracts();

// Schema IDs (no deps - safe to import anywhere)
export { SchemaIds } from './schema-ids.js';

// Core header
export {
  EnvelopeHeaderSchema,
  AuditTraceSchema,
  EnvelopeClass,
  createEnvelopeHeader,
  validateHeader
} from './EnvelopeHeader.js';

// Validation utilities
export {
  validate,
  validateStrict,
  wrapEnvelope,
  unwrapEnvelope,
  createEnvelopeFactory,
  createEnvelopeSchema,
  validateBatch,
  ValidationResult,
  ValidationError
} from './validation.js';

// Schema registry
export {
  getSchemaRegistry,
  registerSchema,
  getRegisteredSchema,
  SchemaRegistry
} from './registry.js';

// All envelope types
export * from './envelopes/index.js';

// Contract enforcer
export {
  ContractEnforcer,
  EnforcementOptionsSchema,
  getContractEnforcer,
  validateStepInput,
  validateStepOutput
} from './ContractEnforcer.js';

// Bootstrap utilities
export { bootstrapContracts, isBootstrapped };

/**
 * Contract enforcement modes
 */
export const EnforcementMode = {
  STRICT: 'strict',   // Fail on any validation error
  WARN: 'warn',       // Log warnings but continue
  OFF: 'off'          // No validation (development only)
};

/**
 * Global enforcement mode (can be set via env)
 */
let globalEnforcementMode = process.env.CONTRACT_ENFORCEMENT || EnforcementMode.STRICT;

export function setEnforcementMode(mode) {
  globalEnforcementMode = mode;
}

export function getEnforcementMode() {
  return globalEnforcementMode;
}

/**
 * Helper to check if enforcement is active
 */
export function isEnforcementActive() {
  return globalEnforcementMode !== EnforcementMode.OFF;
}
