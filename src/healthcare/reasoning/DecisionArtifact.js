/**
 * Decision Artifact
 * Structured output capturing decisions, reasoning, and audit trail
 */

import { Logger } from '../../utils/logger.js';
import { ReasonBuilder } from './ReasonBuilder.js';

/**
 * Decision outcomes
 */
export const DecisionOutcome = {
  APPROVED: 'APPROVED',
  DENIED: 'DENIED',
  CONDITIONAL: 'CONDITIONAL',
  DEFERRED: 'DEFERRED',
  ESCALATED: 'ESCALATED',
  ERROR: 'ERROR'
};

/**
 * Decision categories
 */
export const DecisionCategory = {
  ACCESS_CONTROL: 'ACCESS_CONTROL',
  DATA_MODIFICATION: 'DATA_MODIFICATION',
  SCHEMA_CHANGE: 'SCHEMA_CHANGE',
  AUTOMATION_CHANGE: 'AUTOMATION_CHANGE',
  MIGRATION: 'MIGRATION',
  COMPLIANCE: 'COMPLIANCE',
  SECURITY: 'SECURITY'
};

export class DecisionArtifact {
  constructor(options = {}) {
    this.id = options.id || `decision_${Date.now()}`;
    this.logger = new Logger('DecisionArtifact');

    // Core decision data
    this.taskType = options.taskType;
    this.category = options.category || this.inferCategory(options.taskType);
    this.outcome = null;
    this.timestamp = new Date().toISOString();

    // Context
    this.context = {
      task: options.task || {},
      intentMode: options.intentMode,
      requestor: options.requestor,
      environment: options.environment || process.env.NODE_ENV,
      ...options.context
    };

    // Reasoning
    this.reasonBuilder = options.reasonBuilder || ReasonBuilder.create();
    this.reasoning = null;

    // Policy trace
    this.policyTrace = [];
    this.knowledgeUsed = [];

    // Recipe execution
    this.recipeExecution = null;

    // Conditions (for CONDITIONAL outcome)
    this.conditions = [];

    // Next steps (for DEFERRED/ESCALATED)
    this.nextSteps = [];

    // Audit data
    this.audit = {
      createdAt: this.timestamp,
      createdBy: options.requestor || 'system',
      version: 1,
      changes: []
    };

    // Correctness assurance (Phase 9)
    this.correctness = null;
  }

  /**
   * Create a new decision artifact
   */
  static create(options = {}) {
    return new DecisionArtifact(options);
  }

  /**
   * Set the decision outcome
   */
  setOutcome(outcome, explanation = null) {
    this.outcome = outcome;
    if (explanation) {
      this.reasonBuilder.setConclusion(outcome, explanation);
    }
    return this;
  }

  /**
   * Approve the decision
   */
  approve(explanation = 'Decision approved based on policy evaluation') {
    return this.setOutcome(DecisionOutcome.APPROVED, explanation);
  }

  /**
   * Deny the decision
   */
  deny(explanation, violations = []) {
    this.setOutcome(DecisionOutcome.DENIED, explanation);
    for (const v of violations) {
      this.reasonBuilder.addConstraintReason(v.rule, v.violation, v.message);
    }
    return this;
  }

  /**
   * Set conditional approval
   */
  conditional(explanation, conditions) {
    this.setOutcome(DecisionOutcome.CONDITIONAL, explanation);
    this.conditions = conditions;
    return this;
  }

  /**
   * Defer the decision
   */
  defer(explanation, nextSteps) {
    this.setOutcome(DecisionOutcome.DEFERRED, explanation);
    this.nextSteps = nextSteps;
    return this;
  }

  /**
   * Escalate the decision
   */
  escalate(explanation, escalationTarget, nextSteps) {
    this.setOutcome(DecisionOutcome.ESCALATED, explanation);
    this.context.escalationTarget = escalationTarget;
    this.nextSteps = nextSteps;
    return this;
  }

  /**
   * Add policy trace entry
   */
  addPolicyTrace(entry) {
    this.policyTrace.push({
      ...entry,
      timestamp: new Date().toISOString()
    });
    return this;
  }

  /**
   * Add knowledge reference
   */
  addKnowledgeUsed(knowledge) {
    this.knowledgeUsed.push({
      key: knowledge.key,
      category: knowledge.category,
      relevance: knowledge.relevance,
      usedAt: new Date().toISOString()
    });
    return this;
  }

  /**
   * Set recipe execution details
   */
  setRecipeExecution(execution) {
    this.recipeExecution = {
      recipeId: execution.recipe,
      executionId: execution.id,
      status: execution.status,
      duration: execution.duration,
      stepsCompleted: execution.steps?.filter(s => s.status === 'completed').length || 0,
      totalSteps: execution.steps?.length || 0,
      outputs: execution.outputs,
      errors: execution.errors
    };
    return this;
  }

  /**
   * Set correctness envelope (Phase 9)
   */
  setCorrectness(correctnessEnvelope) {
    this.correctness = {
      envelopeId: correctnessEnvelope.header?.envelopeId,
      status: correctnessEnvelope.payload?.assessment?.status,
      canProceed: correctnessEnvelope.payload?.verdict?.canProceed,
      confidence: correctnessEnvelope.payload?.assessment?.metrics?.overallConfidence,
      requiresReview: correctnessEnvelope.payload?.reviewRequirement?.required,
      reviewStatus: correctnessEnvelope.payload?.reviewRequirement?.reviewStatus,
      assertions: {
        total: correctnessEnvelope.payload?.assessment?.metrics?.totalAssertions,
        passed: correctnessEnvelope.payload?.assessment?.metrics?.passedAssertions,
        failed: correctnessEnvelope.payload?.assessment?.metrics?.failedAssertions
      },
      warnings: correctnessEnvelope.payload?.verdict?.warnings,
      blockedBy: correctnessEnvelope.payload?.verdict?.blockedBy,
      evaluatedAt: correctnessEnvelope._meta?.evaluatedAt
    };
    return this;
  }

  /**
   * Check if correctness allows proceeding
   */
  correctnessAllowsProceeding() {
    if (!this.correctness) return true; // No correctness check performed
    return this.correctness.canProceed === true;
  }

  /**
   * Add a reason using the builder
   */
  addReason(type, source, description, options = {}) {
    switch (type) {
      case 'policy':
        this.reasonBuilder.addPolicyReason(source.policyId, source.ruleId, description, options.impact);
        break;
      case 'knowledge':
        this.reasonBuilder.addKnowledgeReason(source.key, source.category, description, options.confidence);
        break;
      case 'constraint':
        this.reasonBuilder.addConstraintReason(source.name, options.violation, description);
        break;
      case 'compliance':
        this.reasonBuilder.addComplianceReason(source.regulation, source.requirement, description, options.mandatory);
        break;
      case 'risk':
        this.reasonBuilder.addRiskReason(source.category, options.severity, description, options.mitigations);
        break;
      default:
        this.reasonBuilder.addReason({ type, source, description, ...options });
    }
    return this;
  }

  /**
   * Build the reasoning structure
   */
  buildReasoning() {
    this.reasoning = this.reasonBuilder.build();
    return this;
  }

  /**
   * Finalize the artifact
   */
  finalize() {
    this.buildReasoning();

    this.audit.finalizedAt = new Date().toISOString();
    this.audit.duration = new Date(this.audit.finalizedAt) - new Date(this.audit.createdAt);

    return this;
  }

  /**
   * Get the complete artifact
   */
  toArtifact() {
    if (!this.reasoning) {
      this.buildReasoning();
    }

    return {
      id: this.id,
      taskType: this.taskType,
      category: this.category,
      outcome: this.outcome,
      timestamp: this.timestamp,
      context: this.context,
      reasoning: this.reasoning,
      policyTrace: this.policyTrace,
      knowledgeUsed: this.knowledgeUsed,
      recipeExecution: this.recipeExecution,
      correctness: this.correctness,
      conditions: this.conditions,
      nextSteps: this.nextSteps,
      audit: this.audit
    };
  }

  /**
   * Get a summary suitable for display
   */
  getSummary() {
    return {
      id: this.id,
      outcome: this.outcome,
      category: this.category,
      confidence: this.reasoning?.confidence?.level?.label || 'Unknown',
      reasonCount: this.reasoning?.reasons?.length || 0,
      hasConditions: this.conditions.length > 0,
      hasNextSteps: this.nextSteps.length > 0,
      timestamp: this.timestamp
    };
  }

  /**
   * Get human-readable explanation
   */
  getExplanation() {
    const parts = [];

    // Outcome
    parts.push(`Decision: ${this.outcome}`);

    // Main reason
    if (this.reasoning?.conclusion?.explanation) {
      parts.push(`Explanation: ${this.reasoning.conclusion.explanation}`);
    }

    // Confidence
    if (this.reasoning?.confidence) {
      parts.push(`Confidence: ${this.reasoning.confidence.level.label} (${(this.reasoning.confidence.value * 100).toFixed(0)}%)`);
    }

    // Key reasons
    const highImpact = this.reasonBuilder.getHighImpactReasons();
    if (highImpact.length > 0) {
      parts.push('\nKey Factors:');
      for (const reason of highImpact.slice(0, 3)) {
        parts.push(`  - ${reason.description}`);
      }
    }

    // Conditions
    if (this.conditions.length > 0) {
      parts.push('\nConditions for Approval:');
      for (const condition of this.conditions) {
        parts.push(`  - ${condition}`);
      }
    }

    // Next steps
    if (this.nextSteps.length > 0) {
      parts.push('\nNext Steps:');
      for (const step of this.nextSteps) {
        parts.push(`  - ${step}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Check if decision allows proceeding
   */
  allowsProceeding() {
    return this.outcome === DecisionOutcome.APPROVED ||
           this.outcome === DecisionOutcome.CONDITIONAL;
  }

  /**
   * Check if decision requires action
   */
  requiresAction() {
    return this.outcome === DecisionOutcome.CONDITIONAL ||
           this.outcome === DecisionOutcome.DEFERRED ||
           this.outcome === DecisionOutcome.ESCALATED;
  }

  /**
   * Infer category from task type
   */
  inferCategory(taskType) {
    if (!taskType) return DecisionCategory.SECURITY;

    const typeStr = taskType.toLowerCase();
    if (typeStr.includes('access') || typeStr.includes('permission')) {
      return DecisionCategory.ACCESS_CONTROL;
    }
    if (typeStr.includes('schema') || typeStr.includes('field') || typeStr.includes('object')) {
      return DecisionCategory.SCHEMA_CHANGE;
    }
    if (typeStr.includes('flow') || typeStr.includes('trigger') || typeStr.includes('automation')) {
      return DecisionCategory.AUTOMATION_CHANGE;
    }
    if (typeStr.includes('migration')) {
      return DecisionCategory.MIGRATION;
    }
    if (typeStr.includes('compliance') || typeStr.includes('audit')) {
      return DecisionCategory.COMPLIANCE;
    }
    if (typeStr.includes('data') || typeStr.includes('record')) {
      return DecisionCategory.DATA_MODIFICATION;
    }

    return DecisionCategory.SECURITY;
  }

  /**
   * Update the artifact (with audit tracking)
   */
  update(changes) {
    this.audit.changes.push({
      timestamp: new Date().toISOString(),
      changes: Object.keys(changes),
      previousVersion: this.audit.version
    });
    this.audit.version++;

    Object.assign(this, changes);
    return this;
  }

  /**
   * Export for storage
   */
  toJSON() {
    return this.toArtifact();
  }

  /**
   * Import from stored format
   */
  static fromJSON(json) {
    const artifact = new DecisionArtifact({
      id: json.id,
      taskType: json.taskType,
      category: json.category,
      context: json.context
    });

    artifact.outcome = json.outcome;
    artifact.timestamp = json.timestamp;
    artifact.reasoning = json.reasoning;
    artifact.policyTrace = json.policyTrace || [];
    artifact.knowledgeUsed = json.knowledgeUsed || [];
    artifact.recipeExecution = json.recipeExecution;
    artifact.correctness = json.correctness;
    artifact.conditions = json.conditions || [];
    artifact.nextSteps = json.nextSteps || [];
    artifact.audit = json.audit || {};

    if (json.reasoning) {
      artifact.reasonBuilder = ReasonBuilder.fromJSON(json.reasoning);
    }

    return artifact;
  }
}

export default DecisionArtifact;
