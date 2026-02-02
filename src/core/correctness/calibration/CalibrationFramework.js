/**
 * CalibrationFramework - Runs calibration test suites against system outputs
 *
 * Benchmarks system performance against gold-standard test cases,
 * tracks accuracy over time, and detects regressions.
 */

import { Logger } from '../../../utils/logger.js';
import {
  createCalibrationRun,
  calculateRunSummary,
  compareWithPriorRun
} from './CalibrationRunEnvelope.js';
import { validateCalibrationTestCase } from './CalibrationTestCaseEnvelope.js';

/**
 * Comparison strategies
 */
export const ComparisonStrategy = {
  EXACT: 'exact',
  NUMERIC: 'numeric',
  SET: 'set',
  SEMANTIC: 'semantic',
  CUSTOM: 'custom'
};

/**
 * Calibration Framework
 */
export class CalibrationFramework {
  constructor(options = {}) {
    this.logger = new Logger('CalibrationFramework');
    this.testSuites = new Map();
    this.runHistory = [];
    this.maxHistorySize = options.maxHistorySize || 100;
    this.regressionThreshold = options.regressionThreshold || 0.05;
    this.customComparators = new Map();

    // Recipe/query executor for running tests
    this.executor = options.executor;
  }

  /**
   * Set the executor for running tests
   */
  setExecutor(executor) {
    this.executor = executor;
  }

  /**
   * Register a custom comparator
   */
  registerComparator(name, comparatorFn) {
    this.customComparators.set(name, comparatorFn);
    this.logger.debug('Registered comparator', { name });
  }

  /**
   * Load a test suite from test cases
   */
  loadTestSuite(name, testCases, options = {}) {
    // Validate test cases
    const validTestCases = [];
    for (const testCase of testCases) {
      const validation = validateCalibrationTestCase(testCase);
      if (validation.success) {
        validTestCases.push(testCase);
      } else {
        this.logger.warn('Invalid test case skipped', {
          testId: testCase.payload?.testId,
          error: validation.error.message
        });
      }
    }

    this.testSuites.set(name, {
      name,
      version: options.version || '1.0.0',
      testCases: validTestCases,
      createdAt: new Date().toISOString(),
      metadata: options.metadata || {}
    });

    this.logger.info('Test suite loaded', {
      name,
      testCount: validTestCases.length
    });

    return validTestCases.length;
  }

  /**
   * Get a test suite
   */
  getTestSuite(name) {
    return this.testSuites.get(name);
  }

  /**
   * List all test suites
   */
  listTestSuites() {
    return Array.from(this.testSuites.entries()).map(([name, suite]) => ({
      name,
      version: suite.version,
      testCount: suite.testCases.length,
      createdAt: suite.createdAt
    }));
  }

  /**
   * Run a calibration test suite
   */
  async runTestSuite(suiteName, options = {}) {
    const startTime = Date.now();
    const suite = this.testSuites.get(suiteName);

    if (!suite) {
      throw new Error(`Test suite not found: ${suiteName}`);
    }

    this.logger.info('Running calibration test suite', {
      suite: suiteName,
      testCount: suite.testCases.length
    });

    const results = [];
    const {
      filter,
      parallelExecution = false,
      timeout = 30000,
      targetRecipe,
      targetComponent
    } = options;

    // Filter test cases if filter provided
    let testCases = suite.testCases;
    if (filter) {
      testCases = testCases.filter(tc => {
        if (filter.category && tc.payload.category !== filter.category) return false;
        if (filter.difficulty && tc.payload.difficulty !== filter.difficulty) return false;
        if (filter.risk && tc.payload.clinicalRisk !== filter.risk) return false;
        if (filter.tags && !filter.tags.some(t => tc.payload.tags?.includes(t))) return false;
        return true;
      });
    }

    // Run tests
    if (parallelExecution) {
      const promises = testCases.map(tc =>
        this.runSingleTest(tc, timeout)
          .catch(error => this.createErrorResult(tc, error))
      );
      const testResults = await Promise.all(promises);
      results.push(...testResults);
    } else {
      for (const testCase of testCases) {
        try {
          const result = await this.runSingleTest(testCase, timeout);
          results.push(result);
        } catch (error) {
          results.push(this.createErrorResult(testCase, error));
        }
      }
    }

    // Get prior run for comparison
    const priorRun = this.getLastRunForSuite(suiteName);
    const trend = compareWithPriorRun(results, priorRun, this.regressionThreshold);

    // Create run envelope
    const runEnvelope = createCalibrationRun({
      testSuite: suiteName,
      testSuiteVersion: suite.version,
      targetRecipe,
      targetComponent,
      results,
      trend,
      triggeredBy: options.triggeredBy || 'manual',
      triggeredByUser: options.triggeredByUser,
      durationMs: Date.now() - startTime
    });

    // Store in history
    this.addToHistory(runEnvelope);

    // Log results
    this.logger.info('Calibration run complete', {
      suite: suiteName,
      accuracy: runEnvelope.payload.summary.accuracy,
      passed: runEnvelope.payload.summary.passed,
      failed: runEnvelope.payload.summary.failed,
      regression: trend?.significantRegression || false
    });

    // Alert on regression
    if (trend?.significantRegression) {
      this.logger.warn('CALIBRATION REGRESSION DETECTED', {
        suite: suiteName,
        accuracyDelta: trend.accuracyDelta,
        newFailures: trend.newFailures
      });
    }

    return runEnvelope;
  }

  /**
   * Run a single test case
   */
  async runSingleTest(testCase, timeout) {
    const startTime = Date.now();
    const payload = testCase.payload;

    if (!this.executor) {
      throw new Error('No executor configured for running tests');
    }

    try {
      // Execute the test input through the system
      const actualOutput = await Promise.race([
        this.executeTestInput(payload.input),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Test timeout')), timeout)
        )
      ]);

      // Compare with expected output
      const comparison = this.compareOutputs(
        actualOutput,
        payload.expectedOutput.value,
        payload.tolerance
      );

      // Update test case run count
      if (testCase._meta) {
        testCase._meta.runCount = (testCase._meta.runCount || 0) + 1;
        testCase._meta.lastRunAt = new Date().toISOString();
        testCase._meta.lastRunResult = comparison.passed ? 'passed' : 'failed';
      }

      return {
        testId: payload.testId,
        testName: payload.name,
        category: payload.category,
        passed: comparison.passed,
        actualOutput,
        expectedOutput: payload.expectedOutput.value,
        deviation: comparison.deviation,
        similarity: comparison.similarity,
        matchDetails: comparison.details,
        durationMs: Date.now() - startTime
      };

    } catch (error) {
      return this.createErrorResult(testCase, error, Date.now() - startTime);
    }
  }

  /**
   * Execute test input through the system
   */
  async executeTestInput(input) {
    if (input.recipeId && this.executor.executeRecipe) {
      return this.executor.executeRecipe(input.recipeId, input.data);
    }
    if (input.queryType && this.executor.query) {
      return this.executor.query(input.queryType, input.data);
    }
    if (this.executor.execute) {
      return this.executor.execute(input);
    }
    throw new Error('No suitable execution method found');
  }

  /**
   * Compare actual vs expected outputs
   */
  compareOutputs(actual, expected, tolerance = {}) {
    // Determine comparison strategy
    const strategy = this.determineStrategy(actual, expected, tolerance);

    switch (strategy) {
      case ComparisonStrategy.EXACT:
        return this.exactCompare(actual, expected);

      case ComparisonStrategy.NUMERIC:
        return this.numericCompare(actual, expected, tolerance);

      case ComparisonStrategy.SET:
        return this.setCompare(actual, expected, tolerance);

      case ComparisonStrategy.CUSTOM:
        return this.customCompare(actual, expected, tolerance);

      default:
        return this.deepCompare(actual, expected);
    }
  }

  /**
   * Determine comparison strategy
   */
  determineStrategy(actual, expected, tolerance) {
    if (tolerance.customComparator) {
      return ComparisonStrategy.CUSTOM;
    }
    if (tolerance.exactMatch) {
      return ComparisonStrategy.EXACT;
    }
    if (typeof actual === 'number' && typeof expected === 'number') {
      return ComparisonStrategy.NUMERIC;
    }
    if (Array.isArray(actual) && Array.isArray(expected)) {
      return ComparisonStrategy.SET;
    }
    return ComparisonStrategy.EXACT;
  }

  /**
   * Exact comparison
   */
  exactCompare(actual, expected) {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    return { passed, details: { strategy: 'exact' } };
  }

  /**
   * Numeric comparison with tolerance
   */
  numericCompare(actual, expected, tolerance) {
    const deviation = Math.abs(actual - expected);
    let passed = false;

    if (tolerance.numericTolerance !== undefined) {
      passed = deviation <= tolerance.numericTolerance;
    } else if (tolerance.percentTolerance !== undefined) {
      const percentDeviation = expected !== 0
        ? (deviation / Math.abs(expected)) * 100
        : (actual === 0 ? 0 : 100);
      passed = percentDeviation <= tolerance.percentTolerance;
    } else {
      passed = deviation === 0;
    }

    return {
      passed,
      deviation,
      details: { strategy: 'numeric', actual, expected, deviation }
    };
  }

  /**
   * Set comparison (for arrays/lists)
   */
  setCompare(actual, expected, tolerance) {
    const actualSet = new Set(actual.map(x => JSON.stringify(x)));
    const expectedSet = new Set(expected.map(x => JSON.stringify(x)));

    const intersection = new Set([...actualSet].filter(x => expectedSet.has(x)));
    const union = new Set([...actualSet, ...expectedSet]);

    const overlap = union.size > 0 ? intersection.size / union.size : 1;
    const threshold = tolerance.setOverlap ?? 1.0;
    const passed = overlap >= threshold;

    return {
      passed,
      similarity: overlap,
      details: {
        strategy: 'set',
        actualSize: actualSet.size,
        expectedSize: expectedSet.size,
        intersectionSize: intersection.size,
        overlap
      }
    };
  }

  /**
   * Custom comparison
   */
  customCompare(actual, expected, tolerance) {
    const comparator = this.customComparators.get(tolerance.customComparator);
    if (!comparator) {
      throw new Error(`Custom comparator not found: ${tolerance.customComparator}`);
    }
    return comparator(actual, expected, tolerance);
  }

  /**
   * Deep comparison (fallback)
   */
  deepCompare(actual, expected) {
    const passed = this.deepEqual(actual, expected);
    return { passed, details: { strategy: 'deep' } };
  }

  /**
   * Deep equality check
   */
  deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;

    if (typeof a === 'object') {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      return keysA.every(key => this.deepEqual(a[key], b[key]));
    }

    return false;
  }

  /**
   * Create error result
   */
  createErrorResult(testCase, error, durationMs = 0) {
    return {
      testId: testCase.payload?.testId || 'unknown',
      testName: testCase.payload?.name,
      category: testCase.payload?.category,
      passed: false,
      actualOutput: null,
      expectedOutput: testCase.payload?.expectedOutput?.value,
      errorMessage: error.message,
      errorStack: error.stack,
      durationMs
    };
  }

  /**
   * Add run to history
   */
  addToHistory(runEnvelope) {
    this.runHistory.push(runEnvelope);

    // Trim history if needed
    if (this.runHistory.length > this.maxHistorySize) {
      this.runHistory = this.runHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get last run for a suite
   */
  getLastRunForSuite(suiteName) {
    for (let i = this.runHistory.length - 1; i >= 0; i--) {
      if (this.runHistory[i].payload.testSuite === suiteName) {
        return this.runHistory[i];
      }
    }
    return null;
  }

  /**
   * Get run history for a suite
   */
  getRunHistory(suiteName, limit = 10) {
    return this.runHistory
      .filter(r => !suiteName || r.payload.testSuite === suiteName)
      .slice(-limit);
  }

  /**
   * Get accuracy trend over time
   */
  getAccuracyTrend(suiteName, limit = 10) {
    const runs = this.getRunHistory(suiteName, limit);
    return runs.map(r => ({
      runId: r.payload.runId,
      timestamp: r.payload.timestamp,
      accuracy: r.payload.summary.accuracy,
      passed: r.payload.summary.passed,
      failed: r.payload.summary.failed
    }));
  }

  /**
   * Clear run history
   */
  clearHistory() {
    this.runHistory = [];
  }

  /**
   * Export test suite to JSON
   */
  exportTestSuite(suiteName) {
    const suite = this.testSuites.get(suiteName);
    if (!suite) {
      throw new Error(`Test suite not found: ${suiteName}`);
    }
    return JSON.stringify(suite, null, 2);
  }

  /**
   * Import test suite from JSON
   */
  importTestSuite(json) {
    const suite = typeof json === 'string' ? JSON.parse(json) : json;
    const count = this.loadTestSuite(suite.name, suite.testCases, {
      version: suite.version,
      metadata: suite.metadata
    });
    return count;
  }
}

export default CalibrationFramework;
