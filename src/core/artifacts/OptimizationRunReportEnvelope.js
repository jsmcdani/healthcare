/**
 * OptimizationRunReportEnvelope - Report from optimization runs
 *
 * Captures results of offline optimization/analysis runs.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../contracts/EnvelopeHeader.js';
import { BaseArtifactPayloadSchema } from './BaseArtifact.js';

/**
 * Run status
 */
export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

/**
 * Step result in the run
 */
export const RunStepResultSchema = z.object({
  stepId: z.string(),
  stepName: z.string(),
  status: RunStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().optional(),
  inputSummary: z.record(z.any()).optional(),
  outputSummary: z.record(z.any()).optional(),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    recoverable: z.boolean()
  }).optional(),
  metrics: z.record(z.number()).optional()
});

/**
 * Optimization metrics
 */
export const OptimizationMetricsSchema = z.object({
  totalItems: z.number().optional(),
  processedItems: z.number().optional(),
  successRate: z.number().min(0).max(1).optional(),
  improvementPercent: z.number().optional(),
  resourceUsage: z.object({
    cpuSeconds: z.number().optional(),
    memoryMb: z.number().optional(),
    networkMb: z.number().optional()
  }).optional(),
  customMetrics: z.record(z.number()).optional()
});

/**
 * Optimization Run Report payload
 */
export const OptimizationRunReportPayloadSchema = BaseArtifactPayloadSchema.extend({
  artifactType: z.literal('optimization_report'),
  runId: z.string().uuid(),
  recipeId: z.string().describe('Recipe that was executed'),
  recipeVersion: z.string(),
  runStatus: RunStatusSchema,
  triggeredBy: z.enum(['scheduled', 'manual', 'event', 'api']),
  triggeredAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().optional(),
  stepResults: z.array(RunStepResultSchema),
  metrics: OptimizationMetricsSchema.optional(),
  producedArtifacts: z.array(z.object({
    artifactId: z.string(),
    artifactType: z.string(),
    name: z.string()
  })).optional(),
  recommendations: z.array(z.object({
    type: z.string(),
    priority: z.enum(['low', 'medium', 'high']),
    description: z.string(),
    action: z.string().optional()
  })).optional(),
  nextRunScheduled: z.string().datetime().optional()
});

/**
 * Full Optimization Run Report Envelope
 */
export const OptimizationRunReportEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: OptimizationRunReportPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create an optimization run report
 */
export function createOptimizationRunReport(options) {
  const {
    name,
    description,
    orgId,
    createdBy,
    recipeId,
    recipeVersion,
    triggeredBy,
    traceId
  } = options;

  const now = new Date().toISOString();

  const header = createEnvelopeHeader({
    schemaId: 'artifact.optimization.report',
    schemaVersion: '1.0.0',
    userId: createdBy,
    action: 'create_run_report',
    source: 'OfflineRunner',
    traceId
  });

  return {
    header,
    payload: {
      artifactId: crypto.randomUUID(),
      artifactType: 'optimization_report',
      name: name || `${recipeId} Run Report`,
      description,
      version: '1.0.0',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      createdBy,
      orgId,
      riskClassification: 'LOW',
      runId: crypto.randomUUID(),
      recipeId,
      recipeVersion,
      runStatus: 'pending',
      triggeredBy,
      triggeredAt: now,
      stepResults: [],
      producedArtifacts: [],
      recommendations: []
    },
    _meta: {
      validated: true,
      validatedAt: now
    }
  };
}

/**
 * Start a run
 */
export function startRun(report) {
  report.payload.runStatus = 'running';
  report.payload.startedAt = new Date().toISOString();
  report.payload.updatedAt = new Date().toISOString();
  return report;
}

/**
 * Add step result
 */
export function addStepResult(report, stepResult) {
  report.payload.stepResults.push(stepResult);
  report.payload.updatedAt = new Date().toISOString();
  return report;
}

/**
 * Complete a run
 */
export function completeRun(report, success = true, metrics = {}) {
  const now = new Date().toISOString();
  report.payload.runStatus = success ? 'completed' : 'failed';
  report.payload.completedAt = now;
  report.payload.updatedAt = now;

  if (report.payload.startedAt) {
    report.payload.durationMs = new Date(now) - new Date(report.payload.startedAt);
  }

  if (metrics) {
    report.payload.metrics = metrics;
  }

  report.payload.status = success ? 'published' : 'archived';
  return report;
}

/**
 * Validate an optimization run report
 */
export function validateOptimizationRunReport(report) {
  return OptimizationRunReportEnvelopeSchema.safeParse(report);
}

export default OptimizationRunReportEnvelopeSchema;
