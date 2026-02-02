/**
 * PublicationGate - Controls artifact publication
 *
 * Determines what can be published automatically vs what requires approval.
 * Lives in the control plane, not in recipes.
 */

import { z } from 'zod';
import { registerSchema, SchemaIds } from '../contracts/registry.js';

/**
 * Publication gate types
 */
export const PublicationGateType = {
  AUTO_PUBLISH_ALLOWED: 'AUTO_PUBLISH_ALLOWED',  // Safe derived indexes
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',         // Determinant/profile changes
  FORBIDDEN: 'FORBIDDEN'                          // SoT mutation, schema changes
};

export const PublicationGateTypeSchema = z.enum([
  'AUTO_PUBLISH_ALLOWED',
  'APPROVAL_REQUIRED',
  'FORBIDDEN'
]);

/**
 * Gate rule - defines when a gate applies
 */
export const GateRuleSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  gate: PublicationGateTypeSchema,
  condition: z.object({
    artifactType: z.string().optional(),
    artifactTypes: z.array(z.string()).optional(),
    riskClassification: z.string().optional(),
    riskClassifications: z.array(z.string()).optional(),
    statusTransition: z.object({
      from: z.string(),
      to: z.string()
    }).optional(),
    custom: z.function().optional()
  }),
  priority: z.number().default(0).describe('Higher priority rules evaluated first'),
  enabled: z.boolean().default(true),
  requiredApprovers: z.number().default(1).describe('For APPROVAL_REQUIRED gate'),
  approverRoles: z.array(z.string()).optional().describe('Roles that can approve'),
  metadata: z.record(z.any()).optional()
});

/**
 * Gate evaluation result
 */
export const GateEvaluationResultSchema = z.object({
  allowed: z.boolean(),
  gate: PublicationGateTypeSchema,
  appliedRule: z.string().optional(),
  reason: z.string(),
  requiredApprovers: z.number().optional(),
  approverRoles: z.array(z.string()).optional()
});

/**
 * Default gate rules
 */
const DEFAULT_RULES = [
  // FORBIDDEN rules (highest priority)
  {
    ruleId: 'forbid-schema-change',
    name: 'Forbid Direct Schema Changes',
    description: 'Schema changes cannot be auto-published',
    gate: PublicationGateType.FORBIDDEN,
    condition: { artifactType: 'schema' },
    priority: 100,
    enabled: true
  },
  {
    ruleId: 'forbid-sot-mutation',
    name: 'Forbid Source of Truth Mutation',
    description: 'Source of truth data cannot be directly modified',
    gate: PublicationGateType.FORBIDDEN,
    condition: { artifactType: 'source_of_truth' },
    priority: 100,
    enabled: true
  },

  // APPROVAL_REQUIRED rules (medium priority)
  {
    ruleId: 'approve-profile-change',
    name: 'Require Approval for Profile Changes',
    description: 'Determinant profile changes require approval',
    gate: PublicationGateType.APPROVAL_REQUIRED,
    condition: { artifactType: 'determinant_profile' },
    priority: 50,
    enabled: true,
    requiredApprovers: 1,
    approverRoles: ['admin', 'compliance_officer']
  },
  {
    ruleId: 'approve-policy-change',
    name: 'Require Approval for Policy Changes',
    description: 'Policy changes require approval',
    gate: PublicationGateType.APPROVAL_REQUIRED,
    condition: { artifactType: 'policy' },
    priority: 50,
    enabled: true,
    requiredApprovers: 1,
    approverRoles: ['admin', 'policy_admin']
  },
  {
    ruleId: 'approve-high-risk',
    name: 'Require Approval for High Risk Artifacts',
    description: 'High/critical risk artifacts require approval',
    gate: PublicationGateType.APPROVAL_REQUIRED,
    condition: { riskClassifications: ['HIGH', 'CRITICAL'] },
    priority: 40,
    enabled: true,
    requiredApprovers: 2,
    approverRoles: ['admin', 'security_officer']
  },

  // AUTO_PUBLISH_ALLOWED rules (lowest priority, default)
  {
    ruleId: 'auto-publish-packs',
    name: 'Auto-publish Feature Packs',
    description: 'Feature packs can be auto-published',
    gate: PublicationGateType.AUTO_PUBLISH_ALLOWED,
    condition: { artifactType: 'feature_pack' },
    priority: 10,
    enabled: true
  },
  {
    ruleId: 'auto-publish-reports',
    name: 'Auto-publish Reports',
    description: 'Reports and analytics can be auto-published',
    gate: PublicationGateType.AUTO_PUBLISH_ALLOWED,
    condition: { artifactTypes: ['optimization_report', 'analysis_report'] },
    priority: 10,
    enabled: true
  },
  {
    ruleId: 'auto-publish-low-risk',
    name: 'Auto-publish Low Risk Artifacts',
    description: 'Low risk artifacts can be auto-published',
    gate: PublicationGateType.AUTO_PUBLISH_ALLOWED,
    condition: { riskClassification: 'LOW' },
    priority: 5,
    enabled: true
  }
];

/**
 * Publication Gate - manages publication decisions
 */
export class PublicationGate {
  constructor(options = {}) {
    this.rules = new Map();
    this.enabled = options.enabled !== false;

    // Load default rules
    for (const rule of DEFAULT_RULES) {
      this.addRule(rule);
    }
  }

  /**
   * Add a gate rule
   */
  addRule(rule) {
    const validated = GateRuleSchema.parse(rule);
    this.rules.set(validated.ruleId, validated);
    return validated;
  }

  /**
   * Remove a rule
   */
  removeRule(ruleId) {
    return this.rules.delete(ruleId);
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(ruleId, enabled) {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = enabled;
    }
  }

  /**
   * Evaluate the gate for an artifact
   */
  evaluate(artifact) {
    if (!this.enabled) {
      return {
        allowed: true,
        gate: PublicationGateType.AUTO_PUBLISH_ALLOWED,
        reason: 'Publication gating is disabled'
      };
    }

    // Get sorted rules by priority (highest first)
    const sortedRules = Array.from(this.rules.values())
      .filter(r => r.enabled)
      .sort((a, b) => b.priority - a.priority);

    // Evaluate each rule
    for (const rule of sortedRules) {
      if (this.matchesCondition(artifact, rule.condition)) {
        return {
          allowed: rule.gate === PublicationGateType.AUTO_PUBLISH_ALLOWED,
          gate: rule.gate,
          appliedRule: rule.ruleId,
          reason: rule.description || rule.name,
          requiredApprovers: rule.requiredApprovers,
          approverRoles: rule.approverRoles
        };
      }
    }

    // Default: require approval for safety
    return {
      allowed: false,
      gate: PublicationGateType.APPROVAL_REQUIRED,
      reason: 'No matching rule found - defaulting to approval required'
    };
  }

  /**
   * Check if artifact matches a condition
   */
  matchesCondition(artifact, condition) {
    const payload = artifact.payload || artifact;

    // Check artifact type
    if (condition.artifactType && payload.artifactType !== condition.artifactType) {
      return false;
    }

    // Check artifact types (multiple)
    if (condition.artifactTypes && !condition.artifactTypes.includes(payload.artifactType)) {
      return false;
    }

    // Check risk classification
    if (condition.riskClassification && payload.riskClassification !== condition.riskClassification) {
      return false;
    }

    // Check risk classifications (multiple)
    if (condition.riskClassifications && !condition.riskClassifications.includes(payload.riskClassification)) {
      return false;
    }

    // Check status transition
    if (condition.statusTransition) {
      // Need previous state for transition check - would be passed in context
      // For now, this requires caller to provide oldStatus
      if (artifact._oldStatus !== condition.statusTransition.from ||
          payload.status !== condition.statusTransition.to) {
        return false;
      }
    }

    // Custom condition function
    if (condition.custom && typeof condition.custom === 'function') {
      if (!condition.custom(artifact)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if publication is allowed
   */
  isPublicationAllowed(artifact) {
    const result = this.evaluate(artifact);
    return result.allowed;
  }

  /**
   * Check if approval is required
   */
  isApprovalRequired(artifact) {
    const result = this.evaluate(artifact);
    return result.gate === PublicationGateType.APPROVAL_REQUIRED;
  }

  /**
   * Check if publication is forbidden
   */
  isPublicationForbidden(artifact) {
    const result = this.evaluate(artifact);
    return result.gate === PublicationGateType.FORBIDDEN;
  }

  /**
   * Get all rules
   */
  getRules() {
    return Array.from(this.rules.values());
  }

  /**
   * Get rule by ID
   */
  getRule(ruleId) {
    return this.rules.get(ruleId);
  }
}

// Singleton instance
let gateInstance = null;

/**
 * Get the global publication gate instance
 */
export function getPublicationGate() {
  if (!gateInstance) {
    gateInstance = new PublicationGate();
  }
  return gateInstance;
}

/**
 * Evaluate publication for an artifact
 */
export function evaluatePublication(artifact) {
  return getPublicationGate().evaluate(artifact);
}

// Register schema on load
try {
  registerSchema(SchemaIds.PUBLICATION_GATE, '1.0.0', GateRuleSchema);
} catch (e) {
  // Already registered
}

export default PublicationGate;
