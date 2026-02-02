/**
 * AssertionEngine - Orchestrates validation of correctness assertions
 *
 * Takes assertions and validates them against ground truth sources,
 * producing validated assertions with evidence and results.
 */

import { Logger } from '../../../utils/logger.js';
import {
  AssertionTypes,
  AssertionSeverity,
  createValidationResult,
  createViolation
} from './CorrectnessAssertionEnvelope.js';
import { validateCodeAssertion } from './types/CodeValidAssertion.js';
import { validateRangeAssertion } from './types/RangeAssertion.js';
import { validateContraindicationAssertion } from './types/ContraindicationAssertion.js';
import { validateGuidelineAssertion } from './types/GuidelineAssertion.js';

/**
 * Validation strategy
 */
export const ValidationStrategy = {
  FAIL_FAST: 'fail_fast',           // Stop on first critical failure
  VALIDATE_ALL: 'validate_all',      // Validate all assertions
  CRITICAL_ONLY: 'critical_only'     // Only validate critical assertions
};

/**
 * Assertion Engine
 */
export class AssertionEngine {
  constructor(options = {}) {
    this.logger = new Logger('AssertionEngine');
    this.groundTruthRegistry = options.groundTruthRegistry;
    this.guidelineRegistry = options.guidelineRegistry;
    this.customValidators = new Map();
    this.strategy = options.strategy || ValidationStrategy.VALIDATE_ALL;
    this.parallelValidation = options.parallelValidation ?? true;
    this.validationTimeout = options.validationTimeout || 30000;
  }

  /**
   * Set the ground truth registry
   */
  setGroundTruthRegistry(registry) {
    this.groundTruthRegistry = registry;
  }

  /**
   * Set the guideline registry
   */
  setGuidelineRegistry(registry) {
    this.guidelineRegistry = registry;
  }

  /**
   * Register a custom validator for CUSTOM assertion type
   */
  registerCustomValidator(name, validatorFn) {
    this.customValidators.set(name, validatorFn);
    this.logger.debug('Registered custom validator', { name });
  }

  /**
   * Validate a single assertion
   */
  async validateAssertion(assertion) {
    const assertionType = assertion.payload?.assertionType;
    const startTime = Date.now();

    this.logger.debug('Validating assertion', {
      assertionId: assertion.payload?.assertionId,
      type: assertionType
    });

    try {
      switch (assertionType) {
        case AssertionTypes.CODE_VALID:
          return this.withTimeout(
            validateCodeAssertion(assertion, this.groundTruthRegistry)
          );

        case AssertionTypes.VALUE_IN_RANGE:
          return this.withTimeout(
            validateRangeAssertion(assertion, this.groundTruthRegistry)
          );

        case AssertionTypes.NO_CONTRAINDICATION:
          return this.withTimeout(
            validateContraindicationAssertion(assertion, this.groundTruthRegistry)
          );

        case AssertionTypes.GUIDELINE_ALIGNED:
          return this.withTimeout(
            validateGuidelineAssertion(assertion, this.guidelineRegistry)
          );

        case AssertionTypes.CUSTOM:
          return this.validateCustomAssertion(assertion);

        default:
          return this.createUnsupportedResult(assertion, assertionType, startTime);
      }
    } catch (error) {
      this.logger.error('Assertion validation failed', {
        assertionId: assertion.payload?.assertionId,
        error: error.message
      });

      return this.createErrorResult(assertion, error.message, startTime);
    }
  }

  /**
   * Validate multiple assertions
   */
  async validateAssertions(assertions, options = {}) {
    const strategy = options.strategy || this.strategy;
    const results = [];
    let criticalFailure = false;

    this.logger.info('Validating assertions', {
      count: assertions.length,
      strategy
    });

    // Filter by strategy
    let assertionsToValidate = assertions;
    if (strategy === ValidationStrategy.CRITICAL_ONLY) {
      assertionsToValidate = assertions.filter(
        a => a.payload?.severity === AssertionSeverity.CRITICAL
      );
    }

    if (this.parallelValidation && strategy !== ValidationStrategy.FAIL_FAST) {
      // Parallel validation
      const validationPromises = assertionsToValidate.map(
        assertion => this.validateAssertion(assertion)
      );
      const validatedAssertions = await Promise.all(validationPromises);
      results.push(...validatedAssertions);
    } else {
      // Sequential validation
      for (const assertion of assertionsToValidate) {
        const validatedAssertion = await this.validateAssertion(assertion);
        results.push(validatedAssertion);

        // Check for critical failure in fail-fast mode
        if (strategy === ValidationStrategy.FAIL_FAST) {
          const result = validatedAssertion.payload?.result;
          if (!result?.valid && assertion.payload?.severity === AssertionSeverity.CRITICAL) {
            criticalFailure = true;
            this.logger.warn('Critical assertion failed, stopping validation', {
              assertionId: assertion.payload?.assertionId
            });
            break;
          }
        }
      }
    }

    // Generate summary
    const summary = this.generateSummary(results, criticalFailure);

    return {
      assertions: results,
      summary,
      validatedAt: new Date().toISOString(),
      strategy,
      stoppedEarly: criticalFailure
    };
  }

  /**
   * Validate custom assertion using registered validator
   */
  async validateCustomAssertion(assertion) {
    const startTime = Date.now();
    const customType = assertion.payload?.claim?.context?.customType;

    if (!customType) {
      return this.createErrorResult(
        assertion,
        'Custom assertion missing customType in claim.context',
        startTime
      );
    }

    const validator = this.customValidators.get(customType);
    if (!validator) {
      return this.createErrorResult(
        assertion,
        `No custom validator registered for type: ${customType}`,
        startTime
      );
    }

    try {
      return await this.withTimeout(validator(assertion, this));
    } catch (error) {
      return this.createErrorResult(assertion, error.message, startTime);
    }
  }

  /**
   * Create result for unsupported assertion type
   */
  createUnsupportedResult(assertion, assertionType, startTime) {
    const validationResult = createValidationResult({
      valid: false,
      validatedBy: 'automated',
      confidence: 0,
      durationMs: Date.now() - startTime,
      notes: `Unsupported assertion type: ${assertionType}`
    });

    validationResult.violations = [
      createViolation(
        'UNSUPPORTED_ASSERTION_TYPE',
        `Assertion type "${assertionType}" is not supported`,
        AssertionSeverity.MAJOR
      )
    ];

    assertion.payload.result = validationResult;
    assertion._meta = assertion._meta || {};
    assertion._meta.validationAttempted = true;

    return assertion;
  }

  /**
   * Create error result
   */
  createErrorResult(assertion, errorMessage, startTime) {
    const validationResult = createValidationResult({
      valid: false,
      validatedBy: 'automated',
      confidence: 0,
      durationMs: Date.now() - startTime,
      notes: `Validation error: ${errorMessage}`
    });

    validationResult.violations = [
      createViolation(
        'VALIDATION_ERROR',
        errorMessage,
        AssertionSeverity.MAJOR,
        { error: errorMessage }
      )
    ];

    assertion.payload = assertion.payload || {};
    assertion.payload.result = validationResult;
    assertion._meta = assertion._meta || {};
    assertion._meta.validationAttempted = true;

    return assertion;
  }

  /**
   * Wrap validation in timeout
   */
  async withTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Validation timeout after ${this.validationTimeout}ms`)),
          this.validationTimeout
        )
      )
    ]);
  }

  /**
   * Generate validation summary
   */
  generateSummary(assertions, stoppedEarly = false) {
    const total = assertions.length;
    let passed = 0;
    let failed = 0;
    let errors = 0;
    const bySeverity = {};
    const byType = {};

    for (const assertion of assertions) {
      const result = assertion.payload?.result;
      const severity = assertion.payload?.severity || 'unknown';
      const type = assertion.payload?.assertionType || 'unknown';

      // Count by result
      if (result?.valid) {
        passed++;
      } else if (result?.violations?.some(v => v.code === 'VALIDATION_ERROR')) {
        errors++;
      } else {
        failed++;
      }

      // Count by severity
      bySeverity[severity] = bySeverity[severity] || { total: 0, passed: 0, failed: 0 };
      bySeverity[severity].total++;
      if (result?.valid) {
        bySeverity[severity].passed++;
      } else {
        bySeverity[severity].failed++;
      }

      // Count by type
      byType[type] = byType[type] || { total: 0, passed: 0, failed: 0 };
      byType[type].total++;
      if (result?.valid) {
        byType[type].passed++;
      } else {
        byType[type].failed++;
      }
    }

    // Calculate overall confidence
    const confidences = assertions
      .map(a => a.payload?.result?.confidence)
      .filter(c => typeof c === 'number');
    const avgConfidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

    // Check for critical failures
    const criticalFailures = assertions.filter(a =>
      a.payload?.severity === AssertionSeverity.CRITICAL &&
      !a.payload?.result?.valid
    );

    return {
      total,
      passed,
      failed,
      errors,
      passRate: total > 0 ? passed / total : 0,
      averageConfidence: avgConfidence,
      bySeverity,
      byType,
      criticalFailures: criticalFailures.length,
      hasCriticalFailure: criticalFailures.length > 0,
      stoppedEarly
    };
  }

  /**
   * Quick check - validate and return boolean
   */
  async quickCheck(assertions) {
    const result = await this.validateAssertions(assertions, {
      strategy: ValidationStrategy.FAIL_FAST
    });
    return result.summary.hasCriticalFailure === false && result.summary.failed === 0;
  }

  /**
   * Get all critical violations from validated assertions
   */
  getCriticalViolations(assertions) {
    const violations = [];

    for (const assertion of assertions) {
      if (!assertion.payload?.result?.valid) {
        const assertionViolations = assertion.payload?.result?.violations || [];
        for (const violation of assertionViolations) {
          if (violation.severity === AssertionSeverity.CRITICAL) {
            violations.push({
              assertionId: assertion.payload?.assertionId,
              assertionType: assertion.payload?.assertionType,
              ...violation
            });
          }
        }
      }
    }

    return violations;
  }
}

export default AssertionEngine;
