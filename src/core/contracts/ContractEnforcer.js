/**
 * ContractEnforcer - Enforces contract validation in recipe execution
 *
 * This module provides hooks for the RecipeExecutor to validate:
 * - Step input envelopes before execution
 * - Step output envelopes after execution
 * - Fail fast on schema mismatch
 */

import { z } from 'zod';
import {
  validate,
  validateStrict,
  ValidationError,
  EnforcementMode,
  getEnforcementMode,
  EnvelopeClass
} from './index.js';
import {
  StepInputEnvelopeSchema,
  StepOutputEnvelopeSchema,
  createStepInputEnvelope,
  createStepOutputEnvelope,
  createErrorEnvelope,
  createStepError
} from './envelopes/index.js';
import { getSchemaRegistry } from './registry.js';

/**
 * Contract enforcement options
 */
export const EnforcementOptionsSchema = z.object({
  mode: z.enum(['strict', 'warn', 'off']).default('strict'),
  validateInput: z.boolean().default(true),
  validateOutput: z.boolean().default(true),
  attachHeaders: z.boolean().default(true),
  auditLog: z.boolean().default(true)
});

/**
 * Contract Enforcer - provides validation hooks for RecipeExecutor
 */
export class ContractEnforcer {
  constructor(options = {}) {
    this.options = {
      mode: options.mode || getEnforcementMode(),
      validateInput: options.validateInput !== false,
      validateOutput: options.validateOutput !== false,
      attachHeaders: options.attachHeaders !== false,
      auditLog: options.auditLog !== false
    };

    this.schemaRegistry = getSchemaRegistry();
    this.auditLog = [];
  }

  /**
   * Validate step input before execution
   */
  validateStepInput(stepType, params, context, priorResults) {
    if (!this.options.validateInput || this.options.mode === 'off') {
      return { valid: true, data: params };
    }

    // Create input envelope
    const envelope = createStepInputEnvelope({
      stepType,
      params,
      context: {
        orgId: context.orgId || 'unknown',
        userId: context.userId,
        sessionId: context.sessionId,
        recipeId: context.recipeId,
        stepId: params.stepId || 'unknown'
      },
      priorResults: priorResults ? Object.fromEntries(priorResults) : {},
      traceId: context.traceId
    });

    // Validate envelope
    const result = validate(StepInputEnvelopeSchema, envelope, EnvelopeClass.BOUNDARY);

    if (!result.success) {
      this.logAudit('input_validation_failed', {
        stepType,
        errors: result.errors
      });

      if (this.options.mode === 'strict') {
        throw new ValidationError(
          `Step input validation failed for ${stepType}: ${result.errors.map(e => e.message).join('; ')}`,
          result.errors
        );
      }

      console.warn(`[ContractEnforcer] Input validation warning for ${stepType}:`, result.errors);
    }

    this.logAudit('input_validated', { stepType, valid: result.success });

    return {
      valid: result.success,
      envelope,
      data: params,
      errors: result.errors
    };
  }

  /**
   * Validate step output after execution
   */
  validateStepOutput(stepId, stepType, status, data, metrics = {}) {
    if (!this.options.validateOutput || this.options.mode === 'off') {
      return { valid: true, data };
    }

    // Create output envelope
    const envelope = createStepOutputEnvelope({
      stepId,
      stepType,
      status: status || 'success',
      data,
      metrics: {
        durationMs: metrics.durationMs || 0,
        cached: metrics.cached || false
      }
    });

    // Validate envelope
    const result = validate(StepOutputEnvelopeSchema, envelope, EnvelopeClass.BOUNDARY);

    if (!result.success) {
      this.logAudit('output_validation_failed', {
        stepId,
        stepType,
        errors: result.errors
      });

      if (this.options.mode === 'strict') {
        throw new ValidationError(
          `Step output validation failed for ${stepType}: ${result.errors.map(e => e.message).join('; ')}`,
          result.errors
        );
      }

      console.warn(`[ContractEnforcer] Output validation warning for ${stepType}:`, result.errors);
    }

    this.logAudit('output_validated', { stepId, stepType, valid: result.success });

    return {
      valid: result.success,
      envelope,
      data,
      errors: result.errors
    };
  }

  /**
   * Wrap error in error envelope
   */
  wrapError(stepId, recipeId, error, recoverable = false) {
    const errorEnvelope = createStepError(stepId, recipeId, error, recoverable);

    this.logAudit('error_wrapped', {
      stepId,
      recipeId,
      errorCode: errorEnvelope.payload.code,
      recoverable
    });

    return errorEnvelope;
  }

  /**
   * Validate step-specific schema if registered
   */
  validateStepSchema(stepType, data, direction = 'output') {
    const schemaId = `step.${stepType}.${direction}`;
    const schema = this.schemaRegistry.getSchema(schemaId);

    if (!schema) {
      // No specific schema registered, skip validation
      return { valid: true, data, hasSchema: false };
    }

    const result = validate(schema, data, EnvelopeClass.BOUNDARY);

    if (!result.success && this.options.mode === 'strict') {
      throw new ValidationError(
        `Step-specific schema validation failed for ${schemaId}`,
        result.errors
      );
    }

    return {
      valid: result.success,
      data: result.data || data,
      hasSchema: true,
      errors: result.errors
    };
  }

  /**
   * Create execution envelope with audit trace
   */
  createExecutionEnvelope(recipeId, inputs, context) {
    return {
      executionId: crypto.randomUUID(),
      recipeId,
      inputs,
      context: {
        orgId: context.orgId,
        userId: context.userId,
        sessionId: context.sessionId
      },
      startTime: new Date().toISOString(),
      traceId: context.traceId || crypto.randomUUID(),
      auditTrace: {
        source: 'RecipeExecutor',
        action: 'execute_recipe'
      }
    };
  }

  /**
   * Log audit entry
   */
  logAudit(action, details) {
    if (!this.options.auditLog) return;

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      action,
      details
    });

    // Keep only last 1000 entries
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
  }

  /**
   * Get audit log
   */
  getAuditLog(limit = 100) {
    return this.auditLog.slice(-limit);
  }

  /**
   * Clear audit log
   */
  clearAuditLog() {
    this.auditLog = [];
  }

  /**
   * Get enforcement mode
   */
  getMode() {
    return this.options.mode;
  }

  /**
   * Set enforcement mode
   */
  setMode(mode) {
    this.options.mode = mode;
  }

  /**
   * Check if strict mode
   */
  isStrict() {
    return this.options.mode === 'strict';
  }
}

// Singleton instance
let enforcerInstance = null;

/**
 * Get the global contract enforcer
 */
export function getContractEnforcer() {
  if (!enforcerInstance) {
    enforcerInstance = new ContractEnforcer();
  }
  return enforcerInstance;
}

/**
 * Validate step input (convenience function)
 */
export function validateStepInput(stepType, params, context, priorResults) {
  return getContractEnforcer().validateStepInput(stepType, params, context, priorResults);
}

/**
 * Validate step output (convenience function)
 */
export function validateStepOutput(stepId, stepType, status, data, metrics) {
  return getContractEnforcer().validateStepOutput(stepId, stepType, status, data, metrics);
}

export default ContractEnforcer;
