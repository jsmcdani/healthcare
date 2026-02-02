/**
 * GuidelineAssertion - Validates alignment with clinical guidelines
 *
 * Checks decisions against established clinical guidelines from
 * NICE, AHA, USPSTF, IDSA, and other authoritative bodies.
 */

import {
  AssertionTypes,
  AssertionSeverity,
  createCorrectnessAssertion,
  createValidationResult,
  createViolation
} from '../CorrectnessAssertionEnvelope.js';

/**
 * Guideline compliance levels
 */
export const ComplianceLevel = {
  FULLY_COMPLIANT: 'fully_compliant',
  PARTIALLY_COMPLIANT: 'partially_compliant',
  NON_COMPLIANT: 'non_compliant',
  NOT_APPLICABLE: 'not_applicable',
  UNABLE_TO_ASSESS: 'unable_to_assess'
};

/**
 * Guideline recommendation strength
 */
export const RecommendationStrength = {
  STRONG: 'strong',         // "Should" / "Should not"
  MODERATE: 'moderate',     // "Probably should" / "Probably should not"
  WEAK: 'weak',             // "May consider"
  EXPERT_OPINION: 'expert_opinion'
};

/**
 * Evidence quality levels
 */
export const EvidenceQuality = {
  HIGH: 'high',
  MODERATE: 'moderate',
  LOW: 'low',
  VERY_LOW: 'very_low'
};

/**
 * Create a guideline alignment assertion
 */
export function createGuidelineAssertion(options) {
  const {
    guidelineId,
    guidelineName,
    publisher,
    recommendation,
    actualPractice,
    patientContext = {},
    recommendationStrength = RecommendationStrength.STRONG,
    evidenceQuality = EvidenceQuality.MODERATE,
    description,
    severity,
    ...rest
  } = options;

  // Set severity based on recommendation strength
  const assertionSeverity = severity || (
    recommendationStrength === RecommendationStrength.STRONG
      ? AssertionSeverity.MAJOR
      : recommendationStrength === RecommendationStrength.MODERATE
        ? AssertionSeverity.MINOR
        : AssertionSeverity.ADVISORY
  );

  return createCorrectnessAssertion({
    assertionType: AssertionTypes.GUIDELINE_ALIGNED,
    claim: {
      subject: `guideline:${guidelineId}`,
      predicate: 'is_aligned_with',
      object: {
        guidelineId,
        guidelineName,
        publisher,
        recommendation,
        actualPractice,
        recommendationStrength,
        evidenceQuality
      },
      context: patientContext
    },
    severity: assertionSeverity,
    description: description || `Verify practice aligns with ${guidelineName || guidelineId}`,
    ...rest
  });
}

/**
 * Create a treatment target assertion (e.g., A1c < 7%)
 */
export function createTreatmentTargetAssertion(options) {
  const {
    guidelineId,
    guidelineName,
    targetName,
    targetValue,
    operator, // '<', '<=', '>', '>=', '=', 'between'
    actualValue,
    unit,
    patientContext = {},
    description,
    severity = AssertionSeverity.MAJOR,
    ...rest
  } = options;

  return createCorrectnessAssertion({
    assertionType: AssertionTypes.GUIDELINE_ALIGNED,
    claim: {
      subject: `target:${targetName}`,
      predicate: 'meets_guideline_target',
      object: {
        guidelineId,
        guidelineName,
        targetName,
        targetValue,
        operator,
        actualValue,
        unit,
        isTargetCheck: true
      },
      context: patientContext
    },
    severity,
    description: description || `Verify ${targetName} (${actualValue} ${unit}) meets guideline target`,
    ...rest
  });
}

/**
 * Validate a guideline assertion
 */
export async function validateGuidelineAssertion(assertion, guidelineRegistry = null) {
  const startTime = Date.now();
  const claimObject = assertion.payload.claim.object;
  const evidenceBasis = [];

  // Check if this is a treatment target check
  if (claimObject.isTargetCheck) {
    return validateTreatmentTarget(assertion, startTime);
  }

  // For general guideline checks, we need a guideline registry
  // This is typically a knowledge base lookup
  if (!guidelineRegistry) {
    return validateWithoutRegistry(assertion, startTime);
  }

  try {
    // Query guideline registry for the specific guideline
    const guidelineResult = await guidelineRegistry.getGuideline(claimObject.guidelineId);

    if (!guidelineResult) {
      evidenceBasis.push({
        sourceId: 'guideline-registry',
        resultSummary: `Guideline ${claimObject.guidelineId} not found in registry`,
        confidence: 0.3
      });

      return createInconclusiveResult(assertion, evidenceBasis, startTime,
        `Guideline ${claimObject.guidelineId} not available for validation`);
    }

    // Compare actual practice with recommendation
    const complianceLevel = assessCompliance(
      claimObject.actualPractice,
      claimObject.recommendation,
      guidelineResult
    );

    evidenceBasis.push({
      sourceId: guidelineResult.sourceId || claimObject.guidelineId,
      sourceName: claimObject.guidelineName,
      sourceVersion: guidelineResult.version,
      queryUsed: `getGuideline("${claimObject.guidelineId}")`,
      queryResult: guidelineResult,
      resultSummary: `Compliance assessment: ${complianceLevel}`,
      confidence: guidelineResult.confidence || 0.9
    });

    const isCompliant = complianceLevel === ComplianceLevel.FULLY_COMPLIANT ||
                        complianceLevel === ComplianceLevel.PARTIALLY_COMPLIANT;

    const validationResult = createValidationResult({
      valid: isCompliant,
      validatedBy: 'ground_truth',
      confidence: guidelineResult.confidence || 0.9,
      durationMs: Date.now() - startTime
    });

    if (!isCompliant) {
      validationResult.violations = [
        createViolation(
          'GUIDELINE_NON_COMPLIANT',
          `Practice does not align with ${claimObject.guidelineName || claimObject.guidelineId}: ${claimObject.recommendation}`,
          assertion.payload.severity,
          {
            guidelineId: claimObject.guidelineId,
            recommendation: claimObject.recommendation,
            actualPractice: claimObject.actualPractice,
            complianceLevel,
            recommendationStrength: claimObject.recommendationStrength,
            evidenceQuality: claimObject.evidenceQuality
          }
        )
      ];
    }

    assertion.payload.evidenceBasis = evidenceBasis;
    assertion.payload.result = validationResult;
    assertion._meta.validationAttempted = true;

    return assertion;

  } catch (error) {
    return createErrorResult(assertion, error.message, startTime);
  }
}

/**
 * Validate treatment target (numeric comparison)
 */
function validateTreatmentTarget(assertion, startTime) {
  const claimObject = assertion.payload.claim.object;
  const { targetValue, operator, actualValue, targetName, unit } = claimObject;
  const evidenceBasis = [];

  let meetsTarget = false;

  switch (operator) {
    case '<':
      meetsTarget = actualValue < targetValue;
      break;
    case '<=':
      meetsTarget = actualValue <= targetValue;
      break;
    case '>':
      meetsTarget = actualValue > targetValue;
      break;
    case '>=':
      meetsTarget = actualValue >= targetValue;
      break;
    case '=':
      meetsTarget = actualValue === targetValue;
      break;
    case 'between':
      if (Array.isArray(targetValue) && targetValue.length === 2) {
        meetsTarget = actualValue >= targetValue[0] && actualValue <= targetValue[1];
      }
      break;
  }

  const targetDescription = operator === 'between'
    ? `${targetValue[0]}-${targetValue[1]} ${unit}`
    : `${operator} ${targetValue} ${unit}`;

  evidenceBasis.push({
    sourceId: claimObject.guidelineId || 'treatment-target',
    sourceName: claimObject.guidelineName,
    resultSummary: meetsTarget
      ? `${targetName} ${actualValue} ${unit} meets target (${targetDescription})`
      : `${targetName} ${actualValue} ${unit} does not meet target (${targetDescription})`,
    confidence: 1.0
  });

  const validationResult = createValidationResult({
    valid: meetsTarget,
    validatedBy: 'automated',
    confidence: 1.0,
    durationMs: Date.now() - startTime
  });

  if (!meetsTarget) {
    validationResult.violations = [
      createViolation(
        'TARGET_NOT_MET',
        `${targetName} of ${actualValue} ${unit} does not meet guideline target of ${targetDescription}`,
        assertion.payload.severity,
        {
          targetName,
          actualValue,
          targetValue,
          operator,
          unit,
          guidelineId: claimObject.guidelineId
        }
      )
    ];
  }

  assertion.payload.evidenceBasis = evidenceBasis;
  assertion.payload.result = validationResult;
  assertion._meta.validationAttempted = true;

  return assertion;
}

/**
 * Validate without registry (basic semantic comparison)
 */
function validateWithoutRegistry(assertion, startTime) {
  const claimObject = assertion.payload.claim.object;
  const evidenceBasis = [];

  // Without a registry, we can only do basic validation
  // Check if actual practice matches or contains the recommendation
  const recommendation = (claimObject.recommendation || '').toLowerCase();
  const practice = (claimObject.actualPractice || '').toLowerCase();

  const appearsSimilar = practice.includes(recommendation) ||
                         recommendation.includes(practice);

  evidenceBasis.push({
    sourceId: claimObject.guidelineId || 'manual',
    sourceName: claimObject.guidelineName,
    resultSummary: `Basic semantic comparison (no registry): ${appearsSimilar ? 'appears aligned' : 'may not be aligned'}`,
    confidence: 0.4 // Low confidence without proper validation
  });

  const validationResult = createValidationResult({
    valid: appearsSimilar,
    validatedBy: 'automated',
    confidence: 0.4,
    durationMs: Date.now() - startTime,
    notes: 'Validation performed without guideline registry - low confidence result'
  });

  if (!appearsSimilar) {
    validationResult.violations = [
      createViolation(
        'GUIDELINE_ALIGNMENT_UNCLEAR',
        `Cannot confirm alignment with guideline: ${claimObject.guidelineName || claimObject.guidelineId}`,
        AssertionSeverity.ADVISORY,
        {
          recommendation: claimObject.recommendation,
          actualPractice: claimObject.actualPractice,
          note: 'Manual review recommended'
        }
      )
    ];
  }

  assertion.payload.evidenceBasis = evidenceBasis;
  assertion.payload.result = validationResult;
  assertion._meta.validationAttempted = true;

  return assertion;
}

/**
 * Assess compliance level
 */
function assessCompliance(actualPractice, recommendation, guidelineData) {
  // This would be more sophisticated in a real implementation
  // potentially using NLP or structured comparison

  if (!actualPractice) return ComplianceLevel.UNABLE_TO_ASSESS;
  if (!recommendation) return ComplianceLevel.NOT_APPLICABLE;

  const practice = actualPractice.toLowerCase();
  const rec = recommendation.toLowerCase();

  if (practice === rec) return ComplianceLevel.FULLY_COMPLIANT;
  if (practice.includes(rec) || rec.includes(practice)) return ComplianceLevel.PARTIALLY_COMPLIANT;

  return ComplianceLevel.NON_COMPLIANT;
}

/**
 * Create inconclusive result
 */
function createInconclusiveResult(assertion, evidenceBasis, startTime, reason) {
  const validationResult = createValidationResult({
    valid: false,
    validatedBy: 'automated',
    confidence: 0.3,
    durationMs: Date.now() - startTime,
    notes: reason
  });

  validationResult.violations = [
    createViolation(
      'VALIDATION_INCONCLUSIVE',
      reason,
      AssertionSeverity.ADVISORY
    )
  ];

  assertion.payload.evidenceBasis = evidenceBasis;
  assertion.payload.result = validationResult;
  assertion._meta.validationAttempted = true;

  return assertion;
}

/**
 * Create error result
 */
function createErrorResult(assertion, errorMessage, startTime) {
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
      `Failed to validate guideline alignment: ${errorMessage}`,
      AssertionSeverity.MAJOR
    )
  ];

  assertion.payload.evidenceBasis = [];
  assertion.payload.result = validationResult;
  assertion._meta.validationAttempted = true;

  return assertion;
}

export default {
  createGuidelineAssertion,
  createTreatmentTargetAssertion,
  validateGuidelineAssertion,
  ComplianceLevel,
  RecommendationStrength,
  EvidenceQuality
};
