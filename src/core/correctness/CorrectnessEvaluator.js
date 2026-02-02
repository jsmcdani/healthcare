/**
 * CorrectnessEvaluator - Evaluates decision artifacts for correctness
 *
 * Takes a decision artifact and:
 * 1. Extracts claims that need validation
 * 2. Creates assertions for each claim
 * 3. Validates assertions against ground truth
 * 4. Produces a correctness envelope
 */

import { Logger } from '../../utils/logger.js';
import { AssertionEngine, ValidationStrategy } from './assertions/AssertionEngine.js';
import {
  AssertionTypes,
  AssertionSeverity,
  createCorrectnessAssertion
} from './assertions/CorrectnessAssertionEnvelope.js';
import {
  createCodeValidAssertion
} from './assertions/types/CodeValidAssertion.js';
import {
  createRangeAssertion,
  createCriticalValueAssertion
} from './assertions/types/RangeAssertion.js';
import {
  createDrugInteractionAssertion,
  createDrugConditionAssertion,
  createMedicationListAssertion
} from './assertions/types/ContraindicationAssertion.js';
import {
  createGuidelineAssertion,
  createTreatmentTargetAssertion
} from './assertions/types/GuidelineAssertion.js';
import {
  createCorrectnessEnvelope,
  CorrectnessStatus,
  getStatusFromMetrics
} from './CorrectnessEnvelope.js';

/**
 * Review trigger thresholds
 */
export const ReviewTriggers = {
  CONFIDENCE_THRESHOLD: 0.7,
  CRITICAL_ASSERTION_FAILED: true,
  LLM_OUTPUT_CLINICAL: true,
  CALIBRATION_DEVIATION_THRESHOLD: 0.1
};

/**
 * Correctness Evaluator
 */
export class CorrectnessEvaluator {
  constructor(options = {}) {
    this.logger = new Logger('CorrectnessEvaluator');
    this.groundTruthRegistry = options.groundTruthRegistry;
    this.guidelineRegistry = options.guidelineRegistry;
    this.reviewTriggers = { ...ReviewTriggers, ...options.reviewTriggers };

    // Create assertion engine
    this.assertionEngine = new AssertionEngine({
      groundTruthRegistry: this.groundTruthRegistry,
      guidelineRegistry: this.guidelineRegistry,
      strategy: options.validationStrategy || ValidationStrategy.VALIDATE_ALL,
      parallelValidation: options.parallelValidation ?? true
    });

    // Claim extractors by artifact type
    this.claimExtractors = new Map();
    this.registerDefaultExtractors();
  }

  /**
   * Set ground truth registry
   */
  setGroundTruthRegistry(registry) {
    this.groundTruthRegistry = registry;
    this.assertionEngine.setGroundTruthRegistry(registry);
  }

  /**
   * Set guideline registry
   */
  setGuidelineRegistry(registry) {
    this.guidelineRegistry = registry;
    this.assertionEngine.setGuidelineRegistry(registry);
  }

  /**
   * Register a claim extractor for an artifact type
   */
  registerClaimExtractor(artifactType, extractor) {
    this.claimExtractors.set(artifactType, extractor);
    this.logger.debug('Registered claim extractor', { artifactType });
  }

  /**
   * Evaluate a decision artifact for correctness
   */
  async evaluate(options) {
    const startTime = Date.now();
    const {
      artifact,
      artifactType = 'DecisionArtifact',
      recipeId,
      outputs,
      additionalAssertions = [],
      patientContext = {}
    } = options;

    this.logger.info('Evaluating artifact for correctness', {
      artifactId: artifact?.id,
      artifactType,
      recipeId
    });

    try {
      // Step 1: Extract claims from artifact
      const assertions = await this.extractAssertions(
        artifact,
        artifactType,
        outputs,
        patientContext
      );

      // Add any additional assertions
      assertions.push(...additionalAssertions);

      this.logger.debug('Extracted assertions', { count: assertions.length });

      // Step 2: Validate all assertions
      const validationResult = await this.assertionEngine.validateAssertions(assertions);

      // Step 3: Collect ground truth sources used
      const groundTruthSources = this.collectGroundTruthSources(validationResult.assertions);

      // Step 4: Determine correctness status
      const status = getStatusFromMetrics(validationResult.summary);

      // Step 5: Determine if review is required
      const reviewRequirement = this.evaluateReviewRequirement(
        validationResult,
        artifact,
        recipeId
      );

      // Step 6: Create correctness envelope
      const envelope = createCorrectnessEnvelope({
        targetRef: {
          artifactId: artifact?.id || crypto.randomUUID(),
          artifactType,
          outputField: recipeId ? `recipe:${recipeId}` : undefined
        },
        assertions: validationResult.assertions,
        status,
        groundTruthSources,
        reviewRequirement,
        traceId: artifact?.traceId,
        evaluationDurationMs: Date.now() - startTime
      });

      this.logger.info('Correctness evaluation complete', {
        status,
        passed: validationResult.summary.passed,
        failed: validationResult.summary.failed,
        canProceed: envelope.payload.verdict.canProceed
      });

      return envelope;

    } catch (error) {
      this.logger.error('Correctness evaluation failed', { error: error.message });

      // Return failed envelope
      return createCorrectnessEnvelope({
        targetRef: {
          artifactId: artifact?.id || 'unknown',
          artifactType
        },
        assertions: [],
        status: CorrectnessStatus.UNVALIDATED,
        groundTruthSources: [],
        evaluationDurationMs: Date.now() - startTime
      });
    }
  }

  /**
   * Extract assertions from artifact
   */
  async extractAssertions(artifact, artifactType, outputs, patientContext) {
    const assertions = [];

    // Use registered extractor if available
    const extractor = this.claimExtractors.get(artifactType);
    if (extractor) {
      const extracted = await extractor(artifact, outputs, patientContext);
      assertions.push(...extracted);
    }

    // Extract from outputs if provided
    if (outputs) {
      const outputAssertions = this.extractFromOutputs(outputs, patientContext);
      assertions.push(...outputAssertions);
    }

    return assertions;
  }

  /**
   * Extract assertions from recipe outputs
   */
  extractFromOutputs(outputs, patientContext) {
    const assertions = [];

    // Look for specific output types that need validation
    for (const [key, value] of Object.entries(outputs)) {
      if (!value) continue;

      // Diagnosis codes
      if (key.toLowerCase().includes('diagnosis') || key.toLowerCase().includes('icd')) {
        const codes = Array.isArray(value) ? value : [value];
        for (const code of codes) {
          if (typeof code === 'string' || code?.code) {
            assertions.push(createCodeValidAssertion({
              code: code.code || code,
              system: code.system || 'ICD10_CM',
              severity: AssertionSeverity.MAJOR
            }));
          }
        }
      }

      // Medication codes/names
      if (key.toLowerCase().includes('medication') || key.toLowerCase().includes('drug')) {
        const meds = Array.isArray(value) ? value : [value];
        if (meds.length > 1) {
          // Check for interactions
          const medNames = meds.map(m => m.name || m.code || m);
          assertions.push(createMedicationListAssertion(medNames, patientContext));
        }
      }

      // Lab values
      if (key.toLowerCase().includes('lab') || value?.loincCode || value?.referenceRange) {
        if (typeof value?.value === 'number') {
          assertions.push(createRangeAssertion({
            test: value.test || value.name || key,
            value: value.value,
            unit: value.unit || '',
            patientContext,
            severity: value.critical ? AssertionSeverity.CRITICAL : AssertionSeverity.MAJOR
          }));
        }
      }

      // Treatment targets
      if (key.toLowerCase().includes('target') && value?.actual !== undefined) {
        assertions.push(createTreatmentTargetAssertion({
          targetName: value.name || key,
          targetValue: value.target,
          operator: value.operator || '<=',
          actualValue: value.actual,
          unit: value.unit || '',
          patientContext,
          guidelineId: value.guidelineId,
          guidelineName: value.guidelineName
        }));
      }
    }

    return assertions;
  }

  /**
   * Collect ground truth sources from assertions
   */
  collectGroundTruthSources(assertions) {
    const sources = new Map();

    for (const assertion of assertions) {
      const evidenceBasis = assertion.payload?.evidenceBasis || [];
      for (const evidence of evidenceBasis) {
        if (evidence.sourceId && !sources.has(evidence.sourceId)) {
          sources.set(evidence.sourceId, {
            sourceId: evidence.sourceId,
            sourceName: evidence.sourceName,
            version: evidence.sourceVersion,
            queriedAt: assertion.payload?.result?.validatedAt || new Date().toISOString()
          });
        }
      }
    }

    return Array.from(sources.values());
  }

  /**
   * Evaluate if expert review is required
   */
  evaluateReviewRequirement(validationResult, artifact, recipeId) {
    const reasons = [];
    let reviewerRole = null;

    // Check confidence threshold
    if (validationResult.summary.averageConfidence < this.reviewTriggers.CONFIDENCE_THRESHOLD) {
      reasons.push(`Confidence (${(validationResult.summary.averageConfidence * 100).toFixed(1)}%) below threshold`);
      reviewerRole = 'domain_expert';
    }

    // Check critical failures
    if (this.reviewTriggers.CRITICAL_ASSERTION_FAILED &&
        validationResult.summary.criticalFailures > 0) {
      reasons.push(`${validationResult.summary.criticalFailures} critical assertion(s) failed`);
      reviewerRole = 'clinical_pharmacist';
    }

    // Check if LLM output on clinical topic
    if (this.reviewTriggers.LLM_OUTPUT_CLINICAL && artifact?.metadata?.usedLLM) {
      const clinicalRecipes = ['clinical_decision', 'medication_review', 'diagnosis_support'];
      if (clinicalRecipes.some(r => recipeId?.includes(r))) {
        reasons.push('LLM-generated clinical output');
        reviewerRole = reviewerRole || 'physician';
      }
    }

    if (reasons.length === 0) {
      return { required: false };
    }

    return {
      required: true,
      reason: reasons.join('; '),
      reviewerRole,
      reviewStatus: 'pending'
    };
  }

  /**
   * Register default claim extractors
   */
  registerDefaultExtractors() {
    // Decision artifact extractor
    this.registerClaimExtractor('DecisionArtifact', async (artifact, outputs, patientContext) => {
      const assertions = [];

      // Extract from decision data
      if (artifact?.data?.medications) {
        const meds = artifact.data.medications;
        if (meds.length > 1) {
          assertions.push(createMedicationListAssertion(
            meds.map(m => m.name || m),
            patientContext
          ));
        }
      }

      if (artifact?.data?.diagnoses) {
        for (const dx of artifact.data.diagnoses) {
          if (dx.code) {
            assertions.push(createCodeValidAssertion({
              code: dx.code,
              system: dx.system || 'ICD10_CM'
            }));
          }
        }
      }

      return assertions;
    });

    // Drug interaction check extractor
    this.registerClaimExtractor('DrugInteractionCheck', async (artifact, outputs, patientContext) => {
      const assertions = [];

      if (outputs?.medications && outputs.medications.length > 1) {
        assertions.push(createMedicationListAssertion(
          outputs.medications,
          patientContext,
          { severity: AssertionSeverity.CRITICAL }
        ));
      }

      return assertions;
    });

    // Lab result extractor
    this.registerClaimExtractor('LabResult', async (artifact, outputs, patientContext) => {
      const assertions = [];

      if (outputs?.results) {
        for (const result of outputs.results) {
          if (typeof result.value === 'number') {
            assertions.push(createCriticalValueAssertion(
              result.test,
              result.value,
              result.unit,
              patientContext
            ));
          }
        }
      }

      return assertions;
    });
  }

  /**
   * Quick validation check
   */
  async quickCheck(artifact, outputs = {}) {
    const envelope = await this.evaluate({
      artifact,
      outputs,
      additionalAssertions: []
    });

    return {
      valid: envelope.payload.verdict.canProceed,
      status: envelope.payload.assessment.status,
      confidence: envelope.payload.assessment.metrics.overallConfidence,
      warnings: envelope.payload.verdict.warnings,
      blockedBy: envelope.payload.verdict.blockedBy
    };
  }

  /**
   * Create assertions for specific validation
   */
  createAssertions = {
    codeValid: createCodeValidAssertion,
    range: createRangeAssertion,
    criticalValue: createCriticalValueAssertion,
    drugInteraction: createDrugInteractionAssertion,
    drugCondition: createDrugConditionAssertion,
    medicationList: createMedicationListAssertion,
    guideline: createGuidelineAssertion,
    treatmentTarget: createTreatmentTargetAssertion
  };
}

export default CorrectnessEvaluator;
