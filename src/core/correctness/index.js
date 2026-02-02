/**
 * Correctness Assurance Infrastructure
 *
 * Phase 9: Ensures clinical correctness through:
 * - Ground truth anchoring to authoritative sources
 * - Testable assertions against evidence
 * - Calibration benchmarking against known-correct answers
 * - Expert review workflow for uncertain outputs
 * - Outcome tracking and feedback loops
 *
 * @module correctness
 */

// Main Components
export { CorrectnessEvaluator, ReviewTriggers } from './CorrectnessEvaluator.js';
export {
  CorrectnessEnvelopeSchema,
  CorrectnessEnvelopePayloadSchema,
  CorrectnessStatus,
  CorrectnessStatusSchema,
  UncertaintyLevel,
  UncertaintyLevelSchema,
  TargetRefSchema,
  GroundTruthRefSchema,
  AssessmentMetricsSchema,
  ReviewRequirementSchema,
  CalibrationRefSchema,
  CorrectnessAssessmentSchema,
  createCorrectnessEnvelope,
  validateCorrectnessEnvelope,
  getStatusFromMetrics
} from './CorrectnessEnvelope.js';

// Ground Truth
export * from './ground-truth/index.js';

// Assertions
export * from './assertions/index.js';

// Calibration
export * from './calibration/index.js';

// Expert Review
export * from './review/index.js';

// Feedback / Outcome Tracking
export * from './feedback/index.js';

/**
 * Create a fully configured correctness assurance stack
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.groundTruthOptions - Ground truth registry options
 * @param {Object} options.triggerConfig - Review trigger configuration
 * @param {Object} options.calibrationOptions - Calibration framework options
 * @returns {Object} Configured correctness stack
 */
export async function createCorrectnessStack(options = {}) {
  const { GroundTruthRegistry } = await import('./ground-truth/index.js');
  const { CorrectnessEvaluator } = await import('./CorrectnessEvaluator.js');
  const { CalibrationFramework } = await import('./calibration/index.js');
  const { ExpertReviewWorkflow } = await import('./review/index.js');
  const { OutcomeTracker } = await import('./feedback/index.js');
  const { FeedbackAnalyzer } = await import('./feedback/index.js');

  // Create ground truth registry
  const groundTruthRegistry = options.groundTruthRegistry ||
    await GroundTruthRegistry.createWithDefaults(options.groundTruthOptions);

  // Create correctness evaluator
  const correctnessEvaluator = new CorrectnessEvaluator({
    groundTruthRegistry,
    guidelineRegistry: options.guidelineRegistry,
    reviewTriggers: options.triggerConfig,
    ...options.evaluatorOptions
  });

  // Create calibration framework
  const calibrationFramework = new CalibrationFramework({
    ...options.calibrationOptions
  });

  // Create expert review workflow
  const expertReviewWorkflow = new ExpertReviewWorkflow({
    triggerConfig: options.triggerConfig,
    ...options.reviewOptions
  });

  // Create outcome tracker
  const outcomeTracker = new OutcomeTracker({
    ...options.outcomeOptions
  });

  // Create feedback analyzer
  const feedbackAnalyzer = new FeedbackAnalyzer({
    ...options.analyzerOptions
  });

  // Wire up callbacks
  correctnessEvaluator.reviewWorkflow = expertReviewWorkflow;
  expertReviewWorkflow.start();

  return {
    groundTruthRegistry,
    correctnessEvaluator,
    calibrationFramework,
    expertReviewWorkflow,
    outcomeTracker,
    feedbackAnalyzer,

    /**
     * Evaluate artifact for correctness
     */
    async evaluate(artifact, options = {}) {
      return correctnessEvaluator.evaluate({
        artifact,
        ...options
      });
    },

    /**
     * Quick correctness check
     */
    async quickCheck(artifact, outputs = {}) {
      return correctnessEvaluator.quickCheck(artifact, outputs);
    },

    /**
     * Run calibration test suite
     */
    async runCalibration(suiteName, options = {}) {
      return calibrationFramework.runTestSuite(suiteName, options);
    },

    /**
     * Request expert review
     */
    async requestReview(options) {
      return expertReviewWorkflow.createReviewRequest(options);
    },

    /**
     * Record outcome
     */
    async recordOutcome(options) {
      return outcomeTracker.recordOutcome(options);
    },

    /**
     * Analyze feedback
     */
    analyzeFeedback() {
      const outcomes = Array.from(outcomeTracker.outcomes.values());
      return feedbackAnalyzer.analyze(outcomes);
    },

    /**
     * Shutdown the stack
     */
    async shutdown() {
      expertReviewWorkflow.stop();
      await groundTruthRegistry.shutdown();
    }
  };
}

export default {
  createCorrectnessStack
};
