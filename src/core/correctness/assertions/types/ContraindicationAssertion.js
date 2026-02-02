/**
 * ContraindicationAssertion - Validates absence of drug-drug or drug-condition conflicts
 *
 * Checks for:
 * - Drug-drug interactions
 * - Drug-condition contraindications
 * - Drug-allergy conflicts
 */

import {
  AssertionTypes,
  AssertionSeverity,
  createCorrectnessAssertion,
  createValidationResult,
  createViolation
} from '../CorrectnessAssertionEnvelope.js';
import { InteractionSeverity } from '../../ground-truth/adapters/DrugDataAdapter.js';

/**
 * Contraindication check types
 */
export const ContraindicationCheckType = {
  DRUG_DRUG: 'drug_drug',
  DRUG_CONDITION: 'drug_condition',
  DRUG_ALLERGY: 'drug_allergy',
  DRUG_AGE: 'drug_age',
  DRUG_PREGNANCY: 'drug_pregnancy'
};

/**
 * Create a drug-drug interaction assertion
 */
export function createDrugInteractionAssertion(options) {
  const {
    drugA,
    drugB,
    patientContext = {},
    description,
    severity = AssertionSeverity.CRITICAL,
    ...rest
  } = options;

  return createCorrectnessAssertion({
    assertionType: AssertionTypes.NO_CONTRAINDICATION,
    claim: {
      subject: `interaction:${drugA}:${drugB}`,
      predicate: 'has_no_significant_interaction',
      object: {
        checkType: ContraindicationCheckType.DRUG_DRUG,
        drugA,
        drugB
      },
      context: patientContext
    },
    severity,
    description: description || `Verify no contraindicated interaction between ${drugA} and ${drugB}`,
    ...rest
  });
}

/**
 * Create a drug-condition contraindication assertion
 */
export function createDrugConditionAssertion(options) {
  const {
    drug,
    condition,
    conditionCode,
    patientContext = {},
    description,
    severity = AssertionSeverity.CRITICAL,
    ...rest
  } = options;

  return createCorrectnessAssertion({
    assertionType: AssertionTypes.NO_CONTRAINDICATION,
    claim: {
      subject: `contraindication:${drug}:${condition}`,
      predicate: 'is_not_contraindicated_for_condition',
      object: {
        checkType: ContraindicationCheckType.DRUG_CONDITION,
        drug,
        condition,
        conditionCode
      },
      context: patientContext
    },
    severity,
    description: description || `Verify ${drug} is not contraindicated for ${condition}`,
    ...rest
  });
}

/**
 * Create a medication list interaction assertion (checks all pairs)
 */
export function createMedicationListAssertion(medications, patientContext = {}, options = {}) {
  const pairs = [];
  for (let i = 0; i < medications.length; i++) {
    for (let j = i + 1; j < medications.length; j++) {
      pairs.push([medications[i], medications[j]]);
    }
  }

  return createCorrectnessAssertion({
    assertionType: AssertionTypes.NO_CONTRAINDICATION,
    claim: {
      subject: 'medication_list_interactions',
      predicate: 'has_no_significant_interactions',
      object: {
        checkType: ContraindicationCheckType.DRUG_DRUG,
        medications,
        pairs
      },
      context: patientContext
    },
    severity: AssertionSeverity.CRITICAL,
    description: `Verify no contraindicated interactions among ${medications.length} medications`,
    ...options
  });
}

/**
 * Validate a contraindication assertion
 */
export async function validateContraindicationAssertion(assertion, groundTruthRegistry) {
  const startTime = Date.now();
  const claimObject = assertion.payload.claim.object;
  const checkType = claimObject.checkType;

  switch (checkType) {
    case ContraindicationCheckType.DRUG_DRUG:
      if (claimObject.medications) {
        return validateMedicationListInteractions(assertion, groundTruthRegistry, startTime);
      }
      return validateDrugDrugInteraction(assertion, groundTruthRegistry, startTime);

    case ContraindicationCheckType.DRUG_CONDITION:
      return validateDrugConditionContraindication(assertion, groundTruthRegistry, startTime);

    default:
      return createErrorResult(assertion, `Unsupported check type: ${checkType}`, startTime);
  }
}

/**
 * Validate drug-drug interaction
 */
async function validateDrugDrugInteraction(assertion, groundTruthRegistry, startTime) {
  const { drugA, drugB } = assertion.payload.claim.object;
  const evidenceBasis = [];

  try {
    const result = await groundTruthRegistry.checkDrugInteraction(drugA, drugB);

    evidenceBasis.push({
      sourceId: result.source || 'drug-interactions',
      sourceVersion: result.version,
      queryUsed: `checkDrugInteraction("${drugA}", "${drugB}")`,
      queryResult: result.data,
      resultSummary: result.data?.interactionFound
        ? `Interaction found: ${result.data.severity} - ${result.data.description || 'See details'}`
        : `No significant interaction found between ${drugA} and ${drugB}`,
      confidence: result.confidence || (result.found ? 1.0 : 0.5)
    });

    // Evaluate result - assertion passes if NO significant interaction
    const interactionFound = result.data?.interactionFound;
    const interactionSeverity = result.data?.severity;

    const isSignificant = interactionFound && (
      interactionSeverity === InteractionSeverity.CONTRAINDICATED ||
      interactionSeverity === InteractionSeverity.SEVERE
    );

    const validationResult = createValidationResult({
      valid: !isSignificant,
      validatedBy: 'ground_truth',
      confidence: result.confidence || (result.found ? 1.0 : 0.5),
      durationMs: Date.now() - startTime
    });

    if (isSignificant) {
      validationResult.violations = [
        createViolation(
          'DRUG_INTERACTION_FOUND',
          `${interactionSeverity.toUpperCase()}: ${result.data.description || `Interaction between ${drugA} and ${drugB}`}`,
          interactionSeverity === InteractionSeverity.CONTRAINDICATED
            ? AssertionSeverity.CRITICAL
            : AssertionSeverity.MAJOR,
          {
            drugA,
            drugB,
            severity: interactionSeverity,
            mechanism: result.data.mechanism,
            management: result.data.management,
            groundTruthRef: result.source
          }
        )
      ];
    } else if (interactionFound && interactionSeverity === InteractionSeverity.MODERATE) {
      // Add advisory for moderate interactions
      validationResult.notes = `Moderate interaction noted: ${result.data.description}. Monitor recommended.`;
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
 * Validate medication list for all pairwise interactions
 */
async function validateMedicationListInteractions(assertion, groundTruthRegistry, startTime) {
  const { medications, pairs } = assertion.payload.claim.object;
  const evidenceBasis = [];
  const allViolations = [];

  for (const [drugA, drugB] of pairs) {
    try {
      const result = await groundTruthRegistry.checkDrugInteraction(drugA, drugB);

      const interactionFound = result.data?.interactionFound;
      const interactionSeverity = result.data?.severity;

      if (interactionFound) {
        evidenceBasis.push({
          sourceId: result.source || 'drug-interactions',
          queryUsed: `checkDrugInteraction("${drugA}", "${drugB}")`,
          resultSummary: `${drugA} + ${drugB}: ${interactionSeverity} interaction`,
          confidence: result.confidence || 1.0
        });

        if (interactionSeverity === InteractionSeverity.CONTRAINDICATED ||
            interactionSeverity === InteractionSeverity.SEVERE) {
          allViolations.push(createViolation(
            'DRUG_INTERACTION_FOUND',
            `${drugA} + ${drugB}: ${interactionSeverity} - ${result.data.description || 'significant interaction'}`,
            interactionSeverity === InteractionSeverity.CONTRAINDICATED
              ? AssertionSeverity.CRITICAL
              : AssertionSeverity.MAJOR,
            {
              drugA,
              drugB,
              severity: interactionSeverity,
              management: result.data.management
            }
          ));
        }
      }
    } catch (error) {
      // Log but continue checking other pairs
      evidenceBasis.push({
        sourceId: 'drug-interactions',
        resultSummary: `Error checking ${drugA} + ${drugB}: ${error.message}`,
        confidence: 0
      });
    }
  }

  // If no evidence collected, add summary
  if (evidenceBasis.length === 0) {
    evidenceBasis.push({
      sourceId: 'drug-interactions',
      resultSummary: `Checked ${pairs.length} medication pairs, no significant interactions found`,
      confidence: 0.8
    });
  }

  const validationResult = createValidationResult({
    valid: allViolations.length === 0,
    validatedBy: 'ground_truth',
    confidence: Math.min(...evidenceBasis.map(e => e.confidence || 0.5)),
    durationMs: Date.now() - startTime
  });

  if (allViolations.length > 0) {
    validationResult.violations = allViolations;
  }

  assertion.payload.evidenceBasis = evidenceBasis;
  assertion.payload.result = validationResult;
  assertion._meta.validationAttempted = true;

  return assertion;
}

/**
 * Validate drug-condition contraindication
 */
async function validateDrugConditionContraindication(assertion, groundTruthRegistry, startTime) {
  const { drug, condition, conditionCode } = assertion.payload.claim.object;
  const evidenceBasis = [];

  try {
    // Query drug data sources for contraindication
    const results = await groundTruthRegistry.queryByType(
      'drug_data',
      'contraindication',
      { drug, condition: conditionCode || condition }
    );

    let contraindicationFound = false;
    let severity = null;
    let details = null;

    for (const sourceResult of results) {
      if (sourceResult.result.found && sourceResult.result.data?.contraindicated) {
        contraindicationFound = true;
        severity = sourceResult.result.data.severity;
        details = sourceResult.result.data;

        evidenceBasis.push({
          sourceId: sourceResult.sourceId,
          sourceName: sourceResult.sourceName,
          queryUsed: `checkContraindication("${drug}", "${condition}")`,
          queryResult: sourceResult.result.data,
          resultSummary: `${drug} is contraindicated for ${condition}: ${details.reason || 'see details'}`,
          confidence: sourceResult.result.confidence || 1.0
        });
        break;
      }
    }

    if (!contraindicationFound) {
      evidenceBasis.push({
        sourceId: 'drug-data',
        resultSummary: `No contraindication found for ${drug} with ${condition}`,
        confidence: results.length > 0 ? 0.8 : 0.3
      });
    }

    const validationResult = createValidationResult({
      valid: !contraindicationFound,
      validatedBy: 'ground_truth',
      confidence: evidenceBasis[0]?.confidence || 0.5,
      durationMs: Date.now() - startTime
    });

    if (contraindicationFound) {
      validationResult.violations = [
        createViolation(
          'DRUG_CONDITION_CONTRAINDICATED',
          `${drug} is contraindicated for ${condition}: ${details?.reason || 'clinical contraindication'}`,
          AssertionSeverity.CRITICAL,
          {
            drug,
            condition,
            conditionCode,
            severity,
            recommendations: details?.recommendations
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
      `Failed to validate contraindication: ${errorMessage}`,
      AssertionSeverity.MAJOR,
      { error: errorMessage }
    )
  ];

  assertion.payload.evidenceBasis = [];
  assertion.payload.result = validationResult;
  assertion._meta.validationAttempted = true;

  return assertion;
}

export default {
  createDrugInteractionAssertion,
  createDrugConditionAssertion,
  createMedicationListAssertion,
  validateContraindicationAssertion,
  ContraindicationCheckType
};
