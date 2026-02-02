/**
 * RangeAssertion - Validates that values fall within reference ranges
 *
 * Used for lab values, vital signs, dosages, and other numeric values
 * that have defined normal/abnormal ranges.
 */

import {
  AssertionTypes,
  AssertionSeverity,
  createCorrectnessAssertion,
  createValidationResult,
  createViolation
} from '../CorrectnessAssertionEnvelope.js';
import { RangeFlags } from '../../ground-truth/adapters/ReferenceRangeAdapter.js';

/**
 * Range expectations
 */
export const RangeExpectation = {
  NORMAL: 'normal',           // Value should be in normal range
  WITHIN_LIMITS: 'within_limits', // Value should not be critical
  BELOW_THRESHOLD: 'below_threshold',
  ABOVE_THRESHOLD: 'above_threshold',
  BETWEEN: 'between'
};

/**
 * Create a range validation assertion
 */
export function createRangeAssertion(options) {
  const {
    test,
    value,
    unit,
    patientContext = {},
    expectation = RangeExpectation.NORMAL,
    customRange,
    description,
    severity = AssertionSeverity.MAJOR,
    ...rest
  } = options;

  return createCorrectnessAssertion({
    assertionType: AssertionTypes.VALUE_IN_RANGE,
    claim: {
      subject: `lab:${test}`,
      predicate: 'is_within_range',
      object: {
        test,
        value,
        unit,
        expectation,
        customRange
      },
      context: patientContext
    },
    severity,
    description: description || `Verify ${test} value ${value} ${unit} is ${expectation}`,
    ...rest
  });
}

/**
 * Validate a range assertion against ground truth
 */
export async function validateRangeAssertion(assertion, groundTruthRegistry) {
  const startTime = Date.now();
  const { test, value, unit, expectation, customRange } = assertion.payload.claim.object;
  const patientContext = assertion.payload.claim.context || {};
  const evidenceBasis = [];

  try {
    // Query ground truth for reference range
    const result = await groundTruthRegistry.evaluateLabValue(test, value, unit, patientContext);

    if (!result.found) {
      // Try custom range if provided
      if (customRange) {
        return validateAgainstCustomRange(assertion, customRange, startTime);
      }

      // No range found
      evidenceBasis.push({
        sourceId: 'reference-ranges',
        resultSummary: `No reference range found for ${test}`,
        confidence: 0.3
      });

      const validationResult = createValidationResult({
        valid: false,
        validatedBy: 'ground_truth',
        confidence: 0.3,
        durationMs: Date.now() - startTime,
        notes: 'No applicable reference range found'
      });

      validationResult.violations = [
        createViolation(
          'NO_REFERENCE_RANGE',
          `No reference range available for ${test} with given patient context`,
          AssertionSeverity.MINOR,
          { test, patientContext }
        )
      ];

      assertion.payload.evidenceBasis = evidenceBasis;
      assertion.payload.result = validationResult;
      assertion._meta.validationAttempted = true;

      return assertion;
    }

    // Build evidence from result
    evidenceBasis.push({
      sourceId: result.source || 'reference-ranges',
      sourceVersion: result.version,
      queryUsed: `evaluateValue("${test}", ${value}, "${unit}", ${JSON.stringify(patientContext)})`,
      queryResult: result.data,
      resultSummary: result.data?.interpretation || `${test}: ${result.data?.flag}`,
      confidence: result.confidence || 1.0
    });

    // Evaluate based on expectation
    const { passed, violations } = evaluateExpectation(
      result.data,
      expectation,
      assertion.payload.severity
    );

    const validationResult = createValidationResult({
      valid: passed,
      validatedBy: 'ground_truth',
      confidence: result.confidence || 1.0,
      durationMs: Date.now() - startTime
    });

    if (!passed) {
      validationResult.violations = violations;
    }

    assertion.payload.evidenceBasis = evidenceBasis;
    assertion.payload.result = validationResult;
    assertion._meta.validationAttempted = true;

    return assertion;

  } catch (error) {
    const validationResult = createValidationResult({
      valid: false,
      validatedBy: 'automated',
      confidence: 0,
      durationMs: Date.now() - startTime,
      notes: `Validation error: ${error.message}`
    });

    validationResult.violations = [
      createViolation(
        'VALIDATION_ERROR',
        `Failed to validate range: ${error.message}`,
        AssertionSeverity.MAJOR,
        { error: error.message }
      )
    ];

    assertion.payload.evidenceBasis = evidenceBasis;
    assertion.payload.result = validationResult;
    assertion._meta.validationAttempted = true;

    return assertion;
  }
}

/**
 * Evaluate result against expectation
 */
function evaluateExpectation(rangeResult, expectation, severity) {
  const flag = rangeResult?.flag;
  const violations = [];
  let passed = false;

  switch (expectation) {
    case RangeExpectation.NORMAL:
      passed = flag === RangeFlags.NORMAL;
      if (!passed) {
        violations.push(createViolation(
          'VALUE_NOT_NORMAL',
          rangeResult?.interpretation || `Value is ${flag}, expected normal`,
          flag === RangeFlags.CRITICAL_LOW || flag === RangeFlags.CRITICAL_HIGH
            ? AssertionSeverity.CRITICAL
            : severity,
          {
            flag,
            referenceRange: rangeResult?.referenceRange,
            value: rangeResult?.value
          }
        ));
      }
      break;

    case RangeExpectation.WITHIN_LIMITS:
      passed = flag !== RangeFlags.CRITICAL_LOW && flag !== RangeFlags.CRITICAL_HIGH;
      if (!passed) {
        violations.push(createViolation(
          'VALUE_CRITICAL',
          rangeResult?.interpretation || `Value is critically ${flag === RangeFlags.CRITICAL_LOW ? 'low' : 'high'}`,
          AssertionSeverity.CRITICAL,
          {
            flag,
            referenceRange: rangeResult?.referenceRange,
            value: rangeResult?.value
          }
        ));
      }
      break;

    default:
      passed = flag === RangeFlags.NORMAL;
      if (!passed) {
        violations.push(createViolation(
          'VALUE_OUT_OF_EXPECTED_RANGE',
          rangeResult?.interpretation || `Value does not meet expectation: ${expectation}`,
          severity,
          { flag, expectation }
        ));
      }
  }

  return { passed, violations };
}

/**
 * Validate against a custom range (when no ground truth available)
 */
function validateAgainstCustomRange(assertion, customRange, startTime) {
  const { test, value, unit } = assertion.payload.claim.object;
  const evidenceBasis = [];

  let flag = RangeFlags.NORMAL;

  if (customRange.criticalLow !== undefined && value < customRange.criticalLow) {
    flag = RangeFlags.CRITICAL_LOW;
  } else if (customRange.criticalHigh !== undefined && value > customRange.criticalHigh) {
    flag = RangeFlags.CRITICAL_HIGH;
  } else if (customRange.low !== undefined && value < customRange.low) {
    flag = RangeFlags.LOW;
  } else if (customRange.high !== undefined && value > customRange.high) {
    flag = RangeFlags.HIGH;
  }

  evidenceBasis.push({
    sourceId: 'custom-range',
    resultSummary: `Custom range validation: ${flag}`,
    confidence: 0.7 // Lower confidence for custom ranges
  });

  const isNormal = flag === RangeFlags.NORMAL;

  const validationResult = createValidationResult({
    valid: isNormal,
    validatedBy: 'automated',
    confidence: 0.7,
    durationMs: Date.now() - startTime,
    notes: 'Validated against custom range (no ground truth available)'
  });

  if (!isNormal) {
    validationResult.violations = [
      createViolation(
        'CUSTOM_RANGE_VIOLATION',
        `${test} value ${value} ${unit} is ${flag} per custom range`,
        flag === RangeFlags.CRITICAL_LOW || flag === RangeFlags.CRITICAL_HIGH
          ? AssertionSeverity.CRITICAL
          : assertion.payload.severity,
        { flag, customRange, value, unit }
      )
    ];
  }

  assertion.payload.evidenceBasis = evidenceBasis;
  assertion.payload.result = validationResult;
  assertion._meta.validationAttempted = true;

  return assertion;
}

/**
 * Create assertion for critical value detection
 */
export function createCriticalValueAssertion(test, value, unit, patientContext = {}, options = {}) {
  return createRangeAssertion({
    test,
    value,
    unit,
    patientContext,
    expectation: RangeExpectation.WITHIN_LIMITS,
    severity: AssertionSeverity.CRITICAL,
    description: `Verify ${test} value ${value} ${unit} is not at critical level`,
    ...options
  });
}

export default {
  createRangeAssertion,
  validateRangeAssertion,
  createCriticalValueAssertion,
  RangeExpectation
};
