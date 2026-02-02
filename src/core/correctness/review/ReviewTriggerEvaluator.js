/**
 * ReviewTriggerEvaluator - Determines when expert review is required
 *
 * Evaluates correctness envelopes and other signals to decide
 * if human expert review is needed before proceeding.
 */

import { Logger } from '../../../utils/logger.js';
import {
  ReviewTriggerType,
  ReviewerRole,
  UrgencyLevel
} from './ExpertReviewEnvelope.js';
import { CorrectnessStatus } from '../CorrectnessEnvelope.js';
import { AssertionSeverity } from '../assertions/CorrectnessAssertionEnvelope.js';

/**
 * Default trigger configuration
 */
export const DefaultTriggerConfig = {
  // Confidence threshold below which review is required
  confidenceThreshold: 0.7,

  // Always require review for critical assertion failures
  criticalFailureTrigger: true,

  // Clinical task types that require review when LLM is involved
  clinicalLLMReviewTasks: [
    'clinical_decision_support',
    'medication_review',
    'diagnosis_support',
    'treatment_recommendation',
    'dosage_calculation'
  ],

  // Calibration deviation threshold
  calibrationDeviationThreshold: 0.1,

  // Novel scenario detection threshold (similarity to prior cases)
  noveltyThreshold: 0.3,

  // Policies that mandate review
  mandatoryReviewPolicies: [
    'high_risk_medication',
    'controlled_substance',
    'pediatric_dosing'
  ]
};

/**
 * Review trigger result
 */
export class TriggerResult {
  constructor() {
    this.requiresReview = false;
    this.triggers = [];
    this.suggestedRole = null;
    this.suggestedUrgency = UrgencyLevel.ROUTINE;
    this.details = {};
  }

  addTrigger(type, details, urgency = UrgencyLevel.ROUTINE) {
    this.requiresReview = true;
    this.triggers.push({ type, details });

    // Upgrade urgency if needed
    if (urgency === UrgencyLevel.STAT) {
      this.suggestedUrgency = UrgencyLevel.STAT;
    } else if (urgency === UrgencyLevel.URGENT && this.suggestedUrgency !== UrgencyLevel.STAT) {
      this.suggestedUrgency = UrgencyLevel.URGENT;
    }

    return this;
  }

  setRole(role) {
    this.suggestedRole = role;
    return this;
  }

  toTrigger() {
    if (!this.requiresReview || this.triggers.length === 0) {
      return null;
    }

    // Use first trigger as primary, combine details
    const primaryTrigger = this.triggers[0];

    return {
      type: primaryTrigger.type,
      details: this.triggers.map(t => t.details).join('; '),
      ...this.details
    };
  }
}

/**
 * Review Trigger Evaluator
 */
export class ReviewTriggerEvaluator {
  constructor(options = {}) {
    this.logger = new Logger('ReviewTriggerEvaluator');
    this.config = { ...DefaultTriggerConfig, ...options.config };
    this.customEvaluators = [];
  }

  /**
   * Update configuration
   */
  updateConfig(config) {
    this.config = { ...this.config, ...config };
  }

  /**
   * Register a custom trigger evaluator
   */
  registerCustomEvaluator(evaluator) {
    this.customEvaluators.push(evaluator);
  }

  /**
   * Evaluate if review is required
   */
  evaluate(context) {
    const {
      correctnessEnvelope,
      artifact,
      recipeId,
      taskType,
      usedLLM,
      calibrationResult,
      priorCaseSimilarity,
      appliedPolicies
    } = context;

    const result = new TriggerResult();

    // Check confidence threshold
    this.evaluateConfidence(result, correctnessEnvelope);

    // Check for critical failures
    this.evaluateCriticalFailures(result, correctnessEnvelope);

    // Check LLM usage on clinical tasks
    this.evaluateLLMUsage(result, { taskType, recipeId, usedLLM });

    // Check calibration deviation
    this.evaluateCalibrationDeviation(result, calibrationResult);

    // Check for novel scenario
    this.evaluateNovelty(result, priorCaseSimilarity);

    // Check mandatory review policies
    this.evaluateMandatoryPolicies(result, appliedPolicies);

    // Run custom evaluators
    for (const evaluator of this.customEvaluators) {
      try {
        evaluator(result, context);
      } catch (error) {
        this.logger.warn('Custom evaluator failed', { error: error.message });
      }
    }

    // Determine appropriate reviewer role
    if (result.requiresReview && !result.suggestedRole) {
      result.suggestedRole = this.determineReviewerRole(result, context);
    }

    return result;
  }

  /**
   * Evaluate confidence threshold
   */
  evaluateConfidence(result, correctnessEnvelope) {
    if (!correctnessEnvelope) return;

    const confidence = correctnessEnvelope.payload?.assessment?.metrics?.overallConfidence;
    const status = correctnessEnvelope.payload?.assessment?.status;

    if (status === CorrectnessStatus.REQUIRES_REVIEW) {
      result.addTrigger(
        ReviewTriggerType.LOW_CONFIDENCE,
        `Correctness status requires review`
      );
      result.details.threshold = this.config.confidenceThreshold;
      result.details.actualValue = confidence;
    } else if (typeof confidence === 'number' && confidence < this.config.confidenceThreshold) {
      result.addTrigger(
        ReviewTriggerType.LOW_CONFIDENCE,
        `Confidence ${(confidence * 100).toFixed(1)}% below threshold ${(this.config.confidenceThreshold * 100).toFixed(1)}%`
      );
      result.details.threshold = this.config.confidenceThreshold;
      result.details.actualValue = confidence;
    }
  }

  /**
   * Evaluate critical assertion failures
   */
  evaluateCriticalFailures(result, correctnessEnvelope) {
    if (!correctnessEnvelope || !this.config.criticalFailureTrigger) return;

    const criticalFailures = correctnessEnvelope.payload?.assessment?.metrics?.criticalFailures || 0;

    if (criticalFailures > 0) {
      const failedIds = this.extractFailedAssertionIds(correctnessEnvelope, AssertionSeverity.CRITICAL);

      result.addTrigger(
        ReviewTriggerType.ASSERTION_FAILURE,
        `${criticalFailures} critical assertion(s) failed`,
        UrgencyLevel.URGENT
      );
      result.details.failedAssertions = failedIds;
      result.setRole(ReviewerRole.CLINICAL_PHARMACIST);
    }
  }

  /**
   * Evaluate LLM usage on clinical tasks
   */
  evaluateLLMUsage(result, context) {
    const { taskType, recipeId, usedLLM } = context;

    if (!usedLLM) return;

    const isClinicalTask = this.config.clinicalLLMReviewTasks.some(task =>
      taskType?.includes(task) || recipeId?.includes(task)
    );

    if (isClinicalTask) {
      result.addTrigger(
        ReviewTriggerType.LLM_OUTPUT,
        `LLM-generated output for clinical task: ${taskType || recipeId}`
      );
      result.setRole(ReviewerRole.PHYSICIAN);
    }
  }

  /**
   * Evaluate calibration deviation
   */
  evaluateCalibrationDeviation(result, calibrationResult) {
    if (!calibrationResult) return;

    const deviation = Math.abs(calibrationResult.deviationFromExpected || 0);

    if (deviation > this.config.calibrationDeviationThreshold) {
      result.addTrigger(
        ReviewTriggerType.CALIBRATION_DEVIATION,
        `Calibration deviation ${(deviation * 100).toFixed(1)}% exceeds threshold ${(this.config.calibrationDeviationThreshold * 100).toFixed(1)}%`
      );
      result.details.threshold = this.config.calibrationDeviationThreshold;
      result.details.actualValue = deviation;
    }
  }

  /**
   * Evaluate novelty (similarity to prior cases)
   */
  evaluateNovelty(result, priorCaseSimilarity) {
    if (typeof priorCaseSimilarity !== 'number') return;

    if (priorCaseSimilarity < this.config.noveltyThreshold) {
      result.addTrigger(
        ReviewTriggerType.NOVEL_SCENARIO,
        `Low similarity (${(priorCaseSimilarity * 100).toFixed(1)}%) to prior cases - novel scenario`
      );
      result.setRole(ReviewerRole.DOMAIN_EXPERT);
    }
  }

  /**
   * Evaluate mandatory review policies
   */
  evaluateMandatoryPolicies(result, appliedPolicies) {
    if (!appliedPolicies || !Array.isArray(appliedPolicies)) return;

    const mandatoryPolicies = appliedPolicies.filter(p =>
      this.config.mandatoryReviewPolicies.includes(p.policyId || p)
    );

    if (mandatoryPolicies.length > 0) {
      const policyNames = mandatoryPolicies.map(p => p.policyId || p).join(', ');
      result.addTrigger(
        ReviewTriggerType.POLICY_REQUIRED,
        `Policy mandates review: ${policyNames}`,
        UrgencyLevel.ROUTINE
      );
    }
  }

  /**
   * Extract failed assertion IDs
   */
  extractFailedAssertionIds(correctnessEnvelope, severityFilter = null) {
    const assertions = correctnessEnvelope.payload?.assessment?.assertions || [];
    const failed = [];

    for (const assertion of assertions) {
      if (!assertion.payload?.result?.valid) {
        if (!severityFilter || assertion.payload?.severity === severityFilter) {
          failed.push(assertion.payload?.assertionId);
        }
      }
    }

    return failed;
  }

  /**
   * Determine appropriate reviewer role based on triggers
   */
  determineReviewerRole(result, context) {
    // Already set by specific trigger
    if (result.suggestedRole) return result.suggestedRole;

    // Determine based on trigger types
    const triggerTypes = result.triggers.map(t => t.type);

    if (triggerTypes.includes(ReviewTriggerType.ASSERTION_FAILURE)) {
      return ReviewerRole.CLINICAL_PHARMACIST;
    }

    if (triggerTypes.includes(ReviewTriggerType.LLM_OUTPUT)) {
      return ReviewerRole.PHYSICIAN;
    }

    if (triggerTypes.includes(ReviewTriggerType.NOVEL_SCENARIO)) {
      return ReviewerRole.DOMAIN_EXPERT;
    }

    if (triggerTypes.includes(ReviewTriggerType.POLICY_REQUIRED)) {
      return ReviewerRole.COMPLIANCE_OFFICER;
    }

    // Default
    return ReviewerRole.DOMAIN_EXPERT;
  }

  /**
   * Quick check - just returns boolean
   */
  requiresReview(context) {
    return this.evaluate(context).requiresReview;
  }
}

export default ReviewTriggerEvaluator;
