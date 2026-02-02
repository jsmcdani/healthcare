/**
 * OutcomeTracker - Records and manages decision outcomes
 *
 * Links decisions to their real-world results for learning and
 * continuous improvement of correctness assurance.
 */

import { Logger } from '../../../utils/logger.js';
import {
  createOutcomeRecord,
  addRetrospectiveAssessment,
  addLearningAction,
  markActionImplemented,
  closeOutcomeRecord,
  OutcomeType,
  OutcomeSeverity,
  LearningAction
} from './OutcomeRecordEnvelope.js';

/**
 * Outcome Tracker
 */
export class OutcomeTracker {
  constructor(options = {}) {
    this.logger = new Logger('OutcomeTracker');
    this.outcomes = new Map();
    this.byDecision = new Map();
    this.byCategory = new Map();
    this.byOutcomeType = new Map();

    // Initialize type indices
    for (const type of Object.values(OutcomeType)) {
      this.byOutcomeType.set(type, new Set());
    }

    // Callbacks
    this.onAdverseEvent = options.onAdverseEvent;
    this.onLearningActionNeeded = options.onLearningActionNeeded;
  }

  /**
   * Record a new outcome
   */
  async recordOutcome(options) {
    const outcomeRecord = createOutcomeRecord(options);
    const outcomeId = outcomeRecord.payload.outcomeId;
    const decisionId = options.decisionRef.artifactId;
    const outcomeType = options.outcome.type;
    const category = options.category;

    // Store outcome
    this.outcomes.set(outcomeId, outcomeRecord);

    // Index by decision
    if (!this.byDecision.has(decisionId)) {
      this.byDecision.set(decisionId, new Set());
    }
    this.byDecision.get(decisionId).add(outcomeId);

    // Index by type
    this.byOutcomeType.get(outcomeType)?.add(outcomeId);

    // Index by category
    if (category) {
      if (!this.byCategory.has(category)) {
        this.byCategory.set(category, new Set());
      }
      this.byCategory.get(category).add(outcomeId);
    }

    this.logger.info('Outcome recorded', {
      outcomeId,
      decisionId,
      type: outcomeType,
      severity: options.outcome.severity
    });

    // Handle adverse events
    if (outcomeType === OutcomeType.ADVERSE_EVENT) {
      await this.handleAdverseEvent(outcomeRecord);
    }

    return outcomeRecord;
  }

  /**
   * Get outcome by ID
   */
  getOutcome(outcomeId) {
    return this.outcomes.get(outcomeId);
  }

  /**
   * Get outcomes for a decision
   */
  getOutcomesForDecision(decisionId) {
    const ids = this.byDecision.get(decisionId) || new Set();
    return Array.from(ids).map(id => this.outcomes.get(id)).filter(Boolean);
  }

  /**
   * Get outcomes by type
   */
  getOutcomesByType(type) {
    const ids = this.byOutcomeType.get(type) || new Set();
    return Array.from(ids).map(id => this.outcomes.get(id)).filter(Boolean);
  }

  /**
   * Get outcomes by category
   */
  getOutcomesByCategory(category) {
    const ids = this.byCategory.get(category) || new Set();
    return Array.from(ids).map(id => this.outcomes.get(id)).filter(Boolean);
  }

  /**
   * Add assessment to an outcome
   */
  async assessOutcome(outcomeId, assessment) {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome) {
      throw new Error(`Outcome not found: ${outcomeId}`);
    }

    addRetrospectiveAssessment(outcome, assessment);

    this.logger.info('Outcome assessed', {
      outcomeId,
      decisionWasCorrect: assessment.decisionWasCorrect
    });

    // Suggest learning actions if decision was incorrect
    if (assessment.decisionWasCorrect === false) {
      await this.suggestLearningActions(outcome, assessment);
    }

    return outcome;
  }

  /**
   * Add learning action to outcome
   */
  async addAction(outcomeId, action) {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome) {
      throw new Error(`Outcome not found: ${outcomeId}`);
    }

    addLearningAction(outcome, action);

    this.logger.info('Learning action added', {
      outcomeId,
      action: action.action,
      priority: action.priority
    });

    // Notify if callback registered
    if (this.onLearningActionNeeded && action.priority === 'high' || action.priority === 'critical') {
      try {
        await this.onLearningActionNeeded(outcome, action);
      } catch (error) {
        this.logger.warn('Learning action notification failed', { error: error.message });
      }
    }

    return outcome;
  }

  /**
   * Mark action as implemented
   */
  implementAction(outcomeId, actionIndex, implementedBy) {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome) {
      throw new Error(`Outcome not found: ${outcomeId}`);
    }

    markActionImplemented(outcome, actionIndex, implementedBy);

    this.logger.info('Action implemented', {
      outcomeId,
      actionIndex,
      implementedBy
    });

    return outcome;
  }

  /**
   * Close outcome record
   */
  closeOutcome(outcomeId) {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome) {
      throw new Error(`Outcome not found: ${outcomeId}`);
    }

    closeOutcomeRecord(outcome);

    this.logger.info('Outcome closed', { outcomeId });

    return outcome;
  }

  /**
   * Handle adverse event
   */
  async handleAdverseEvent(outcomeRecord) {
    const severity = outcomeRecord.payload.outcome.severity;

    this.logger.warn('Adverse event recorded', {
      outcomeId: outcomeRecord.payload.outcomeId,
      decisionId: outcomeRecord.payload.decisionRef.artifactId,
      severity
    });

    // Notify callback
    if (this.onAdverseEvent) {
      try {
        await this.onAdverseEvent(outcomeRecord);
      } catch (error) {
        this.logger.error('Adverse event notification failed', { error: error.message });
      }
    }

    // Automatically suggest high-priority learning actions
    if (severity === OutcomeSeverity.SEVERE || severity === OutcomeSeverity.MAJOR) {
      await this.addAction(outcomeRecord.payload.outcomeId, {
        action: LearningAction.FLAG_PATTERN,
        description: `High-severity adverse event requires immediate review`,
        priority: 'critical'
      });
    }
  }

  /**
   * Suggest learning actions based on assessment
   */
  async suggestLearningActions(outcome, assessment) {
    const actions = [];

    // If root cause identified, suggest specific actions
    if (assessment.rootCause) {
      if (assessment.rootCause.includes('knowledge')) {
        actions.push({
          action: LearningAction.UPDATE_KNOWLEDGE,
          description: `Update knowledge base: ${assessment.rootCause}`,
          priority: 'high'
        });
      }

      if (assessment.rootCause.includes('threshold') || assessment.rootCause.includes('confidence')) {
        actions.push({
          action: LearningAction.ADJUST_THRESHOLD,
          description: `Review and adjust thresholds: ${assessment.rootCause}`,
          priority: 'medium'
        });
      }

      if (assessment.rootCause.includes('recipe') || assessment.rootCause.includes('logic')) {
        actions.push({
          action: LearningAction.MODIFY_RECIPE,
          description: `Review recipe logic: ${assessment.rootCause}`,
          priority: 'high'
        });
      }
    }

    // Always suggest calibration update for incorrect decisions
    actions.push({
      action: LearningAction.UPDATE_CALIBRATION,
      description: `Add calibration test case from outcome ${outcome.payload.outcomeId}`,
      priority: 'medium'
    });

    // Add all suggested actions
    for (const action of actions) {
      await this.addAction(outcome.payload.outcomeId, action);
    }

    return actions;
  }

  /**
   * Get outcomes requiring action
   */
  getOutcomesRequiringAction() {
    return Array.from(this.outcomes.values()).filter(o => {
      // Has unimplemented actions
      const actions = o.payload.learningActions || [];
      const hasUnimplementedActions = actions.some(a =>
        a.action !== LearningAction.NO_ACTION && !a.implementedAt
      );

      return o.payload.status !== 'closed' && hasUnimplementedActions;
    });
  }

  /**
   * Get statistics
   */
  getStats() {
    const total = this.outcomes.size;
    const byType = {};
    const bySeverity = {};
    let adverseCount = 0;
    let incorrectDecisions = 0;
    let pendingActions = 0;

    for (const outcome of this.outcomes.values()) {
      const type = outcome.payload.outcome.type;
      const severity = outcome.payload.outcome.severity;

      byType[type] = (byType[type] || 0) + 1;
      if (severity) {
        bySeverity[severity] = (bySeverity[severity] || 0) + 1;
      }

      if (type === OutcomeType.ADVERSE_EVENT) {
        adverseCount++;
      }

      if (outcome.payload.retrospectiveAssessment?.decisionWasCorrect === false) {
        incorrectDecisions++;
      }

      const actions = outcome.payload.learningActions || [];
      pendingActions += actions.filter(a =>
        a.action !== LearningAction.NO_ACTION && !a.implementedAt
      ).length;
    }

    return {
      total,
      byType,
      bySeverity,
      adverseEvents: adverseCount,
      incorrectDecisions,
      decisionAccuracy: total > 0 ? (total - incorrectDecisions) / total : 1,
      pendingActions
    };
  }

  /**
   * Generate report
   */
  generateReport(options = {}) {
    const { startDate, endDate, category, type } = options;

    let outcomes = Array.from(this.outcomes.values());

    // Filter by date
    if (startDate) {
      outcomes = outcomes.filter(o =>
        new Date(o.payload.recordedAt) >= new Date(startDate)
      );
    }
    if (endDate) {
      outcomes = outcomes.filter(o =>
        new Date(o.payload.recordedAt) <= new Date(endDate)
      );
    }

    // Filter by category
    if (category) {
      outcomes = outcomes.filter(o => o.payload.category === category);
    }

    // Filter by type
    if (type) {
      outcomes = outcomes.filter(o => o.payload.outcome.type === type);
    }

    // Calculate metrics
    const total = outcomes.length;
    const assessed = outcomes.filter(o => o.payload.retrospectiveAssessment).length;
    const incorrect = outcomes.filter(o =>
      o.payload.retrospectiveAssessment?.decisionWasCorrect === false
    ).length;

    const adverseEvents = outcomes.filter(o =>
      o.payload.outcome.type === OutcomeType.ADVERSE_EVENT
    );
    const severityDistribution = {};
    for (const ae of adverseEvents) {
      const sev = ae.payload.outcome.severity || 'unknown';
      severityDistribution[sev] = (severityDistribution[sev] || 0) + 1;
    }

    return {
      period: { startDate, endDate },
      filters: { category, type },
      totalOutcomes: total,
      assessedOutcomes: assessed,
      incorrectDecisions: incorrect,
      decisionAccuracy: assessed > 0 ? (assessed - incorrect) / assessed : null,
      adverseEvents: {
        total: adverseEvents.length,
        bySeverity: severityDistribution
      },
      topCategories: this.getTopCategories(outcomes, 5),
      learningActions: this.summarizeLearningActions(outcomes)
    };
  }

  /**
   * Get top categories by outcome count
   */
  getTopCategories(outcomes, limit) {
    const counts = {};
    for (const o of outcomes) {
      const cat = o.payload.category || 'uncategorized';
      counts[cat] = (counts[cat] || 0) + 1;
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([category, count]) => ({ category, count }));
  }

  /**
   * Summarize learning actions
   */
  summarizeLearningActions(outcomes) {
    const byAction = {};
    let total = 0;
    let implemented = 0;

    for (const o of outcomes) {
      const actions = o.payload.learningActions || [];
      for (const action of actions) {
        total++;
        byAction[action.action] = (byAction[action.action] || 0) + 1;
        if (action.implementedAt) {
          implemented++;
        }
      }
    }

    return {
      total,
      implemented,
      pending: total - implemented,
      byAction
    };
  }

  /**
   * Export outcomes for analysis
   */
  exportForAnalysis(filter = {}) {
    let outcomes = Array.from(this.outcomes.values());

    if (filter.category) {
      outcomes = outcomes.filter(o => o.payload.category === filter.category);
    }
    if (filter.type) {
      outcomes = outcomes.filter(o => o.payload.outcome.type === filter.type);
    }
    if (filter.status) {
      outcomes = outcomes.filter(o => o.payload.status === filter.status);
    }

    return outcomes.map(o => ({
      outcomeId: o.payload.outcomeId,
      decisionId: o.payload.decisionRef.artifactId,
      decisionTimestamp: o.payload.decisionRef.timestamp,
      outcomeType: o.payload.outcome.type,
      severity: o.payload.outcome.severity,
      description: o.payload.outcome.description,
      category: o.payload.category,
      decisionWasCorrect: o.payload.retrospectiveAssessment?.decisionWasCorrect,
      rootCause: o.payload.retrospectiveAssessment?.rootCause,
      learningActions: (o.payload.learningActions || []).map(a => a.action),
      recordedAt: o.payload.recordedAt,
      status: o.payload.status
    }));
  }
}

export default OutcomeTracker;
