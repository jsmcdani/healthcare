/**
 * Policy Tools for Healthcare Builder Agent
 *
 * Tools for creating and managing healthcare policy rules,
 * PHI protection settings, and approval workflows.
 */

export const policyTools = [
  {
    name: 'create_policy_rule',
    description: 'Create a new healthcare policy rule.',
    input_schema: {
      type: 'object',
      properties: {
        ruleId: {
          type: 'string',
          description: 'Unique identifier for the rule'
        },
        name: {
          type: 'string',
          description: 'Rule name'
        },
        description: {
          type: 'string',
          description: 'What this rule enforces'
        },
        category: {
          type: 'string',
          enum: ['phi_protection', 'access_control', 'audit', 'clinical', 'compliance', 'operational'],
          description: 'Policy category'
        },
        priority: {
          type: 'number',
          description: 'Rule priority (higher = evaluated first)',
          default: 100
        },
        condition: {
          type: 'object',
          description: 'Condition that triggers this rule',
          properties: {
            field: { type: 'string' },
            operator: { type: 'string', enum: ['equals', 'contains', 'in', 'not_in', 'gt', 'lt', 'exists', 'regex'] },
            value: { description: 'Value to compare' }
          }
        },
        action: {
          type: 'string',
          enum: ['allow', 'block', 'require_approval', 'audit', 'mask', 'escalate'],
          description: 'Action when rule matches'
        },
        escalationTarget: {
          type: 'string',
          description: 'For escalate action: who to escalate to'
        },
        auditLevel: {
          type: 'string',
          enum: ['none', 'basic', 'detailed', 'full'],
          description: 'Audit logging level for this rule'
        },
        message: {
          type: 'string',
          description: 'Message to show when rule triggers'
        },
        enabled: {
          type: 'boolean',
          default: true
        }
      },
      required: ['ruleId', 'name', 'category', 'condition', 'action']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const rule = {
          _key: input.ruleId,
          ruleId: input.ruleId,
          name: input.name,
          description: input.description,
          category: input.category,
          priority: input.priority || 100,
          condition: input.condition,
          action: input.action,
          escalationTarget: input.escalationTarget,
          auditLevel: input.auditLevel || 'basic',
          message: input.message || `Policy rule '${input.name}' triggered`,
          enabled: input.enabled !== false,
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          const col = db.collection('healthcare_policy_rules');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('healthcare_policy_rules');
          }
          await col.save(rule);
        }

        // Register with policy engine if available
        if (orchestrator.policyEngine) {
          // Policy engine expects rules in pack format
          const existingPacks = orchestrator.policyEngine.getLoadedPacks();
          const builderPack = existingPacks.find(p => p.name === 'healthcare-builder');

          if (!builderPack) {
            await orchestrator.policyEngine.loadPolicyPack({
              name: 'healthcare-builder',
              version: '1.0.0',
              rules: [rule]
            });
          }
        }

        return {
          success: true,
          ruleId: input.ruleId,
          name: input.name,
          category: input.category,
          action: input.action,
          priority: input.priority || 100,
          message: `Policy rule '${input.name}' created`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'configure_phi_protection',
    description: 'Configure PHI handling and protection rules.',
    input_schema: {
      type: 'object',
      properties: {
        configId: {
          type: 'string',
          description: 'Configuration identifier',
          default: 'default'
        },
        detectionEnabled: {
          type: 'boolean',
          description: 'Enable automatic PHI detection',
          default: true
        },
        detectionPatterns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              pattern: { type: 'string' },
              classification: { type: 'string' },
              action: { type: 'string', enum: ['mask', 'encrypt', 'block', 'audit'] }
            }
          },
          description: 'Custom PHI detection patterns'
        },
        maskingRules: {
          type: 'object',
          properties: {
            ssn: { type: 'string', default: '***-**-****' },
            dob: { type: 'string', default: '**/**/****' },
            mrn: { type: 'string', default: '********' },
            name: { type: 'string', default: '[REDACTED]' },
            address: { type: 'string', default: '[ADDRESS REDACTED]' },
            phone: { type: 'string', default: '***-***-****' },
            email: { type: 'string', default: '****@****.***' }
          },
          description: 'Masking patterns for PHI types'
        },
        accessRequirements: {
          type: 'object',
          properties: {
            requireMFA: { type: 'boolean' },
            requireBreakGlass: { type: 'boolean' },
            requireJustification: { type: 'boolean' },
            allowedRoles: { type: 'array', items: { type: 'string' } }
          },
          description: 'Access requirements for PHI'
        },
        auditSettings: {
          type: 'object',
          properties: {
            logAllAccess: { type: 'boolean', default: true },
            logExports: { type: 'boolean', default: true },
            retentionDays: { type: 'number', default: 2555 },
            alertThreshold: { type: 'number', description: 'Alert after N accesses per hour' }
          },
          description: 'Audit logging settings'
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const config = {
          _key: input.configId || 'default',
          configId: input.configId || 'default',
          detectionEnabled: input.detectionEnabled !== false,
          detectionPatterns: input.detectionPatterns || getDefaultPHIPatterns(),
          maskingRules: {
            ssn: '***-**-****',
            dob: '**/**/****',
            mrn: '********',
            name: '[REDACTED]',
            address: '[ADDRESS REDACTED]',
            phone: '***-***-****',
            email: '****@****.***',
            ...(input.maskingRules || {})
          },
          accessRequirements: {
            requireMFA: false,
            requireBreakGlass: false,
            requireJustification: true,
            allowedRoles: ['physician', 'nurse', 'healthcare_admin'],
            ...(input.accessRequirements || {})
          },
          auditSettings: {
            logAllAccess: true,
            logExports: true,
            retentionDays: 2555, // 7 years for HIPAA
            alertThreshold: 100,
            ...(input.auditSettings || {})
          },
          updatedAt: new Date().toISOString(),
          updatedBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          const col = db.collection('phi_protection_config');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('phi_protection_config');
          }

          // Upsert config
          try {
            await col.update(config._key, config);
          } catch (e) {
            await col.save(config);
          }
        }

        return {
          success: true,
          configId: config.configId,
          detectionEnabled: config.detectionEnabled,
          patternCount: config.detectionPatterns.length,
          accessRequirements: config.accessRequirements,
          auditRetention: `${config.auditSettings.retentionDays} days`,
          message: 'PHI protection configuration updated'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'set_approval_workflow',
    description: 'Configure approval requirements for sensitive operations.',
    input_schema: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'Workflow identifier'
        },
        name: {
          type: 'string',
          description: 'Workflow name'
        },
        triggerConditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              operation: { type: 'string' },
              riskLevel: { type: 'string', enum: ['critical', 'high', 'moderate'] },
              dataType: { type: 'string' }
            }
          },
          description: 'Conditions that require approval'
        },
        approvers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              userId: { type: 'string' },
              level: { type: 'number', description: 'Approval level (1 = first, 2 = second, etc.)' }
            }
          },
          description: 'Who can approve'
        },
        escalationRules: {
          type: 'object',
          properties: {
            timeoutMinutes: { type: 'number', default: 60 },
            escalateToRole: { type: 'string' },
            maxEscalations: { type: 'number', default: 2 }
          },
          description: 'Escalation if approval not received'
        },
        notificationSettings: {
          type: 'object',
          properties: {
            notifyOnRequest: { type: 'boolean', default: true },
            notifyOnApproval: { type: 'boolean', default: true },
            notifyOnRejection: { type: 'boolean', default: true },
            channels: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      required: ['workflowId', 'name', 'triggerConditions', 'approvers']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const workflow = {
          _key: input.workflowId,
          workflowId: input.workflowId,
          name: input.name,
          triggerConditions: input.triggerConditions,
          approvers: input.approvers.map((a, i) => ({
            ...a,
            level: a.level || i + 1
          })),
          escalationRules: {
            timeoutMinutes: 60,
            maxEscalations: 2,
            ...(input.escalationRules || {})
          },
          notificationSettings: {
            notifyOnRequest: true,
            notifyOnApproval: true,
            notifyOnRejection: true,
            channels: ['email'],
            ...(input.notificationSettings || {})
          },
          status: 'active',
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          const col = db.collection('approval_workflows');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('approval_workflows');
          }
          await col.save(workflow);
        }

        return {
          success: true,
          workflowId: input.workflowId,
          name: input.name,
          triggerCount: input.triggerConditions.length,
          approverCount: input.approvers.length,
          approvalLevels: Math.max(...input.approvers.map(a => a.level || 1)),
          timeoutMinutes: workflow.escalationRules.timeoutMinutes,
          message: `Approval workflow '${input.name}' created`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'test_policy',
    description: 'Evaluate a policy against a test scenario.',
    input_schema: {
      type: 'object',
      properties: {
        scenario: {
          type: 'object',
          description: 'Test scenario data',
          properties: {
            operation: { type: 'string' },
            user: { type: 'object' },
            resource: { type: 'object' },
            context: { type: 'object' }
          }
        },
        policyRuleIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific rules to test (optional, tests all if not specified)'
        },
        verbose: {
          type: 'boolean',
          description: 'Include detailed evaluation trace',
          default: false
        }
      },
      required: ['scenario']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        let rules = [];

        if (db) {
          let query = 'FOR r IN healthcare_policy_rules FILTER r.enabled == true';
          const bindVars = {};

          if (input.policyRuleIds?.length) {
            query += ' FILTER r.ruleId IN @ruleIds';
            bindVars.ruleIds = input.policyRuleIds;
          }

          query += ' SORT r.priority DESC RETURN r';

          const cursor = await db.query(query, bindVars);
          rules = await cursor.all();
        }

        // Evaluate scenario against rules
        const evaluationContext = buildEvaluationContext(input.scenario);
        const results = [];
        let finalAction = 'allow';
        let matchedRule = null;

        for (const rule of rules) {
          const match = evaluateCondition(rule.condition, evaluationContext);

          if (input.verbose) {
            results.push({
              ruleId: rule.ruleId,
              ruleName: rule.name,
              category: rule.category,
              priority: rule.priority,
              matched: match,
              action: match ? rule.action : null,
              condition: rule.condition
            });
          }

          if (match && !matchedRule) {
            matchedRule = rule;
            finalAction = rule.action;
            break; // First matching rule wins
          }
        }

        return {
          success: true,
          scenario: input.scenario,
          evaluation: {
            finalAction,
            matchedRule: matchedRule ? {
              ruleId: matchedRule.ruleId,
              name: matchedRule.name,
              category: matchedRule.category,
              message: matchedRule.message
            } : null,
            rulesEvaluated: rules.length
          },
          ...(input.verbose ? { trace: results } : {}),
          allowed: finalAction === 'allow',
          requiresApproval: finalAction === 'require_approval',
          blocked: finalAction === 'block'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'list_policies',
    description: 'List all healthcare policy rules.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category'
        },
        action: {
          type: 'string',
          description: 'Filter by action type'
        },
        enabledOnly: {
          type: 'boolean',
          description: 'Only show enabled rules',
          default: true
        },
        includeWorkflows: {
          type: 'boolean',
          description: 'Include approval workflows',
          default: false
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          // Get policy rules
          let ruleQuery = 'FOR r IN healthcare_policy_rules';
          const ruleFilters = [];
          const bindVars = {};

          if (input.enabledOnly) {
            ruleFilters.push('r.enabled == true');
          }

          if (input.category) {
            ruleFilters.push('r.category == @category');
            bindVars.category = input.category;
          }

          if (input.action) {
            ruleFilters.push('r.action == @action');
            bindVars.action = input.action;
          }

          if (ruleFilters.length > 0) {
            ruleQuery += ' FILTER ' + ruleFilters.join(' AND ');
          }

          ruleQuery += ' SORT r.priority DESC RETURN r';

          const ruleCursor = await db.query(ruleQuery, bindVars);
          const rules = await ruleCursor.all();

          // Get workflows if requested
          let workflows = [];
          if (input.includeWorkflows) {
            const workflowCursor = await db.query(`
              FOR w IN approval_workflows
              FILTER w.status == 'active'
              RETURN w
            `);
            workflows = await workflowCursor.all();
          }

          // Group rules by category
          const byCategory = {};
          for (const rule of rules) {
            if (!byCategory[rule.category]) {
              byCategory[rule.category] = [];
            }
            byCategory[rule.category].push({
              ruleId: rule.ruleId,
              name: rule.name,
              description: rule.description,
              priority: rule.priority,
              action: rule.action,
              enabled: rule.enabled
            });
          }

          return {
            success: true,
            totalRules: rules.length,
            byCategory,
            categories: Object.keys(byCategory),
            ...(input.includeWorkflows ? {
              workflows: workflows.map(w => ({
                workflowId: w.workflowId,
                name: w.name,
                triggerCount: w.triggerConditions?.length || 0,
                approverCount: w.approvers?.length || 0
              }))
            } : {})
          };
        }

        return {
          success: true,
          totalRules: 0,
          byCategory: {},
          note: 'Database not available'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];

/**
 * Get default PHI detection patterns
 */
function getDefaultPHIPatterns() {
  return [
    { name: 'SSN', pattern: '\\d{3}-\\d{2}-\\d{4}', classification: 'SSN', action: 'mask' },
    { name: 'MRN', pattern: 'MRN[\\s:]?\\d+', classification: 'MEDICAL_RECORD_NUMBER', action: 'mask' },
    { name: 'DOB', pattern: '\\d{1,2}/\\d{1,2}/\\d{4}', classification: 'DATE_OF_BIRTH', action: 'mask' },
    { name: 'Phone', pattern: '\\d{3}[-.\\s]?\\d{3}[-.\\s]?\\d{4}', classification: 'PHONE', action: 'mask' },
    { name: 'Email', pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}', classification: 'EMAIL', action: 'mask' },
    { name: 'PatientName', pattern: 'Patient[\\s:]?Name[\\s:]?[A-Z][a-z]+', classification: 'PATIENT_NAME', action: 'mask' }
  ];
}

/**
 * Build evaluation context from scenario
 */
function buildEvaluationContext(scenario) {
  return {
    operation: scenario.operation,
    user: scenario.user || {},
    resource: scenario.resource || {},
    context: scenario.context || {},
    // Convenience accessors
    userRole: scenario.user?.role,
    resourceType: scenario.resource?.type,
    hasPHI: scenario.resource?.containsPHI || false,
    riskLevel: scenario.context?.riskLevel || 'low',
    timestamp: new Date(),
    hour: new Date().getHours()
  };
}

/**
 * Evaluate condition against context
 */
function evaluateCondition(condition, context) {
  if (!condition || Object.keys(condition).length === 0) {
    return true; // Empty condition matches everything
  }

  const fieldValue = getNestedValue(context, condition.field);

  switch (condition.operator) {
    case 'equals':
      return fieldValue === condition.value;
    case 'not_equals':
      return fieldValue !== condition.value;
    case 'contains':
      return String(fieldValue).includes(condition.value);
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(fieldValue);
    case 'not_in':
      return Array.isArray(condition.value) && !condition.value.includes(fieldValue);
    case 'gt':
      return fieldValue > condition.value;
    case 'lt':
      return fieldValue < condition.value;
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;
    case 'regex':
      return new RegExp(condition.value).test(String(fieldValue));
    default:
      return false;
  }
}

/**
 * Get nested value from object
 */
function getNestedValue(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : undefined;
  }, obj);
}
