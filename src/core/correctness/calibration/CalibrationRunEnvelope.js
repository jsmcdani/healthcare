/**
 * CalibrationRunEnvelope - Contract for calibration run results
 *
 * Records the results of running a calibration test suite,
 * including individual test results and summary metrics.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../contracts/schema-ids.js';

/**
 * Individual test result
 */
export const TestResultSchema = z.object({
  testId: z.string(),
  testName: z.string().optional(),
  category: z.string().optional(),

  // Result
  passed: z.boolean(),
  actualOutput: z.any(),
  expectedOutput: z.any(),

  // Comparison details
  deviation: z.number().optional()
    .describe('Numeric deviation from expected'),
  similarity: z.number().min(0).max(1).optional()
    .describe('Similarity score for non-exact matches'),
  matchDetails: z.record(z.any()).optional()
    .describe('Detailed comparison results'),

  // Error info
  errorMessage: z.string().optional(),
  errorStack: z.string().optional(),

  // Timing
  durationMs: z.number().optional()
});

/**
 * Category summary
 */
export const CategorySummarySchema = z.object({
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  errors: z.number().int(),
  accuracy: z.number().min(0).max(1)
});

/**
 * Run summary
 */
export const RunSummarySchema = z.object({
  totalTests: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  errors: z.number().int(),
  skipped: z.number().int(),
  accuracy: z.number().min(0).max(1),
  averageDurationMs: z.number().optional(),
  byCategory: z.record(CategorySummarySchema).optional(),
  byDifficulty: z.record(CategorySummarySchema).optional(),
  byRisk: z.record(CategorySummarySchema).optional()
});

/**
 * Trend comparison with prior run
 */
export const TrendSchema = z.object({
  priorRunId: z.string().optional(),
  priorRunDate: z.string().datetime().optional(),
  priorAccuracy: z.number().min(0).max(1).optional(),
  accuracyDelta: z.number().optional()
    .describe('Change in accuracy from prior run'),
  significantRegression: z.boolean().default(false)
    .describe('True if accuracy dropped significantly'),
  regressionThreshold: z.number().optional()
    .describe('Threshold used for regression detection'),
  newFailures: z.array(z.string()).optional()
    .describe('Test IDs that passed before but failed now'),
  newPasses: z.array(z.string()).optional()
    .describe('Test IDs that failed before but passed now')
});

/**
 * Calibration Run Payload
 */
export const CalibrationRunPayloadSchema = z.object({
  runId: z.string().uuid(),
  timestamp: z.string().datetime(),

  // What was tested
  testSuite: z.string().describe('Test suite name or ID'),
  testSuiteVersion: z.string().optional(),
  targetRecipe: z.string().optional(),
  targetComponent: z.string().optional(),

  // Environment
  environment: z.object({
    version: z.string().optional(),
    groundTruthVersion: z.string().optional(),
    configuration: z.record(z.any()).optional()
  }).optional(),

  // Results
  results: z.array(TestResultSchema),

  // Summary
  summary: RunSummarySchema,

  // Trend analysis
  trend: TrendSchema.optional(),

  // Run metadata
  triggeredBy: z.enum(['manual', 'scheduled', 'ci', 'deployment']).optional(),
  triggeredByUser: z.string().optional(),
  durationMs: z.number().optional(),
  notes: z.string().optional()
});

/**
 * Full Calibration Run Envelope
 */
export const CalibrationRunEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: CalibrationRunPayloadSchema,
  _meta: z.object({
    completedAt: z.string().datetime(),
    archived: z.boolean().default(false)
  }).optional()
});

/**
 * Create a calibration run envelope
 */
export function createCalibrationRun(options) {
  const {
    testSuite,
    testSuiteVersion,
    targetRecipe,
    targetComponent,
    environment,
    results,
    trend,
    triggeredBy,
    triggeredByUser,
    durationMs,
    notes,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.CALIBRATION_RUN,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'calibration_run',
    source: 'CalibrationFramework',
    traceId
  });

  const now = new Date().toISOString();

  // Calculate summary from results
  const summary = calculateRunSummary(results);

  return {
    header,
    payload: {
      runId: crypto.randomUUID(),
      timestamp: now,
      testSuite,
      testSuiteVersion,
      targetRecipe,
      targetComponent,
      environment,
      results,
      summary,
      trend,
      triggeredBy,
      triggeredByUser,
      durationMs,
      notes
    },
    _meta: {
      completedAt: now,
      archived: false
    }
  };
}

/**
 * Calculate run summary from results
 */
export function calculateRunSummary(results) {
  const total = results.length;
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  let totalDuration = 0;
  let durationCount = 0;

  const byCategory = {};
  const byDifficulty = {};
  const byRisk = {};

  for (const result of results) {
    // Count overall results
    if (result.errorMessage) {
      errors++;
    } else if (result.passed) {
      passed++;
    } else {
      failed++;
    }

    // Track duration
    if (result.durationMs) {
      totalDuration += result.durationMs;
      durationCount++;
    }

    // Count by category
    if (result.category) {
      if (!byCategory[result.category]) {
        byCategory[result.category] = { total: 0, passed: 0, failed: 0, errors: 0, accuracy: 0 };
      }
      byCategory[result.category].total++;
      if (result.errorMessage) {
        byCategory[result.category].errors++;
      } else if (result.passed) {
        byCategory[result.category].passed++;
      } else {
        byCategory[result.category].failed++;
      }
    }
  }

  // Calculate accuracy for each category
  for (const cat of Object.values(byCategory)) {
    const validTests = cat.total - cat.errors;
    cat.accuracy = validTests > 0 ? cat.passed / validTests : 0;
  }

  // Calculate overall accuracy
  const validTests = total - errors;
  const accuracy = validTests > 0 ? passed / validTests : 0;

  return {
    totalTests: total,
    passed,
    failed,
    errors,
    skipped,
    accuracy,
    averageDurationMs: durationCount > 0 ? totalDuration / durationCount : undefined,
    byCategory: Object.keys(byCategory).length > 0 ? byCategory : undefined
  };
}

/**
 * Compare with prior run to detect trends
 */
export function compareWithPriorRun(currentResults, priorRun, regressionThreshold = 0.05) {
  if (!priorRun) {
    return undefined;
  }

  const currentSummary = calculateRunSummary(currentResults);
  const priorAccuracy = priorRun.payload?.summary?.accuracy ?? 0;
  const accuracyDelta = currentSummary.accuracy - priorAccuracy;

  // Find regressions and improvements
  const currentResultMap = new Map(currentResults.map(r => [r.testId, r.passed]));
  const priorResultMap = new Map(priorRun.payload?.results?.map(r => [r.testId, r.passed]) || []);

  const newFailures = [];
  const newPasses = [];

  for (const [testId, passed] of currentResultMap) {
    const priorPassed = priorResultMap.get(testId);
    if (priorPassed === true && !passed) {
      newFailures.push(testId);
    } else if (priorPassed === false && passed) {
      newPasses.push(testId);
    }
  }

  return {
    priorRunId: priorRun.payload?.runId,
    priorRunDate: priorRun.payload?.timestamp,
    priorAccuracy,
    accuracyDelta,
    significantRegression: accuracyDelta < -regressionThreshold,
    regressionThreshold,
    newFailures: newFailures.length > 0 ? newFailures : undefined,
    newPasses: newPasses.length > 0 ? newPasses : undefined
  };
}

/**
 * Validate a calibration run envelope
 */
export function validateCalibrationRun(envelope) {
  return CalibrationRunEnvelopeSchema.safeParse(envelope);
}

export default CalibrationRunEnvelopeSchema;
