/**
 * Assertion Tools for Healthcare Builder Agent
 *
 * Tools for creating and managing assertions that validate
 * AI expert outputs and recipe results for correctness.
 */

export const assertionTools = [
  {
    name: 'create_assertion_type',
    description: 'Define a new type of assertion for correctness checking.',
    input_schema: {
      type: 'object',
      properties: {
        assertionType: {
          type: 'string',
          description: 'Unique identifier for the assertion type (e.g., drug_interaction_check)'
        },
        name: {
          type: 'string',
          description: 'Human-readable name'
        },
        category: {
          type: 'string',
          enum: ['clinical', 'compliance', 'format', 'reference', 'consistency', 'custom'],
          description: 'Category of assertion'
        },
        description: {
          type: 'string',
          description: 'Description of what this assertion validates'
        },
        severity: {
          type: 'string',
          enum: ['critical', 'error', 'warning', 'info'],
          description: 'Severity level when assertion fails',
          default: 'error'
        },
        groundTruthSources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ground truth sources to validate against'
        },
        evaluationLogic: {
          type: 'string',
          enum: ['exact_match', 'contains', 'range_check', 'regex', 'custom_function', 'llm_evaluation'],
          description: 'How to evaluate the assertion'
        },
        parameters: {
          type: 'object',
          description: 'Parameters for the evaluation logic',
          additionalProperties: true
        }
      },
      required: ['assertionType', 'name', 'category', 'evaluationLogic']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const assertionType = {
          _key: input.assertionType,
          assertionType: input.assertionType,
          name: input.name,
          category: input.category,
          description: input.description,
          severity: input.severity || 'error',
          groundTruthSources: input.groundTruthSources || [],
          evaluationLogic: input.evaluationLogic,
          parameters: input.parameters || {},
          status: 'active',
          ruleCount: 0,
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          const col = db.collection('assertion_types');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('assertion_types');
          }
          await col.save(assertionType);
        }

        return {
          success: true,
          assertionType: input.assertionType,
          name: input.name,
          category: input.category,
          severity: input.severity || 'error',
          evaluationLogic: input.evaluationLogic,
          message: `Assertion type '${input.name}' created successfully`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'create_assertion_rule',
    description: 'Create a specific assertion rule within an assertion type.',
    input_schema: {
      type: 'object',
      properties: {
        ruleId: {
          type: 'string',
          description: 'Unique identifier for this rule'
        },
        assertionType: {
          type: 'string',
          description: 'The assertion type this rule belongs to'
        },
        name: {
          type: 'string',
          description: 'Rule name'
        },
        description: {
          type: 'string',
          description: 'What this rule checks'
        },
        condition: {
          type: 'object',
          description: 'Condition that triggers this rule',
          properties: {
            field: { type: 'string', description: 'Field to check' },
            operator: {
              type: 'string',
              enum: ['equals', 'not_equals', 'contains', 'in', 'not_in', 'gt', 'lt', 'gte', 'lte', 'regex', 'exists']
            },
            value: { description: 'Expected value or pattern' },
            groundTruthLookup: {
              type: 'object',
              properties: {
                sourceId: { type: 'string' },
                lookupField: { type: 'string' },
                compareField: { type: 'string' }
              }
            }
          }
        },
        errorMessage: {
          type: 'string',
          description: 'Message to display when assertion fails'
        },
        severity: {
          type: 'string',
          enum: ['critical', 'error', 'warning', 'info'],
          description: 'Override severity for this specific rule'
        },
        enabled: {
          type: 'boolean',
          description: 'Whether this rule is active',
          default: true
        }
      },
      required: ['ruleId', 'assertionType', 'name', 'condition']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const rule = {
          _key: input.ruleId,
          ruleId: input.ruleId,
          assertionType: input.assertionType,
          name: input.name,
          description: input.description,
          condition: input.condition,
          errorMessage: input.errorMessage || `Assertion '${input.name}' failed`,
          severity: input.severity,
          enabled: input.enabled !== false,
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          // Verify assertion type exists
          const typeCursor = await db.query(`
            FOR t IN assertion_types
            FILTER t.assertionType == @type
            RETURN t
          `, { type: input.assertionType });
          const types = await typeCursor.all();

          if (types.length === 0) {
            return { success: false, error: `Assertion type '${input.assertionType}' not found` };
          }

          // Save rule
          const col = db.collection('assertion_rules');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('assertion_rules');
          }
          await col.save(rule);

          // Update rule count
          const typeCol = db.collection('assertion_types');
          await typeCol.update(types[0]._key, {
            ruleCount: (types[0].ruleCount || 0) + 1,
            updatedAt: new Date().toISOString()
          });
        }

        return {
          success: true,
          ruleId: input.ruleId,
          assertionType: input.assertionType,
          name: input.name,
          condition: input.condition,
          message: `Assertion rule '${input.name}' created`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'test_assertion',
    description: 'Run an assertion against sample data.',
    input_schema: {
      type: 'object',
      properties: {
        assertionType: {
          type: 'string',
          description: 'Assertion type to test'
        },
        ruleId: {
          type: 'string',
          description: 'Specific rule to test (optional, tests all if not specified)'
        },
        testData: {
          type: 'object',
          description: 'Data to test against',
          additionalProperties: true
        },
        context: {
          type: 'object',
          description: 'Additional context for evaluation'
        }
      },
      required: ['assertionType', 'testData']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        let rules = [];

        if (db) {
          let query = `
            FOR r IN assertion_rules
            FILTER r.assertionType == @type AND r.enabled == true
          `;
          const bindVars = { type: input.assertionType };

          if (input.ruleId) {
            query += ' FILTER r.ruleId == @ruleId';
            bindVars.ruleId = input.ruleId;
          }

          query += ' RETURN r';

          const cursor = await db.query(query, bindVars);
          rules = await cursor.all();
        }

        if (rules.length === 0) {
          return {
            success: true,
            assertionType: input.assertionType,
            passed: true,
            rulesEvaluated: 0,
            message: 'No rules found to evaluate'
          };
        }

        // Evaluate each rule
        const results = [];
        let allPassed = true;

        for (const rule of rules) {
          const result = evaluateRule(rule, input.testData, input.context);
          results.push({
            ruleId: rule.ruleId,
            ruleName: rule.name,
            passed: result.passed,
            severity: rule.severity,
            message: result.passed ? 'Passed' : (result.message || rule.errorMessage)
          });

          if (!result.passed && (rule.severity === 'critical' || rule.severity === 'error')) {
            allPassed = false;
          }
        }

        return {
          success: true,
          assertionType: input.assertionType,
          testData: input.testData,
          passed: allPassed,
          rulesEvaluated: rules.length,
          rulesPassed: results.filter(r => r.passed).length,
          rulesFailed: results.filter(r => !r.passed).length,
          results,
          criticalFailures: results.filter(r => !r.passed && r.severity === 'critical'),
          errors: results.filter(r => !r.passed && r.severity === 'error'),
          warnings: results.filter(r => !r.passed && r.severity === 'warning')
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'list_assertions',
    description: 'List all assertion types and their rules.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category'
        },
        includeRules: {
          type: 'boolean',
          description: 'Include rule details',
          default: false
        },
        enabledOnly: {
          type: 'boolean',
          description: 'Only show enabled rules',
          default: true
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          let typeQuery = 'FOR t IN assertion_types';
          const typeBindVars = {};

          if (input.category) {
            typeQuery += ' FILTER t.category == @category';
            typeBindVars.category = input.category;
          }

          typeQuery += ' RETURN t';

          const typeCursor = await db.query(typeQuery, typeBindVars);
          const types = await typeCursor.all();

          let assertions = [];

          for (const type of types) {
            const assertion = {
              assertionType: type.assertionType,
              name: type.name,
              category: type.category,
              description: type.description,
              severity: type.severity,
              evaluationLogic: type.evaluationLogic,
              ruleCount: type.ruleCount || 0,
              groundTruthSources: type.groundTruthSources
            };

            if (input.includeRules) {
              let ruleQuery = `
                FOR r IN assertion_rules
                FILTER r.assertionType == @type
              `;
              const ruleBindVars = { type: type.assertionType };

              if (input.enabledOnly) {
                ruleQuery += ' FILTER r.enabled == true';
              }

              ruleQuery += ' RETURN r';

              const ruleCursor = await db.query(ruleQuery, ruleBindVars);
              const rules = await ruleCursor.all();

              assertion.rules = rules.map(r => ({
                ruleId: r.ruleId,
                name: r.name,
                description: r.description,
                condition: r.condition,
                severity: r.severity,
                enabled: r.enabled
              }));
            }

            assertions.push(assertion);
          }

          return {
            success: true,
            count: assertions.length,
            assertions
          };
        }

        return {
          success: true,
          count: 0,
          assertions: [],
          note: 'Database not available'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'analyze_assertion_coverage',
    description: 'Analyze assertion coverage and identify gaps.',
    input_schema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['ai_expert', 'recipe', 'workflow'],
          description: 'Type of target to analyze coverage for'
        },
        targetId: {
          type: 'string',
          description: 'Specific target ID (expert type, recipe name)'
        },
        includeRecommendations: {
          type: 'boolean',
          description: 'Include recommendations for missing assertions',
          default: true
        }
      },
      required: ['targetType']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        // Get all assertion types grouped by category
        let assertionsByCategory = {};
        let totalAssertions = 0;

        if (db) {
          const cursor = await db.query(`
            FOR t IN assertion_types
            COLLECT category = t.category INTO types
            RETURN { category, types: types[*].t }
          `);
          const categories = await cursor.all();

          for (const cat of categories) {
            assertionsByCategory[cat.category] = cat.types;
            totalAssertions += cat.types.length;
          }
        }

        // Analyze coverage based on target type
        const coverage = {
          clinical: { required: [], covered: [], missing: [] },
          compliance: { required: [], covered: [], missing: [] },
          format: { required: [], covered: [], missing: [] },
          reference: { required: [], covered: [], missing: [] },
          consistency: { required: [], covered: [], missing: [] }
        };

        // Define required assertions by target type
        const requiredAssertions = {
          ai_expert: ['clinical', 'format', 'reference'],
          recipe: ['clinical', 'compliance', 'format', 'consistency'],
          workflow: ['compliance', 'format', 'consistency']
        };

        const required = requiredAssertions[input.targetType] || [];

        for (const category of required) {
          coverage[category].required = getRequiredAssertionsForCategory(category, input.targetType);
          coverage[category].covered = (assertionsByCategory[category] || []).map(a => a.assertionType);
          coverage[category].missing = coverage[category].required.filter(
            r => !coverage[category].covered.some(c => c.includes(r))
          );
        }

        // Calculate coverage percentage
        const totalRequired = Object.values(coverage).reduce((sum, c) => sum + c.required.length, 0);
        const totalCovered = Object.values(coverage).reduce((sum, c) => sum + c.covered.length, 0);
        const coveragePercent = totalRequired > 0 ? Math.round((totalCovered / totalRequired) * 100) : 100;

        // Generate recommendations
        let recommendations = [];
        if (input.includeRecommendations) {
          for (const [category, data] of Object.entries(coverage)) {
            for (const missing of data.missing) {
              recommendations.push({
                category,
                assertionType: missing,
                recommendation: `Create ${missing} assertion for ${input.targetType} ${category} validation`,
                priority: category === 'clinical' ? 'high' : 'medium'
              });
            }
          }
        }

        return {
          success: true,
          targetType: input.targetType,
          targetId: input.targetId,
          coveragePercent,
          totalAssertions,
          coverage,
          recommendations,
          summary: {
            wellCovered: Object.entries(coverage)
              .filter(([_, c]) => c.missing.length === 0 && c.required.length > 0)
              .map(([cat]) => cat),
            needsAttention: Object.entries(coverage)
              .filter(([_, c]) => c.missing.length > 0)
              .map(([cat]) => cat)
          }
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];

/**
 * Evaluate a single rule against data
 */
function evaluateRule(rule, data, context) {
  const { condition } = rule;
  const fieldValue = getNestedValue(data, condition.field);

  switch (condition.operator) {
    case 'equals':
      return { passed: fieldValue === condition.value };
    case 'not_equals':
      return { passed: fieldValue !== condition.value };
    case 'contains':
      return { passed: String(fieldValue).includes(condition.value) };
    case 'in':
      return { passed: condition.value.includes(fieldValue) };
    case 'not_in':
      return { passed: !condition.value.includes(fieldValue) };
    case 'gt':
      return { passed: fieldValue > condition.value };
    case 'lt':
      return { passed: fieldValue < condition.value };
    case 'gte':
      return { passed: fieldValue >= condition.value };
    case 'lte':
      return { passed: fieldValue <= condition.value };
    case 'regex':
      return { passed: new RegExp(condition.value).test(fieldValue) };
    case 'exists':
      return { passed: fieldValue !== undefined && fieldValue !== null };
    default:
      return { passed: false, message: `Unknown operator: ${condition.operator}` };
  }
}

/**
 * Get nested value from object
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : undefined;
  }, obj);
}

/**
 * Get required assertions for a category
 */
function getRequiredAssertionsForCategory(category, targetType) {
  const requirements = {
    clinical: {
      ai_expert: ['drug_interaction_check', 'dosage_validation', 'contraindication_check'],
      recipe: ['phi_detection', 'clinical_terminology', 'evidence_requirement'],
      workflow: []
    },
    compliance: {
      ai_expert: [],
      recipe: ['hipaa_phi_handling', 'audit_trail', 'consent_verification'],
      workflow: ['hipaa_phi_handling', 'access_control', 'audit_logging']
    },
    format: {
      ai_expert: ['output_contract_validation', 'certainty_range', 'risk_level_valid'],
      recipe: ['input_schema_validation', 'output_schema_validation'],
      workflow: ['step_validation', 'transition_validation']
    },
    reference: {
      ai_expert: ['icd_code_validation', 'snomed_validation', 'rxnorm_validation'],
      recipe: [],
      workflow: []
    },
    consistency: {
      ai_expert: [],
      recipe: ['step_dependency', 'variable_scope'],
      workflow: ['state_consistency', 'transition_validity']
    }
  };

  return requirements[category]?.[targetType] || [];
}
