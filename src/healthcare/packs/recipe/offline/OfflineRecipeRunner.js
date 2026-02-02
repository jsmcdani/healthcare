/**
 * OfflineRecipeRunner - Executes offline recipes on schedule
 *
 * Offline recipes:
 * - Run during off-hours or on demand
 * - Build derived indexes and packs
 * - Emit proposals for profile/policy changes
 * - Never auto-modify runtime behavior
 *
 * MAY:
 * - Read graph metadata via adapters
 * - Compute deterministic metrics
 * - Build derived indexes
 * - Recommend profile updates
 * - Emit proposals
 *
 * MAY NOT:
 * - Change runtime behavior directly
 * - Auto-modify policies without approval
 * - Learn dynamically during execution
 * - Use LLMs for control decisions
 */

import { Logger } from '../../../../utils/logger.js';
import {
  createOptimizationRunReport,
  startRun,
  addStepResult,
  completeRun
} from '../../../../core/artifacts/OptimizationRunReportEnvelope.js';
import {
  createProposal,
  submitProposal
} from '../../../../core/artifacts/ProposalEnvelope.js';
import { getPublicationGate } from '../../../../core/publication/PublicationGate.js';
import { requestApproval } from '../../../../core/publication/ApprovalWorkflow.js';

/**
 * Offline recipe namespace prefix
 */
export const OFFLINE_NAMESPACE = 'offline.';

/**
 * Offline recipe types
 */
export const OfflineRecipeTypes = {
  DETERMINANTS_BUILD: 'offline.determinants.build.v1',
  HOTSPOTS_COMPUTE: 'offline.hotspots.compute.v1',
  AFFINITY_ANALYZE: 'offline.affinity.analyze.v1',
  COVERAGE_ASSESS: 'offline.coverage.assess.v1',
  INDEX_REBUILD: 'offline.index.rebuild.v1'
};

/**
 * Offline Recipe Runner - manages scheduled offline execution
 */
export class OfflineRecipeRunner {
  constructor(options = {}) {
    this.logger = new Logger('OfflineRecipeRunner');
    this.recipeExecutor = options.recipeExecutor;
    this.artifactStore = options.artifactStore;
    this.publicationGate = options.publicationGate || getPublicationGate();

    // Scheduled runs
    this.scheduledRuns = new Map();
    this.runHistory = [];
    this.maxHistorySize = 100;

    // Running state
    this.isRunning = false;
    this.currentRun = null;
  }

  /**
   * Set the recipe executor
   */
  setRecipeExecutor(executor) {
    this.recipeExecutor = executor;
  }

  /**
   * Set the artifact store
   */
  setArtifactStore(store) {
    this.artifactStore = store;
  }

  /**
   * Schedule a recipe for periodic execution
   */
  scheduleRecipe(recipeId, options = {}) {
    const {
      cronExpression,
      intervalMs,
      orgId,
      inputs = {},
      enabled = true,
      description
    } = options;

    if (!recipeId.startsWith(OFFLINE_NAMESPACE)) {
      throw new Error(`Recipe ${recipeId} is not an offline recipe (must start with '${OFFLINE_NAMESPACE}')`);
    }

    const scheduleId = `schedule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const schedule = {
      scheduleId,
      recipeId,
      cronExpression,
      intervalMs,
      orgId,
      inputs,
      enabled,
      description,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: this.calculateNextRun(cronExpression, intervalMs),
      runCount: 0,
      failureCount: 0
    };

    this.scheduledRuns.set(scheduleId, schedule);
    this.logger.info(`Scheduled offline recipe: ${recipeId}`, { scheduleId, orgId });

    return schedule;
  }

  /**
   * Unschedule a recipe
   */
  unscheduleRecipe(scheduleId) {
    const schedule = this.scheduledRuns.get(scheduleId);
    if (schedule) {
      this.scheduledRuns.delete(scheduleId);
      this.logger.info(`Unscheduled recipe: ${schedule.recipeId}`, { scheduleId });
      return true;
    }
    return false;
  }

  /**
   * Run an offline recipe immediately
   */
  async runRecipe(recipeId, options = {}) {
    const {
      orgId,
      inputs = {},
      userId = 'system',
      triggeredBy = 'manual'
    } = options;

    if (!recipeId.startsWith(OFFLINE_NAMESPACE)) {
      throw new Error(`Recipe ${recipeId} is not an offline recipe`);
    }

    if (!this.recipeExecutor) {
      throw new Error('Recipe executor not configured');
    }

    this.logger.info(`Starting offline recipe run: ${recipeId}`, { orgId, triggeredBy });

    // Create run report
    const report = createOptimizationRunReport({
      name: `${recipeId} Run`,
      description: `Offline execution of ${recipeId}`,
      orgId,
      createdBy: userId,
      recipeId,
      recipeVersion: '1.0.0',
      triggeredBy
    });

    // Start the run
    startRun(report);
    this.currentRun = report;

    try {
      // Execute the recipe
      const context = {
        orgId,
        userId,
        recipeId,
        isOffline: true,
        traceId: report.payload.runId
      };

      const result = await this.recipeExecutor.execute(recipeId, inputs, context);

      // Process results based on recipe type
      const artifacts = await this.processRecipeResults(recipeId, result, context);

      // Add artifacts to report
      report.payload.producedArtifacts = artifacts.map(a => ({
        artifactId: a.payload?.artifactId || a.artifactId,
        artifactType: a.payload?.artifactType || a.artifactType,
        name: a.payload?.name || a.name
      }));

      // Complete the run
      completeRun(report, true, {
        totalItems: result.data?.length || 0,
        processedItems: result.data?.length || 0,
        successRate: 1.0
      });

      // Store report
      if (this.artifactStore) {
        await this.artifactStore.save(report);
      }

      this.addToHistory(report);
      this.currentRun = null;

      this.logger.info(`Offline recipe run completed: ${recipeId}`, {
        runId: report.payload.runId,
        artifactCount: artifacts.length
      });

      return {
        success: true,
        report,
        artifacts
      };

    } catch (error) {
      // Record failure
      addStepResult(report, {
        stepId: 'execution',
        stepName: 'Recipe Execution',
        status: 'failed',
        error: {
          message: error.message,
          code: error.code,
          recoverable: false
        }
      });

      completeRun(report, false);

      if (this.artifactStore) {
        await this.artifactStore.save(report);
      }

      this.addToHistory(report);
      this.currentRun = null;

      this.logger.error(`Offline recipe run failed: ${recipeId}`, error);

      return {
        success: false,
        report,
        error: error.message
      };
    }
  }

  /**
   * Process recipe results and create artifacts/proposals
   */
  async processRecipeResults(recipeId, result, context) {
    const artifacts = [];

    // Check if result recommends profile/policy changes
    if (result.data?.recommendations || result.data?.proposedChanges) {
      const proposals = await this.createProposalsFromRecommendations(
        result.data.recommendations || result.data.proposedChanges,
        recipeId,
        context
      );
      artifacts.push(...proposals);
    }

    // Check if result contains pack data
    if (result.data?.packData || result.data?.items) {
      // Pack artifacts are handled by the recipe itself
      // They emit proposals if risk > LOW
    }

    return artifacts;
  }

  /**
   * Create proposals from recipe recommendations
   */
  async createProposalsFromRecommendations(recommendations, recipeId, context) {
    const proposals = [];

    for (const rec of recommendations) {
      // Determine proposal type based on recommendation
      let proposalType = 'configuration';
      if (rec.targetType === 'profile') proposalType = 'profile_update';
      if (rec.targetType === 'policy') proposalType = 'policy_change';
      if (rec.targetType === 'pack') proposalType = 'pack_promotion';

      const proposal = createProposal({
        name: rec.title || `${recipeId} Recommendation`,
        description: rec.description,
        orgId: context.orgId,
        createdBy: context.userId,
        proposalType,
        title: rec.title || `Automated recommendation from ${recipeId}`,
        rationale: rec.rationale || `Generated by offline analysis recipe ${recipeId}`,
        urgency: rec.priority === 'high' ? 'high' : 'normal',
        changeSpec: {
          targetType: rec.targetType || 'unknown',
          targetId: rec.targetId || 'unknown',
          changeType: rec.changeType || 'update',
          diff: {
            before: rec.currentValue,
            after: rec.proposedValue
          }
        },
        approvalRequirements: [{
          approverRole: 'admin',
          approverCount: 1
        }]
      });

      // Submit proposal
      submitProposal(proposal);

      // Request approval through workflow
      try {
        await requestApproval(proposal, {
          requestedBy: context.userId,
          reason: `Automated recommendation from ${recipeId}`
        });
      } catch (e) {
        this.logger.warn(`Could not create approval request: ${e.message}`);
      }

      proposals.push(proposal);
    }

    return proposals;
  }

  /**
   * Check and run due scheduled recipes
   */
  async checkScheduledRuns() {
    const now = new Date();

    for (const [scheduleId, schedule] of this.scheduledRuns) {
      if (!schedule.enabled) continue;
      if (!schedule.nextRunAt) continue;
      if (new Date(schedule.nextRunAt) > now) continue;

      this.logger.info(`Running scheduled recipe: ${schedule.recipeId}`, { scheduleId });

      try {
        const result = await this.runRecipe(schedule.recipeId, {
          orgId: schedule.orgId,
          inputs: schedule.inputs,
          triggeredBy: 'scheduled'
        });

        schedule.lastRunAt = now.toISOString();
        schedule.runCount++;
        if (!result.success) {
          schedule.failureCount++;
        }
      } catch (error) {
        schedule.failureCount++;
        this.logger.error(`Scheduled run failed: ${schedule.recipeId}`, error);
      }

      // Calculate next run
      schedule.nextRunAt = this.calculateNextRun(schedule.cronExpression, schedule.intervalMs);
    }
  }

  /**
   * Calculate next run time
   */
  calculateNextRun(cronExpression, intervalMs) {
    if (intervalMs) {
      return new Date(Date.now() + intervalMs).toISOString();
    }

    if (cronExpression) {
      // Simple cron parsing for common patterns
      // In production, use a proper cron library
      const now = new Date();
      const parts = cronExpression.split(' ');

      if (parts[0] === '0' && parts[1] === '0') {
        // Daily at midnight
        const next = new Date(now);
        next.setDate(next.getDate() + 1);
        next.setHours(0, 0, 0, 0);
        return next.toISOString();
      }

      // Default: 24 hours from now
      return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }

    return null;
  }

  /**
   * Add run to history
   */
  addToHistory(report) {
    this.runHistory.push({
      runId: report.payload.runId,
      recipeId: report.payload.recipeId,
      status: report.payload.runStatus,
      startedAt: report.payload.startedAt,
      completedAt: report.payload.completedAt,
      durationMs: report.payload.durationMs
    });

    // Trim history
    if (this.runHistory.length > this.maxHistorySize) {
      this.runHistory = this.runHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get run history
   */
  getRunHistory(limit = 20) {
    return this.runHistory.slice(-limit);
  }

  /**
   * Get scheduled runs
   */
  getScheduledRuns() {
    return Array.from(this.scheduledRuns.values());
  }

  /**
   * Get current run status
   */
  getCurrentRunStatus() {
    if (!this.currentRun) {
      return { running: false };
    }

    return {
      running: true,
      runId: this.currentRun.payload.runId,
      recipeId: this.currentRun.payload.recipeId,
      startedAt: this.currentRun.payload.startedAt
    };
  }

  /**
   * Start the scheduler (call periodically or in a background job)
   */
  async startScheduler(intervalMs = 60000) {
    if (this.schedulerInterval) {
      return; // Already running
    }

    this.logger.info('Starting offline recipe scheduler');

    this.schedulerInterval = setInterval(async () => {
      try {
        await this.checkScheduledRuns();
      } catch (error) {
        this.logger.error('Scheduler check failed:', error);
      }
    }, intervalMs);
  }

  /**
   * Stop the scheduler
   */
  stopScheduler() {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
      this.logger.info('Stopped offline recipe scheduler');
    }
  }
}

// Singleton instance
let runnerInstance = null;

/**
 * Get the global offline recipe runner
 */
export function getOfflineRecipeRunner() {
  if (!runnerInstance) {
    runnerInstance = new OfflineRecipeRunner();
  }
  return runnerInstance;
}

export default OfflineRecipeRunner;
