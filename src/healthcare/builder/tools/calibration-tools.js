/**
 * Calibration Tools for Healthcare Builder Agent
 *
 * Tools for creating and managing calibration test cases with gold-standard
 * expected outputs for validating AI expert accuracy and correctness.
 */

export const calibrationTools = [
  {
    name: 'create_test_case',
    description: 'Create a calibration test case with expected output.',
    input_schema: {
      type: 'object',
      properties: {
        testId: {
          type: 'string',
          description: 'Unique identifier for the test case'
        },
        name: {
          type: 'string',
          description: 'Human-readable test case name'
        },
        category: {
          type: 'string',
          enum: ['clinical_decision', 'drug_interaction', 'dosage_calculation', 'diagnosis_support', 'risk_assessment', 'custom'],
          description: 'Category of test case'
        },
        targetExpert: {
          type: 'string',
          description: 'AI expert type this test is for'
        },
        input: {
          type: 'object',
          description: 'Test input data',
          additionalProperties: true
        },
        expectedOutput: {
          type: 'object',
          description: 'Expected output from the AI expert',
          additionalProperties: true
        },
        tolerance: {
          type: 'object',
          description: 'Tolerance settings for output comparison',
          properties: {
            certainty: { type: 'number', description: 'Allowed deviation for certainty values' },
            numericFields: { type: 'object', additionalProperties: { type: 'number' } }
          }
        },
        clinicalRisk: {
          type: 'string',
          enum: ['critical', 'high', 'moderate', 'low'],
          description: 'Clinical risk level if this test fails'
        },
        goldStandardSource: {
          type: 'string',
          description: 'Source of the expected output (e.g., clinical expert review, guideline)'
        },
        reviewedBy: {
          type: 'string',
          description: 'Clinical reviewer who validated this test case'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for organizing test cases'
        }
      },
      required: ['testId', 'name', 'category', 'targetExpert', 'input', 'expectedOutput']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const testCase = {
          _key: input.testId,
          testId: input.testId,
          name: input.name,
          category: input.category,
          targetExpert: input.targetExpert,
          input: input.input,
          expectedOutput: input.expectedOutput,
          tolerance: input.tolerance || { certainty: 0.1 },
          clinicalRisk: input.clinicalRisk || 'moderate',
          goldStandardSource: input.goldStandardSource,
          reviewedBy: input.reviewedBy,
          tags: input.tags || [],
          status: 'active',
          runCount: 0,
          lastResult: null,
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          const col = db.collection('calibration_test_cases');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('calibration_test_cases');
          }
          await col.save(testCase);
        }

        // Register with calibration framework if available
        if (orchestrator.correctnessStack?.calibrationFramework) {
          await orchestrator.correctnessStack.calibrationFramework.addTestCase({
            testId: input.testId,
            category: input.category,
            input: input.input,
            expectedOutput: input.expectedOutput,
            tolerance: input.tolerance,
            clinicalRisk: input.clinicalRisk
          });
        }

        return {
          success: true,
          testId: input.testId,
          name: input.name,
          category: input.category,
          targetExpert: input.targetExpert,
          clinicalRisk: input.clinicalRisk,
          message: `Calibration test case '${input.name}' created`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'create_test_suite',
    description: 'Group calibration test cases into a suite.',
    input_schema: {
      type: 'object',
      properties: {
        suiteId: {
          type: 'string',
          description: 'Unique identifier for the suite'
        },
        name: {
          type: 'string',
          description: 'Suite name'
        },
        description: {
          type: 'string',
          description: 'Suite description'
        },
        targetExpert: {
          type: 'string',
          description: 'AI expert this suite tests'
        },
        testCaseIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test case IDs to include'
        },
        passingThreshold: {
          type: 'number',
          description: 'Percentage of tests that must pass (0-100)',
          default: 95
        },
        criticalTestIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test IDs that must always pass'
        },
        schedule: {
          type: 'object',
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly', 'on_deploy', 'manual'] },
            notifyOnFailure: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      required: ['suiteId', 'name', 'targetExpert', 'testCaseIds']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const suite = {
          _key: input.suiteId,
          suiteId: input.suiteId,
          name: input.name,
          description: input.description,
          targetExpert: input.targetExpert,
          testCaseIds: input.testCaseIds,
          testCount: input.testCaseIds.length,
          passingThreshold: input.passingThreshold || 95,
          criticalTestIds: input.criticalTestIds || [],
          schedule: input.schedule || { frequency: 'manual' },
          status: 'active',
          lastRun: null,
          lastResult: null,
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          // Verify test cases exist
          const cursor = await db.query(`
            FOR t IN calibration_test_cases
            FILTER t.testId IN @testIds
            RETURN t.testId
          `, { testIds: input.testCaseIds });
          const foundTests = await cursor.all();

          const missingTests = input.testCaseIds.filter(id => !foundTests.includes(id));
          if (missingTests.length > 0) {
            return {
              success: false,
              error: `Test cases not found: ${missingTests.join(', ')}`
            };
          }

          const col = db.collection('calibration_suites');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('calibration_suites');
          }
          await col.save(suite);
        }

        return {
          success: true,
          suiteId: input.suiteId,
          name: input.name,
          targetExpert: input.targetExpert,
          testCount: input.testCaseIds.length,
          criticalCount: (input.criticalTestIds || []).length,
          passingThreshold: input.passingThreshold || 95,
          message: `Test suite '${input.name}' created with ${input.testCaseIds.length} tests`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'run_calibration',
    description: 'Execute a calibration test suite against an AI expert.',
    input_schema: {
      type: 'object',
      properties: {
        suiteId: {
          type: 'string',
          description: 'Test suite to run'
        },
        testCaseIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific test cases to run (optional, runs all if not specified)'
        },
        expertVersion: {
          type: 'string',
          description: 'Expert version being tested (for tracking)'
        },
        runLabel: {
          type: 'string',
          description: 'Label for this calibration run'
        },
        stopOnCriticalFailure: {
          type: 'boolean',
          description: 'Stop execution if a critical test fails',
          default: false
        }
      },
      required: ['suiteId']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        let suite = null;
        let testCases = [];

        if (db) {
          // Get suite
          const suiteCursor = await db.query(`
            FOR s IN calibration_suites
            FILTER s.suiteId == @suiteId
            RETURN s
          `, { suiteId: input.suiteId });
          const suites = await suiteCursor.all();

          if (suites.length === 0) {
            return { success: false, error: `Suite '${input.suiteId}' not found` };
          }
          suite = suites[0];

          // Get test cases
          const testIds = input.testCaseIds || suite.testCaseIds;
          const testCursor = await db.query(`
            FOR t IN calibration_test_cases
            FILTER t.testId IN @testIds AND t.status == 'active'
            RETURN t
          `, { testIds });
          testCases = await testCursor.all();
        }

        if (testCases.length === 0) {
          return { success: false, error: 'No active test cases found' };
        }

        // Run calibration
        const runId = `run_${Date.now()}`;
        const runStart = new Date().toISOString();
        const results = [];
        let criticalFailure = false;

        for (const testCase of testCases) {
          if (criticalFailure && input.stopOnCriticalFailure) {
            results.push({
              testId: testCase.testId,
              status: 'skipped',
              reason: 'Stopped due to critical failure'
            });
            continue;
          }

          // Execute test
          const result = await runSingleTest(orchestrator, testCase);
          results.push(result);

          // Check for critical failure
          if (!result.passed && suite.criticalTestIds?.includes(testCase.testId)) {
            criticalFailure = true;
          }

          // Update test case stats
          if (db) {
            const col = db.collection('calibration_test_cases');
            await col.update(testCase._key, {
              runCount: (testCase.runCount || 0) + 1,
              lastResult: result.passed ? 'passed' : 'failed',
              lastRunAt: new Date().toISOString()
            });
          }
        }

        // Calculate metrics
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed && r.status !== 'skipped').length;
        const skipped = results.filter(r => r.status === 'skipped').length;
        const passRate = Math.round((passed / (passed + failed)) * 100);
        const meetsThreshold = passRate >= suite.passingThreshold;

        // Store run results
        const runResult = {
          _key: runId,
          runId,
          suiteId: input.suiteId,
          suiteName: suite.name,
          expertVersion: input.expertVersion,
          runLabel: input.runLabel,
          startTime: runStart,
          endTime: new Date().toISOString(),
          testCount: testCases.length,
          passed,
          failed,
          skipped,
          passRate,
          passingThreshold: suite.passingThreshold,
          meetsThreshold,
          criticalFailure,
          results,
          createdBy: input._actor || 'system'
        };

        if (db) {
          const col = db.collection('calibration_runs');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('calibration_runs');
          }
          await col.save(runResult);

          // Update suite
          const suiteCol = db.collection('calibration_suites');
          await suiteCol.update(suite._key, {
            lastRun: runId,
            lastResult: meetsThreshold ? 'passed' : 'failed',
            lastRunAt: runResult.endTime
          });
        }

        return {
          success: true,
          runId,
          suiteId: input.suiteId,
          suiteName: suite.name,
          expertVersion: input.expertVersion,
          summary: {
            testCount: testCases.length,
            passed,
            failed,
            skipped,
            passRate: `${passRate}%`,
            threshold: `${suite.passingThreshold}%`,
            meetsThreshold,
            criticalFailure
          },
          failedTests: results.filter(r => !r.passed && r.status !== 'skipped').map(r => ({
            testId: r.testId,
            testName: r.testName,
            reason: r.reason
          })),
          duration: new Date(runResult.endTime) - new Date(runResult.startTime)
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'analyze_calibration_results',
    description: 'Review accuracy metrics and trends from calibration runs.',
    input_schema: {
      type: 'object',
      properties: {
        suiteId: {
          type: 'string',
          description: 'Suite to analyze'
        },
        runId: {
          type: 'string',
          description: 'Specific run to analyze (optional)'
        },
        timeRange: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Start date (ISO)' },
            to: { type: 'string', description: 'End date (ISO)' }
          }
        },
        includeTestDetails: {
          type: 'boolean',
          description: 'Include per-test breakdown',
          default: false
        }
      },
      required: ['suiteId']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (!db) {
          return { success: false, error: 'Database not available' };
        }

        // Get runs for suite
        let query = `
          FOR r IN calibration_runs
          FILTER r.suiteId == @suiteId
        `;
        const bindVars = { suiteId: input.suiteId };

        if (input.runId) {
          query += ' FILTER r.runId == @runId';
          bindVars.runId = input.runId;
        }

        if (input.timeRange?.from) {
          query += ' FILTER r.startTime >= @from';
          bindVars.from = input.timeRange.from;
        }

        if (input.timeRange?.to) {
          query += ' FILTER r.startTime <= @to';
          bindVars.to = input.timeRange.to;
        }

        query += ' SORT r.startTime DESC RETURN r';

        const cursor = await db.query(query, bindVars);
        const runs = await cursor.all();

        if (runs.length === 0) {
          return {
            success: true,
            suiteId: input.suiteId,
            runCount: 0,
            message: 'No calibration runs found'
          };
        }

        // Calculate overall metrics
        const passRates = runs.map(r => r.passRate);
        const avgPassRate = Math.round(passRates.reduce((a, b) => a + b, 0) / passRates.length);
        const minPassRate = Math.min(...passRates);
        const maxPassRate = Math.max(...passRates);

        // Find consistently failing tests
        const testFailures = {};
        for (const run of runs) {
          for (const result of run.results || []) {
            if (!result.passed) {
              testFailures[result.testId] = (testFailures[result.testId] || 0) + 1;
            }
          }
        }

        const consistentlyFailing = Object.entries(testFailures)
          .filter(([_, count]) => count >= runs.length * 0.5)
          .map(([testId, count]) => ({ testId, failureRate: Math.round((count / runs.length) * 100) }))
          .sort((a, b) => b.failureRate - a.failureRate);

        // Trend analysis
        const recentRuns = runs.slice(0, 5);
        const olderRuns = runs.slice(5, 10);
        const recentAvg = recentRuns.length > 0
          ? Math.round(recentRuns.map(r => r.passRate).reduce((a, b) => a + b, 0) / recentRuns.length)
          : null;
        const olderAvg = olderRuns.length > 0
          ? Math.round(olderRuns.map(r => r.passRate).reduce((a, b) => a + b, 0) / olderRuns.length)
          : null;

        let trend = 'stable';
        if (recentAvg && olderAvg) {
          if (recentAvg > olderAvg + 5) trend = 'improving';
          else if (recentAvg < olderAvg - 5) trend = 'declining';
        }

        return {
          success: true,
          suiteId: input.suiteId,
          runCount: runs.length,
          latestRun: runs[0] ? {
            runId: runs[0].runId,
            passRate: runs[0].passRate,
            meetsThreshold: runs[0].meetsThreshold,
            timestamp: runs[0].startTime
          } : null,
          metrics: {
            averagePassRate: `${avgPassRate}%`,
            minPassRate: `${minPassRate}%`,
            maxPassRate: `${maxPassRate}%`,
            trend,
            recentAverage: recentAvg ? `${recentAvg}%` : null,
            criticalFailures: runs.filter(r => r.criticalFailure).length
          },
          consistentlyFailingTests: consistentlyFailing,
          ...(input.includeTestDetails ? {
            runDetails: runs.slice(0, 10).map(r => ({
              runId: r.runId,
              timestamp: r.startTime,
              passed: r.passed,
              failed: r.failed,
              passRate: r.passRate,
              meetsThreshold: r.meetsThreshold
            }))
          } : {})
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'compare_calibration_runs',
    description: 'Compare two calibration runs to detect regressions.',
    input_schema: {
      type: 'object',
      properties: {
        baselineRunId: {
          type: 'string',
          description: 'Baseline run to compare against'
        },
        currentRunId: {
          type: 'string',
          description: 'Current run to compare'
        },
        regressionThreshold: {
          type: 'number',
          description: 'Pass rate drop that constitutes a regression (%)',
          default: 5
        }
      },
      required: ['baselineRunId', 'currentRunId']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (!db) {
          return { success: false, error: 'Database not available' };
        }

        // Get both runs
        const cursor = await db.query(`
          FOR r IN calibration_runs
          FILTER r.runId IN @runIds
          RETURN r
        `, { runIds: [input.baselineRunId, input.currentRunId] });
        const runs = await cursor.all();

        const baseline = runs.find(r => r.runId === input.baselineRunId);
        const current = runs.find(r => r.runId === input.currentRunId);

        if (!baseline) {
          return { success: false, error: `Baseline run '${input.baselineRunId}' not found` };
        }
        if (!current) {
          return { success: false, error: `Current run '${input.currentRunId}' not found` };
        }

        // Compare results
        const passRateDelta = current.passRate - baseline.passRate;
        const isRegression = passRateDelta < -(input.regressionThreshold || 5);

        // Find new failures and fixes
        const baselineFailedIds = new Set(
          (baseline.results || []).filter(r => !r.passed).map(r => r.testId)
        );
        const currentFailedIds = new Set(
          (current.results || []).filter(r => !r.passed).map(r => r.testId)
        );

        const newFailures = [...currentFailedIds].filter(id => !baselineFailedIds.has(id));
        const fixed = [...baselineFailedIds].filter(id => !currentFailedIds.has(id));
        const stillFailing = [...currentFailedIds].filter(id => baselineFailedIds.has(id));

        return {
          success: true,
          comparison: {
            baseline: {
              runId: baseline.runId,
              timestamp: baseline.startTime,
              passRate: baseline.passRate,
              passed: baseline.passed,
              failed: baseline.failed
            },
            current: {
              runId: current.runId,
              timestamp: current.startTime,
              passRate: current.passRate,
              passed: current.passed,
              failed: current.failed
            },
            delta: {
              passRate: passRateDelta,
              passed: current.passed - baseline.passed,
              failed: current.failed - baseline.failed
            }
          },
          regression: {
            detected: isRegression,
            threshold: input.regressionThreshold || 5,
            severity: isRegression
              ? (passRateDelta < -20 ? 'critical' : passRateDelta < -10 ? 'high' : 'moderate')
              : 'none'
          },
          testChanges: {
            newFailures,
            fixed,
            stillFailing,
            newFailureCount: newFailures.length,
            fixedCount: fixed.length
          },
          recommendation: isRegression
            ? `REGRESSION DETECTED: Pass rate dropped by ${Math.abs(passRateDelta)}%. Review ${newFailures.length} new failures.`
            : passRateDelta > 0
              ? `Improvement: Pass rate increased by ${passRateDelta}%. ${fixed.length} tests now passing.`
              : 'No significant change in calibration results.'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'export_test_cases',
    description: 'Export test cases for healthcare partner review.',
    input_schema: {
      type: 'object',
      properties: {
        suiteId: {
          type: 'string',
          description: 'Suite to export (optional)'
        },
        testCaseIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific test cases to export'
        },
        format: {
          type: 'string',
          enum: ['json', 'csv', 'markdown'],
          description: 'Export format',
          default: 'json'
        },
        includeExpectedOutputs: {
          type: 'boolean',
          description: 'Include expected outputs (for review)',
          default: true
        },
        redactPHI: {
          type: 'boolean',
          description: 'Redact any PHI in test data',
          default: true
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        let testCases = [];

        if (db) {
          let query = 'FOR t IN calibration_test_cases FILTER t.status == "active"';
          const bindVars = {};

          if (input.suiteId) {
            const suiteCursor = await db.query(`
              FOR s IN calibration_suites
              FILTER s.suiteId == @suiteId
              RETURN s.testCaseIds
            `, { suiteId: input.suiteId });
            const suiteTestIds = await suiteCursor.all();

            if (suiteTestIds.length > 0) {
              query += ' FILTER t.testId IN @testIds';
              bindVars.testIds = suiteTestIds[0];
            }
          } else if (input.testCaseIds?.length) {
            query += ' FILTER t.testId IN @testIds';
            bindVars.testIds = input.testCaseIds;
          }

          query += ' RETURN t';

          const cursor = await db.query(query, bindVars);
          testCases = await cursor.all();
        }

        if (testCases.length === 0) {
          return { success: true, count: 0, message: 'No test cases to export' };
        }

        // Prepare export data
        let exportData = testCases.map(tc => {
          const data = {
            testId: tc.testId,
            name: tc.name,
            category: tc.category,
            targetExpert: tc.targetExpert,
            clinicalRisk: tc.clinicalRisk,
            input: input.redactPHI ? redactPHI(tc.input) : tc.input,
            goldStandardSource: tc.goldStandardSource,
            reviewedBy: tc.reviewedBy,
            tags: tc.tags
          };

          if (input.includeExpectedOutputs) {
            data.expectedOutput = input.redactPHI ? redactPHI(tc.expectedOutput) : tc.expectedOutput;
            data.tolerance = tc.tolerance;
          }

          return data;
        });

        // Format output
        let formattedOutput;
        switch (input.format) {
          case 'csv':
            formattedOutput = convertToCSV(exportData);
            break;
          case 'markdown':
            formattedOutput = convertToMarkdown(exportData);
            break;
          default:
            formattedOutput = JSON.stringify(exportData, null, 2);
        }

        return {
          success: true,
          count: testCases.length,
          format: input.format || 'json',
          redacted: input.redactPHI,
          data: formattedOutput,
          summary: {
            byCategory: groupCount(testCases, 'category'),
            byRisk: groupCount(testCases, 'clinicalRisk'),
            byExpert: groupCount(testCases, 'targetExpert')
          }
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];

/**
 * Run a single test case
 */
async function runSingleTest(orchestrator, testCase) {
  const startTime = Date.now();

  try {
    // Get the expert
    const db = orchestrator.arango?.db;
    let expert = null;

    if (db) {
      const cursor = await db.query(`
        FOR e IN ai_experts
        FILTER e.expertType == @type
        RETURN e
      `, { type: testCase.targetExpert });
      const experts = await cursor.all();
      expert = experts[0];
    }

    if (!expert) {
      return {
        testId: testCase.testId,
        testName: testCase.name,
        passed: false,
        status: 'error',
        reason: `Expert '${testCase.targetExpert}' not found`,
        duration: Date.now() - startTime
      };
    }

    // Invoke expert with test input
    const llmService = orchestrator.llmService;
    if (!llmService) {
      return {
        testId: testCase.testId,
        testName: testCase.name,
        passed: false,
        status: 'error',
        reason: 'LLM service not available',
        duration: Date.now() - startTime
      };
    }

    const userPrompt = `Analyze the following input and provide a structured response:

${JSON.stringify(testCase.input, null, 2)}

Respond with a JSON object.`;

    const result = await llmService.invokeLLM(
      'calibration',
      'calibration_runner',
      {
        provider: 'ANTHROPIC',
        systemPrompt: expert.systemPrompt,
        userPrompt,
        temperature: 0.1,
        maxTokens: 2000,
        skipCache: true
      }
    );

    // Parse response
    let actualOutput;
    try {
      actualOutput = typeof result.response === 'string'
        ? JSON.parse(result.response)
        : result.response;
    } catch (e) {
      return {
        testId: testCase.testId,
        testName: testCase.name,
        passed: false,
        status: 'error',
        reason: `Failed to parse expert response: ${e.message}`,
        duration: Date.now() - startTime
      };
    }

    // Compare with expected output
    const comparison = compareOutputs(actualOutput, testCase.expectedOutput, testCase.tolerance);

    return {
      testId: testCase.testId,
      testName: testCase.name,
      passed: comparison.matches,
      status: comparison.matches ? 'passed' : 'failed',
      reason: comparison.matches ? null : comparison.differences.join('; '),
      actualOutput,
      expectedOutput: testCase.expectedOutput,
      differences: comparison.differences,
      duration: Date.now() - startTime
    };

  } catch (error) {
    return {
      testId: testCase.testId,
      testName: testCase.name,
      passed: false,
      status: 'error',
      reason: error.message,
      duration: Date.now() - startTime
    };
  }
}

/**
 * Compare actual vs expected outputs
 */
function compareOutputs(actual, expected, tolerance = {}) {
  const differences = [];

  function compare(act, exp, path = '') {
    if (typeof exp !== typeof act) {
      differences.push(`${path}: Type mismatch (expected ${typeof exp}, got ${typeof act})`);
      return;
    }

    if (typeof exp === 'object' && exp !== null) {
      for (const key of Object.keys(exp)) {
        compare(act?.[key], exp[key], path ? `${path}.${key}` : key);
      }
    } else if (typeof exp === 'number') {
      const fieldTolerance = tolerance.numericFields?.[path] || tolerance.certainty || 0;
      if (Math.abs(act - exp) > fieldTolerance) {
        differences.push(`${path}: Value ${act} differs from expected ${exp} by more than tolerance ${fieldTolerance}`);
      }
    } else if (act !== exp) {
      differences.push(`${path}: Expected '${exp}', got '${act}'`);
    }
  }

  compare(actual, expected);

  return {
    matches: differences.length === 0,
    differences
  };
}

/**
 * Redact PHI from data
 */
function redactPHI(data) {
  if (!data) return data;

  const phiPatterns = ['ssn', 'mrn', 'patient_name', 'dob', 'address', 'phone', 'email'];
  const redacted = JSON.parse(JSON.stringify(data));

  function redactObject(obj) {
    for (const key of Object.keys(obj)) {
      const keyLower = key.toLowerCase();
      if (phiPatterns.some(p => keyLower.includes(p))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        redactObject(obj[key]);
      }
    }
  }

  if (typeof redacted === 'object') {
    redactObject(redacted);
  }

  return redacted;
}

/**
 * Convert to CSV
 */
function convertToCSV(data) {
  if (data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const rows = data.map(row =>
    headers.map(h => {
      const val = row[h];
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val || '').replace(/"/g, '""');
    }).join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Convert to Markdown
 */
function convertToMarkdown(data) {
  let md = '# Calibration Test Cases\n\n';

  for (const tc of data) {
    md += `## ${tc.name}\n\n`;
    md += `- **Test ID**: ${tc.testId}\n`;
    md += `- **Category**: ${tc.category}\n`;
    md += `- **Target Expert**: ${tc.targetExpert}\n`;
    md += `- **Clinical Risk**: ${tc.clinicalRisk}\n`;
    md += `- **Gold Standard Source**: ${tc.goldStandardSource || 'N/A'}\n`;
    md += `- **Reviewed By**: ${tc.reviewedBy || 'N/A'}\n\n`;
    md += `### Input\n\`\`\`json\n${JSON.stringify(tc.input, null, 2)}\n\`\`\`\n\n`;
    if (tc.expectedOutput) {
      md += `### Expected Output\n\`\`\`json\n${JSON.stringify(tc.expectedOutput, null, 2)}\n\`\`\`\n\n`;
    }
    md += '---\n\n';
  }

  return md;
}

/**
 * Group and count by field
 */
function groupCount(items, field) {
  const counts = {};
  for (const item of items) {
    const key = item[field] || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
