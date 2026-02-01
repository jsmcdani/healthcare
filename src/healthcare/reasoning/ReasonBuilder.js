/**
 * Reason Builder
 * Constructs structured reasoning chains for decisions
 */

import { Logger } from '../../utils/logger.js';

/**
 * Reason types for healthcare decision making
 */
export const ReasonTypes = {
  POLICY: 'POLICY',           // Based on policy rule
  KNOWLEDGE: 'KNOWLEDGE',     // Based on domain knowledge
  HEURISTIC: 'HEURISTIC',     // Based on learned pattern
  CONSTRAINT: 'CONSTRAINT',   // Hard constraint violation
  GUIDELINE: 'GUIDELINE',     // Soft guideline recommendation
  RISK: 'RISK',               // Risk assessment
  COMPLIANCE: 'COMPLIANCE',   // Compliance requirement
  PRECEDENT: 'PRECEDENT'      // Based on prior decision
};

/**
 * Confidence levels
 */
export const ConfidenceLevels = {
  CERTAIN: { value: 1.0, label: 'Certain' },
  HIGH: { value: 0.85, label: 'High Confidence' },
  MODERATE: { value: 0.65, label: 'Moderate Confidence' },
  LOW: { value: 0.4, label: 'Low Confidence' },
  UNCERTAIN: { value: 0.2, label: 'Uncertain' }
};

export class ReasonBuilder {
  constructor() {
    this.logger = new Logger('ReasonBuilder');
    this.reasons = [];
    this.conclusion = null;
    this.confidence = 0;
    this.metadata = {};
  }

  /**
   * Start building a new reasoning chain
   */
  static create() {
    return new ReasonBuilder();
  }

  /**
   * Add a policy-based reason
   */
  addPolicyReason(policyId, ruleId, description, impact = 'medium') {
    return this.addReason({
      type: ReasonTypes.POLICY,
      source: { policyId, ruleId },
      description,
      impact,
      weight: 0.9  // Policy reasons have high weight
    });
  }

  /**
   * Add a knowledge-based reason
   */
  addKnowledgeReason(knowledgeKey, category, description, confidence = 0.8) {
    return this.addReason({
      type: ReasonTypes.KNOWLEDGE,
      source: { knowledgeKey, category },
      description,
      confidence,
      weight: confidence * 0.8
    });
  }

  /**
   * Add a heuristic-based reason
   */
  addHeuristicReason(heuristicName, pattern, description, confidence = 0.7) {
    return this.addReason({
      type: ReasonTypes.HEURISTIC,
      source: { heuristicName, pattern },
      description,
      confidence,
      weight: confidence * 0.6
    });
  }

  /**
   * Add a constraint violation reason
   */
  addConstraintReason(constraintName, violation, description) {
    return this.addReason({
      type: ReasonTypes.CONSTRAINT,
      source: { constraintName },
      violation,
      description,
      impact: 'high',
      weight: 1.0  // Constraints have maximum weight
    });
  }

  /**
   * Add a guideline-based reason
   */
  addGuidelineReason(guidelineName, recommendation, description) {
    return this.addReason({
      type: ReasonTypes.GUIDELINE,
      source: { guidelineName },
      recommendation,
      description,
      impact: 'low',
      weight: 0.4  // Guidelines are suggestions
    });
  }

  /**
   * Add a risk assessment reason
   */
  addRiskReason(riskCategory, severity, description, mitigations = []) {
    return this.addReason({
      type: ReasonTypes.RISK,
      source: { riskCategory },
      severity,
      description,
      mitigations,
      weight: this.riskSeverityToWeight(severity)
    });
  }

  /**
   * Add a compliance reason
   */
  addComplianceReason(regulation, requirement, description, mandatory = true) {
    return this.addReason({
      type: ReasonTypes.COMPLIANCE,
      source: { regulation },
      requirement,
      description,
      mandatory,
      weight: mandatory ? 1.0 : 0.7
    });
  }

  /**
   * Add a precedent-based reason
   */
  addPrecedentReason(precedentId, similarity, description) {
    return this.addReason({
      type: ReasonTypes.PRECEDENT,
      source: { precedentId },
      similarity,
      description,
      weight: similarity * 0.5
    });
  }

  /**
   * Add a generic reason
   */
  addReason(reason) {
    this.reasons.push({
      id: `reason_${Date.now()}_${this.reasons.length}`,
      timestamp: new Date().toISOString(),
      ...reason
    });
    return this;
  }

  /**
   * Set the conclusion
   */
  setConclusion(decision, explanation) {
    this.conclusion = {
      decision,
      explanation,
      determinedAt: new Date().toISOString()
    };
    return this;
  }

  /**
   * Calculate overall confidence
   */
  calculateConfidence() {
    if (this.reasons.length === 0) {
      return ConfidenceLevels.UNCERTAIN.value;
    }

    // Weighted average of reason confidences/weights
    let totalWeight = 0;
    let weightedSum = 0;

    for (const reason of this.reasons) {
      const weight = reason.weight || 0.5;
      const confidence = reason.confidence || 0.5;
      totalWeight += weight;
      weightedSum += weight * confidence;
    }

    this.confidence = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
    return this.confidence;
  }

  /**
   * Get confidence level label
   */
  getConfidenceLevel() {
    const conf = this.confidence || this.calculateConfidence();

    if (conf >= ConfidenceLevels.CERTAIN.value) return ConfidenceLevels.CERTAIN;
    if (conf >= ConfidenceLevels.HIGH.value) return ConfidenceLevels.HIGH;
    if (conf >= ConfidenceLevels.MODERATE.value) return ConfidenceLevels.MODERATE;
    if (conf >= ConfidenceLevels.LOW.value) return ConfidenceLevels.LOW;
    return ConfidenceLevels.UNCERTAIN;
  }

  /**
   * Set metadata
   */
  withMetadata(metadata) {
    this.metadata = { ...this.metadata, ...metadata };
    return this;
  }

  /**
   * Build the final reasoning structure
   */
  build() {
    this.calculateConfidence();

    return {
      reasons: this.reasons,
      conclusion: this.conclusion,
      confidence: {
        value: this.confidence,
        level: this.getConfidenceLevel()
      },
      metadata: this.metadata,
      summary: this.generateSummary(),
      buildTime: new Date().toISOString()
    };
  }

  /**
   * Generate a human-readable summary
   */
  generateSummary() {
    const parts = [];

    // Group reasons by type
    const byType = {};
    for (const reason of this.reasons) {
      if (!byType[reason.type]) byType[reason.type] = [];
      byType[reason.type].push(reason);
    }

    // Summarize each type
    if (byType[ReasonTypes.CONSTRAINT]?.length) {
      parts.push(`${byType[ReasonTypes.CONSTRAINT].length} constraint(s) evaluated`);
    }
    if (byType[ReasonTypes.POLICY]?.length) {
      parts.push(`${byType[ReasonTypes.POLICY].length} policy rule(s) applied`);
    }
    if (byType[ReasonTypes.COMPLIANCE]?.length) {
      parts.push(`${byType[ReasonTypes.COMPLIANCE].length} compliance check(s)`);
    }
    if (byType[ReasonTypes.RISK]?.length) {
      parts.push(`${byType[ReasonTypes.RISK].length} risk(s) identified`);
    }

    // Add conclusion
    if (this.conclusion) {
      parts.push(`Decision: ${this.conclusion.decision}`);
    }

    // Add confidence
    parts.push(`Confidence: ${this.getConfidenceLevel().label}`);

    return parts.join('. ');
  }

  /**
   * Convert risk severity to weight
   */
  riskSeverityToWeight(severity) {
    const weights = {
      critical: 1.0,
      high: 0.85,
      medium: 0.6,
      low: 0.3,
      info: 0.1
    };
    return weights[severity.toLowerCase()] || 0.5;
  }

  /**
   * Check if any reasons block the action
   */
  hasBlockingReasons() {
    return this.reasons.some(r =>
      r.type === ReasonTypes.CONSTRAINT ||
      (r.type === ReasonTypes.COMPLIANCE && r.mandatory) ||
      (r.type === ReasonTypes.RISK && r.severity === 'critical')
    );
  }

  /**
   * Get reasons by type
   */
  getReasonsByType(type) {
    return this.reasons.filter(r => r.type === type);
  }

  /**
   * Get high-impact reasons
   */
  getHighImpactReasons() {
    return this.reasons.filter(r =>
      r.impact === 'high' ||
      r.weight >= 0.8 ||
      r.severity === 'critical' ||
      r.severity === 'high'
    );
  }

  /**
   * Create a copy for branching reasoning
   */
  fork() {
    const forked = new ReasonBuilder();
    forked.reasons = [...this.reasons];
    forked.metadata = { ...this.metadata, forkedFrom: this.metadata };
    return forked;
  }

  /**
   * Merge another reason builder into this one
   */
  merge(other) {
    this.reasons.push(...other.reasons);
    this.metadata = { ...this.metadata, ...other.metadata };
    return this;
  }

  /**
   * Export for storage/transmission
   */
  toJSON() {
    return this.build();
  }

  /**
   * Import from stored format
   */
  static fromJSON(json) {
    const builder = new ReasonBuilder();
    builder.reasons = json.reasons || [];
    builder.conclusion = json.conclusion;
    builder.confidence = json.confidence?.value || 0;
    builder.metadata = json.metadata || {};
    return builder;
  }
}

export default ReasonBuilder;
