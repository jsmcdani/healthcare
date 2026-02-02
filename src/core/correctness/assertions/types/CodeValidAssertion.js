/**
 * CodeValidAssertion - Validates that a code exists in a terminology system
 *
 * Verifies codes against ICD-10, SNOMED CT, LOINC, CPT, RxNorm, etc.
 */

import {
  AssertionTypes,
  AssertionSeverity,
  createCorrectnessAssertion,
  createValidationResult,
  createViolation
} from '../CorrectnessAssertionEnvelope.js';

/**
 * Create a code validation assertion
 */
export function createCodeValidAssertion(options) {
  const {
    code,
    system,
    expectedValid = true,
    description,
    severity = AssertionSeverity.MAJOR,
    ...rest
  } = options;

  return createCorrectnessAssertion({
    assertionType: AssertionTypes.CODE_VALID,
    claim: {
      subject: `code:${system}`,
      predicate: 'is_valid_in_terminology',
      object: { code, system, expectedValid },
      context: { originalCode: code }
    },
    severity,
    description: description || `Verify ${system} code "${code}" is valid`,
    ...rest
  });
}

/**
 * Validate a code assertion against ground truth
 */
export async function validateCodeAssertion(assertion, groundTruthRegistry) {
  const startTime = Date.now();
  const { code, system, expectedValid } = assertion.payload.claim.object;
  const evidenceBasis = [];

  try {
    // Query the ground truth registry
    const result = await groundTruthRegistry.validateCode(code, system);

    // Build evidence
    evidenceBasis.push({
      sourceId: result.source || 'terminology-source',
      sourceVersion: result.version,
      queryUsed: `validateCode("${code}", "${system}")`,
      queryResult: result.data,
      resultSummary: result.found
        ? (result.data?.valid
          ? `Code ${code} is valid in ${system}`
          : `Code ${code} is invalid: ${result.data?.reason || 'not found'}`)
        : `Unable to validate code ${code} in ${system}`,
      confidence: result.confidence || (result.found ? 1.0 : 0.5)
    });

    // Determine validation outcome
    const codeIsValid = result.found && result.data?.valid;
    const assertionPassed = (codeIsValid === expectedValid);

    const validationResult = createValidationResult({
      valid: assertionPassed,
      validatedBy: 'ground_truth',
      confidence: result.confidence || (result.found ? 1.0 : 0.5),
      durationMs: Date.now() - startTime
    });

    if (!assertionPassed) {
      validationResult.violations = [
        createViolation(
          'CODE_VALIDATION_FAILED',
          expectedValid
            ? `Code "${code}" is not valid in ${system}: ${result.data?.reason || 'not found in terminology'}`
            : `Code "${code}" was expected to be invalid but is valid in ${system}`,
          assertion.payload.severity,
          {
            groundTruthRef: result.source,
            details: {
              code,
              system,
              expectedValid,
              actualValid: codeIsValid,
              reason: result.data?.reason
            }
          }
        )
      ];
    }

    // Update assertion with evidence and result
    assertion.payload.evidenceBasis = evidenceBasis;
    assertion.payload.result = validationResult;
    assertion._meta.validationAttempted = true;

    return assertion;

  } catch (error) {
    // Validation error
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
        `Failed to validate code: ${error.message}`,
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
 * Batch validate multiple codes
 */
export async function batchValidateCodes(codes, system, groundTruthRegistry, options = {}) {
  const assertions = [];

  for (const code of codes) {
    const assertion = createCodeValidAssertion({
      code,
      system,
      ...options
    });

    const validated = await validateCodeAssertion(assertion, groundTruthRegistry);
    assertions.push(validated);
  }

  return {
    assertions,
    summary: {
      total: assertions.length,
      passed: assertions.filter(a => a.payload.result?.valid).length,
      failed: assertions.filter(a => a.payload.result && !a.payload.result.valid).length
    }
  };
}

export default {
  createCodeValidAssertion,
  validateCodeAssertion,
  batchValidateCodes
};
