/**
 * FeedbackAnalyzer - Analyzes outcome data for patterns and insights
 *
 * Identifies trends, correlations, and opportunities for improvement
 * from recorded outcomes.
 */

import { Logger } from '../../../utils/logger.js';
import { OutcomeType, OutcomeSeverity, LearningAction } from './OutcomeRecordEnvelope.js';

/**
 * Pattern types
 */
export const PatternType = {
  RECURRING_ERROR: 'recurring_error',
  CATEGORY_CORRELATION: 'category_correlation',
  TIME_CORRELATION: 'time_correlation',
  SEVERITY_ESCALATION: 'severity_escalation',
  DECISION_BIAS: 'decision_bias',
  ROOT_CAUSE_CLUSTER: 'root_cause_cluster'
};

/**
 * Analysis result
 */
export class AnalysisResult {
  constructor() {
    this.patterns = [];
    this.recommendations = [];
    this.metrics = {};
    this.timestamp = new Date().toISOString();
  }

  addPattern(type, description, evidence, severity = 'medium') {
    this.patterns.push({ type, description, evidence, severity });
    return this;
  }

  addRecommendation(action, description, priority = 'medium', targetComponent = null) {
    this.recommendations.push({ action, description, priority, targetComponent });
    return this;
  }

  setMetrics(metrics) {
    this.metrics = metrics;
    return this;
  }
}

/**
 * Feedback Analyzer
 */
export class FeedbackAnalyzer {
  constructor(options = {}) {
    this.logger = new Logger('FeedbackAnalyzer');
    this.minPatternOccurrences = options.minPatternOccurrences || 3;
    this.correlationThreshold = options.correlationThreshold || 0.5;
  }

  /**
   * Analyze outcomes for patterns
   */
  analyze(outcomes) {
    const result = new AnalysisResult();

    this.logger.info('Analyzing outcomes', { count: outcomes.length });

    // Skip analysis if too few outcomes
    if (outcomes.length < this.minPatternOccurrences) {
      return result.setMetrics({ sampleSize: outcomes.length, insufficientData: true });
    }

    // Run all analyses
    this.analyzeRecurringErrors(outcomes, result);
    this.analyzeCategories(outcomes, result);
    this.analyzeTimePatterns(outcomes, result);
    this.analyzeSeverityTrends(outcomes, result);
    this.analyzeRootCauses(outcomes, result);
    this.analyzeDecisionAccuracy(outcomes, result);

    // Calculate overall metrics
    this.calculateOverallMetrics(outcomes, result);

    // Generate recommendations based on patterns
    this.generateRecommendations(result);

    return result;
  }

  /**
   * Analyze recurring errors
   */
  analyzeRecurringErrors(outcomes, result) {
    // Group outcomes by decision summary or category
    const errorGroups = {};

    for (const outcome of outcomes) {
      const payload = outcome.payload;
      if (payload.retrospectiveAssessment?.decisionWasCorrect === false) {
        const key = payload.decisionRef.recipeId || payload.category || 'unknown';
        if (!errorGroups[key]) {
          errorGroups[key] = [];
        }
        errorGroups[key].push(outcome);
      }
    }

    // Find recurring patterns
    for (const [key, errors] of Object.entries(errorGroups)) {
      if (errors.length >= this.minPatternOccurrences) {
        result.addPattern(
          PatternType.RECURRING_ERROR,
          `Recurring incorrect decisions in "${key}" (${errors.length} occurrences)`,
          { component: key, count: errors.length, outcomeIds: errors.map(e => e.payload.outcomeId) },
          errors.length >= 5 ? 'high' : 'medium'
        );
      }
    }
  }

  /**
   * Analyze categories
   */
  analyzeCategories(outcomes, result) {
    const categoryStats = {};

    for (const outcome of outcomes) {
      const cat = outcome.payload.category || 'uncategorized';
      if (!categoryStats[cat]) {
        categoryStats[cat] = { total: 0, incorrect: 0, adverse: 0 };
      }
      categoryStats[cat].total++;

      if (outcome.payload.retrospectiveAssessment?.decisionWasCorrect === false) {
        categoryStats[cat].incorrect++;
      }
      if (outcome.payload.outcome.type === OutcomeType.ADVERSE_EVENT) {
        categoryStats[cat].adverse++;
      }
    }

    // Find problematic categories
    for (const [cat, stats] of Object.entries(categoryStats)) {
      const errorRate = stats.total > 0 ? stats.incorrect / stats.total : 0;

      if (stats.total >= this.minPatternOccurrences && errorRate > 0.3) {
        result.addPattern(
          PatternType.CATEGORY_CORRELATION,
          `High error rate (${(errorRate * 100).toFixed(1)}%) in category "${cat}"`,
          { category: cat, errorRate, ...stats },
          errorRate > 0.5 ? 'high' : 'medium'
        );
      }

      if (stats.adverse >= this.minPatternOccurrences) {
        result.addPattern(
          PatternType.CATEGORY_CORRELATION,
          `Multiple adverse events (${stats.adverse}) in category "${cat}"`,
          { category: cat, adverseCount: stats.adverse },
          'high'
        );
      }
    }
  }

  /**
   * Analyze time patterns
   */
  analyzeTimePatterns(outcomes, result) {
    // Group by time periods (e.g., day of week, hour of day)
    const byDayOfWeek = Array(7).fill(0).map(() => ({ total: 0, incorrect: 0 }));
    const byHour = Array(24).fill(0).map(() => ({ total: 0, incorrect: 0 }));

    for (const outcome of outcomes) {
      const date = new Date(outcome.payload.decisionRef.timestamp);
      const day = date.getDay();
      const hour = date.getHours();

      byDayOfWeek[day].total++;
      byHour[hour].total++;

      if (outcome.payload.retrospectiveAssessment?.decisionWasCorrect === false) {
        byDayOfWeek[day].incorrect++;
        byHour[hour].incorrect++;
      }
    }

    // Find time correlations
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (let day = 0; day < 7; day++) {
      const stats = byDayOfWeek[day];
      const errorRate = stats.total > 0 ? stats.incorrect / stats.total : 0;

      if (stats.total >= this.minPatternOccurrences && errorRate > 0.4) {
        result.addPattern(
          PatternType.TIME_CORRELATION,
          `Higher error rate (${(errorRate * 100).toFixed(1)}%) on ${dayNames[day]}`,
          { dayOfWeek: dayNames[day], errorRate, ...stats },
          'medium'
        );
      }
    }

    // Check for overnight issues
    let nightErrors = 0;
    let nightTotal = 0;
    for (let hour = 22; hour <= 23; hour++) {
      nightTotal += byHour[hour].total;
      nightErrors += byHour[hour].incorrect;
    }
    for (let hour = 0; hour <= 6; hour++) {
      nightTotal += byHour[hour].total;
      nightErrors += byHour[hour].incorrect;
    }

    const nightErrorRate = nightTotal > 0 ? nightErrors / nightTotal : 0;
    if (nightTotal >= this.minPatternOccurrences && nightErrorRate > 0.4) {
      result.addPattern(
        PatternType.TIME_CORRELATION,
        `Higher error rate (${(nightErrorRate * 100).toFixed(1)}%) during overnight hours (10pm-6am)`,
        { period: 'overnight', errorRate: nightErrorRate, total: nightTotal, errors: nightErrors },
        'medium'
      );
    }
  }

  /**
   * Analyze severity trends
   */
  analyzeSeverityTrends(outcomes, result) {
    // Sort by time
    const sorted = [...outcomes]
      .filter(o => o.payload.outcome.type === OutcomeType.ADVERSE_EVENT)
      .sort((a, b) =>
        new Date(a.payload.recordedAt) - new Date(b.payload.recordedAt)
      );

    if (sorted.length < 5) return;

    // Check for severity escalation over time
    const severityScores = {
      [OutcomeSeverity.NONE]: 0,
      [OutcomeSeverity.MINOR]: 1,
      [OutcomeSeverity.MODERATE]: 2,
      [OutcomeSeverity.MAJOR]: 3,
      [OutcomeSeverity.SEVERE]: 4
    };

    const recentWindow = Math.min(10, Math.floor(sorted.length / 2));
    const earlyAvg = sorted.slice(0, recentWindow)
      .reduce((sum, o) => sum + (severityScores[o.payload.outcome.severity] || 0), 0) / recentWindow;
    const recentAvg = sorted.slice(-recentWindow)
      .reduce((sum, o) => sum + (severityScores[o.payload.outcome.severity] || 0), 0) / recentWindow;

    if (recentAvg > earlyAvg + 0.5) {
      result.addPattern(
        PatternType.SEVERITY_ESCALATION,
        `Adverse event severity appears to be increasing over time`,
        { earlyAverage: earlyAvg.toFixed(2), recentAverage: recentAvg.toFixed(2), delta: (recentAvg - earlyAvg).toFixed(2) },
        'high'
      );
    }
  }

  /**
   * Analyze root causes
   */
  analyzeRootCauses(outcomes, result) {
    const rootCauses = {};

    for (const outcome of outcomes) {
      const rootCause = outcome.payload.retrospectiveAssessment?.rootCause;
      if (rootCause) {
        // Normalize root cause text
        const normalized = rootCause.toLowerCase().trim();
        const key = this.categorizeRootCause(normalized);

        if (!rootCauses[key]) {
          rootCauses[key] = { count: 0, examples: [] };
        }
        rootCauses[key].count++;
        if (rootCauses[key].examples.length < 3) {
          rootCauses[key].examples.push(rootCause);
        }
      }
    }

    // Find common root causes
    for (const [cause, data] of Object.entries(rootCauses)) {
      if (data.count >= this.minPatternOccurrences) {
        result.addPattern(
          PatternType.ROOT_CAUSE_CLUSTER,
          `Common root cause cluster: "${cause}" (${data.count} occurrences)`,
          { rootCause: cause, count: data.count, examples: data.examples },
          data.count >= 5 ? 'high' : 'medium'
        );
      }
    }
  }

  /**
   * Categorize root cause text into buckets
   */
  categorizeRootCause(text) {
    if (text.includes('knowledge') || text.includes('data') || text.includes('information')) {
      return 'incomplete knowledge/data';
    }
    if (text.includes('logic') || text.includes('rule') || text.includes('algorithm')) {
      return 'logic/rule error';
    }
    if (text.includes('threshold') || text.includes('limit') || text.includes('boundary')) {
      return 'threshold/boundary issue';
    }
    if (text.includes('edge') || text.includes('unusual') || text.includes('rare')) {
      return 'edge case handling';
    }
    if (text.includes('integration') || text.includes('external') || text.includes('api')) {
      return 'external integration';
    }
    return 'other';
  }

  /**
   * Analyze decision accuracy
   */
  analyzeDecisionAccuracy(outcomes, result) {
    const assessed = outcomes.filter(o => o.payload.retrospectiveAssessment);
    if (assessed.length < this.minPatternOccurrences) return;

    const correct = assessed.filter(o =>
      o.payload.retrospectiveAssessment.decisionWasCorrect === true
    ).length;
    const accuracy = correct / assessed.length;

    // Check for decision bias (are we always erring in one direction?)
    const biasAnalysis = this.analyzeDecisionBias(assessed);
    if (biasAnalysis.hasBias) {
      result.addPattern(
        PatternType.DECISION_BIAS,
        `Potential decision bias detected: ${biasAnalysis.description}`,
        biasAnalysis,
        'medium'
      );
    }

    result.metrics.decisionAccuracy = accuracy;
    result.metrics.totalAssessed = assessed.length;
  }

  /**
   * Analyze for decision bias
   */
  analyzeDecisionBias(assessedOutcomes) {
    // This would need more context about what "direction" means in your domain
    // For now, check if we're consistently over-cautious or under-cautious
    const wouldChange = assessedOutcomes.filter(o =>
      o.payload.retrospectiveAssessment.wouldChangeDecision === true
    );

    if (wouldChange.length < this.minPatternOccurrences) {
      return { hasBias: false };
    }

    const alternatives = wouldChange
      .map(o => o.payload.retrospectiveAssessment.alternativeDecision)
      .filter(Boolean);

    // Simple keyword analysis
    const moreRestrictive = alternatives.filter(a =>
      a.toLowerCase().includes('restrict') ||
      a.toLowerCase().includes('deny') ||
      a.toLowerCase().includes('caution')
    ).length;

    const lessRestrictive = alternatives.filter(a =>
      a.toLowerCase().includes('approve') ||
      a.toLowerCase().includes('allow') ||
      a.toLowerCase().includes('proceed')
    ).length;

    if (moreRestrictive > alternatives.length * 0.7) {
      return {
        hasBias: true,
        direction: 'under-cautious',
        description: 'System may be too permissive - majority of changes would add restrictions',
        evidence: { moreRestrictive, lessRestrictive, total: alternatives.length }
      };
    }

    if (lessRestrictive > alternatives.length * 0.7) {
      return {
        hasBias: true,
        direction: 'over-cautious',
        description: 'System may be too restrictive - majority of changes would allow more',
        evidence: { moreRestrictive, lessRestrictive, total: alternatives.length }
      };
    }

    return { hasBias: false };
  }

  /**
   * Calculate overall metrics
   */
  calculateOverallMetrics(outcomes, result) {
    const total = outcomes.length;
    const assessed = outcomes.filter(o => o.payload.retrospectiveAssessment).length;
    const adverse = outcomes.filter(o => o.payload.outcome.type === OutcomeType.ADVERSE_EVENT).length;

    result.setMetrics({
      ...result.metrics,
      totalOutcomes: total,
      assessedOutcomes: assessed,
      assessmentRate: total > 0 ? assessed / total : 0,
      adverseEventRate: total > 0 ? adverse / total : 0,
      patternCount: result.patterns.length,
      highSeverityPatterns: result.patterns.filter(p => p.severity === 'high').length
    });
  }

  /**
   * Generate recommendations based on patterns
   */
  generateRecommendations(result) {
    for (const pattern of result.patterns) {
      switch (pattern.type) {
        case PatternType.RECURRING_ERROR:
          result.addRecommendation(
            LearningAction.MODIFY_RECIPE,
            `Review and improve logic for "${pattern.evidence.component}" which has recurring errors`,
            pattern.severity === 'high' ? 'high' : 'medium',
            pattern.evidence.component
          );
          result.addRecommendation(
            LearningAction.UPDATE_CALIBRATION,
            `Add calibration test cases for "${pattern.evidence.component}"`,
            'medium',
            pattern.evidence.component
          );
          break;

        case PatternType.CATEGORY_CORRELATION:
          if (pattern.evidence.adverseCount) {
            result.addRecommendation(
              LearningAction.ADD_ASSERTION,
              `Add additional safety assertions for category "${pattern.evidence.category}"`,
              'high',
              pattern.evidence.category
            );
          } else {
            result.addRecommendation(
              LearningAction.UPDATE_KNOWLEDGE,
              `Review knowledge base coverage for category "${pattern.evidence.category}"`,
              'medium',
              pattern.evidence.category
            );
          }
          break;

        case PatternType.ROOT_CAUSE_CLUSTER:
          result.addRecommendation(
            this.mapRootCauseToAction(pattern.evidence.rootCause),
            `Address root cause cluster: ${pattern.evidence.rootCause}`,
            pattern.severity === 'high' ? 'high' : 'medium'
          );
          break;

        case PatternType.SEVERITY_ESCALATION:
          result.addRecommendation(
            LearningAction.FLAG_PATTERN,
            `Urgent: Investigate cause of increasing adverse event severity`,
            'critical'
          );
          break;

        case PatternType.DECISION_BIAS:
          result.addRecommendation(
            LearningAction.ADJUST_THRESHOLD,
            `Review decision thresholds to address ${pattern.evidence.direction} bias`,
            'high'
          );
          break;
      }
    }
  }

  /**
   * Map root cause to learning action
   */
  mapRootCauseToAction(rootCause) {
    const mapping = {
      'incomplete knowledge/data': LearningAction.UPDATE_KNOWLEDGE,
      'logic/rule error': LearningAction.MODIFY_RECIPE,
      'threshold/boundary issue': LearningAction.ADJUST_THRESHOLD,
      'edge case handling': LearningAction.ADD_ASSERTION,
      'external integration': LearningAction.FLAG_PATTERN
    };
    return mapping[rootCause] || LearningAction.FLAG_PATTERN;
  }
}

export default FeedbackAnalyzer;
