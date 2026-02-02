/**
 * Recipe Tools for Healthcare Builder Agent
 *
 * Tools for creating and managing healthcare recipes with
 * correctness integration, assertions, and AI expert triggers.
 */

export const recipeTools = [
  {
    name: 'create_healthcare_recipe',
    description: 'Create a new healthcare recipe with correctness integration.',
    input_schema: {
      type: 'object',
      properties: {
        recipeName: {
          type: 'string',
          description: 'Unique name for the recipe'
        },
        displayName: {
          type: 'string',
          description: 'Human-readable name'
        },
        description: {
          type: 'string',
          description: 'Recipe description'
        },
        taskType: {
          type: 'string',
          description: 'Type of task this recipe handles (e.g., drug_interaction_check)'
        },
        inputContract: {
          type: 'object',
          description: 'JSON Schema for input validation',
          properties: {
            type: { type: 'string' },
            properties: { type: 'object' },
            required: { type: 'array', items: { type: 'string' } }
          }
        },
        outputContract: {
          type: 'object',
          description: 'JSON Schema for output validation'
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: {
                type: 'string',
                enum: ['query', 'transform', 'validate', 'analyze', 'aggregate', 'llm.analyze', 'llm.recommend', 'llm.classify']
              },
              config: { type: 'object' }
            }
          },
          description: 'Recipe steps'
        },
        assertions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assertion type IDs to run on output'
        },
        expertReviewTrigger: {
          type: 'object',
          properties: {
            expertType: { type: 'string' },
            conditions: { type: 'array', items: { type: 'object' } }
          },
          description: 'When to trigger AI expert review'
        },
        phiHandling: {
          type: 'string',
          enum: ['none', 'detect', 'mask', 'encrypt'],
          description: 'How to handle PHI in this recipe',
          default: 'detect'
        },
        auditLevel: {
          type: 'string',
          enum: ['none', 'basic', 'detailed', 'full'],
          description: 'Audit logging level',
          default: 'detailed'
        }
      },
      required: ['recipeName', 'displayName', 'taskType']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        const recipe = {
          _key: input.recipeName,
          recipeName: input.recipeName,
          displayName: input.displayName,
          description: input.description,
          taskType: input.taskType,
          inputContract: input.inputContract || { type: 'object', properties: {} },
          outputContract: input.outputContract || { type: 'object', properties: {} },
          steps: input.steps || [],
          assertions: input.assertions || [],
          expertReviewTrigger: input.expertReviewTrigger,
          phiHandling: input.phiHandling || 'detect',
          auditLevel: input.auditLevel || 'detailed',
          version: 1,
          status: 'draft',
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        if (db) {
          const col = db.collection('healthcare_recipes');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('healthcare_recipes');
          }
          await col.save(recipe);
        }

        return {
          success: true,
          recipeName: input.recipeName,
          displayName: input.displayName,
          taskType: input.taskType,
          stepCount: (input.steps || []).length,
          assertionCount: (input.assertions || []).length,
          hasExpertReview: !!input.expertReviewTrigger,
          status: 'draft',
          message: `Recipe '${input.displayName}' created. Add steps and assertions, then validate.`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'add_recipe_step',
    description: 'Add a step to an existing recipe.',
    input_schema: {
      type: 'object',
      properties: {
        recipeName: {
          type: 'string',
          description: 'Recipe to add step to'
        },
        stepName: {
          type: 'string',
          description: 'Name for this step'
        },
        stepType: {
          type: 'string',
          enum: ['query', 'transform', 'validate', 'analyze', 'aggregate', 'llm.analyze', 'llm.recommend', 'llm.classify'],
          description: 'Type of step'
        },
        position: {
          type: 'number',
          description: 'Position to insert (0-indexed, -1 for end)',
          default: -1
        },
        config: {
          type: 'object',
          description: 'Step configuration',
          properties: {
            input: { type: 'string', description: 'Input reference (e.g., $previousOutput)' },
            outputKey: { type: 'string', description: 'Key for step output' },
            query: { type: 'string', description: 'For query steps: the query' },
            operations: { type: 'array', description: 'For transform steps: operations' },
            rules: { type: 'array', description: 'For validate steps: validation rules' },
            analyzeFields: { type: 'array', description: 'For analyze steps: fields to analyze' },
            systemPrompt: { type: 'string', description: 'For LLM steps: system prompt' },
            userPrompt: { type: 'string', description: 'For LLM steps: user prompt template' },
            schema: { type: 'string', description: 'For LLM steps: output schema name' },
            temperature: { type: 'number', description: 'For LLM steps: temperature' }
          }
        },
        condition: {
          type: 'object',
          description: 'Condition to execute this step (optional)'
        },
        continueOnError: {
          type: 'boolean',
          description: 'Continue recipe if this step fails',
          default: false
        }
      },
      required: ['recipeName', 'stepName', 'stepType', 'config']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          const col = db.collection('healthcare_recipes');
          const cursor = await db.query(`
            FOR r IN healthcare_recipes
            FILTER r.recipeName == @name
            RETURN r
          `, { name: input.recipeName });
          const recipes = await cursor.all();

          if (recipes.length === 0) {
            return { success: false, error: `Recipe '${input.recipeName}' not found` };
          }

          const recipe = recipes[0];
          const steps = [...(recipe.steps || [])];

          const newStep = {
            name: input.stepName,
            type: input.stepType,
            ...input.config,
            condition: input.condition,
            continueOnError: input.continueOnError
          };

          if (input.position === -1 || input.position >= steps.length) {
            steps.push(newStep);
          } else {
            steps.splice(input.position, 0, newStep);
          }

          await col.update(recipe._key, {
            steps,
            updatedAt: new Date().toISOString(),
            updatedBy: input._actor || 'system'
          });

          return {
            success: true,
            recipeName: input.recipeName,
            stepName: input.stepName,
            stepType: input.stepType,
            position: input.position === -1 ? steps.length - 1 : input.position,
            totalSteps: steps.length,
            message: `Step '${input.stepName}' added to recipe`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'add_correctness_assertions',
    description: 'Add correctness assertions to a recipe.',
    input_schema: {
      type: 'object',
      properties: {
        recipeName: {
          type: 'string',
          description: 'Recipe to add assertions to'
        },
        assertionTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assertion type IDs to add'
        },
        runOn: {
          type: 'string',
          enum: ['output', 'each_step', 'final_only'],
          description: 'When to run assertions',
          default: 'output'
        },
        failureAction: {
          type: 'string',
          enum: ['fail', 'warn', 'escalate'],
          description: 'What to do when assertion fails',
          default: 'fail'
        }
      },
      required: ['recipeName', 'assertionTypes']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          // Verify assertions exist
          const assertionCursor = await db.query(`
            FOR a IN assertion_types
            FILTER a.assertionType IN @types
            RETURN a.assertionType
          `, { types: input.assertionTypes });
          const foundAssertions = await assertionCursor.all();

          const missingAssertions = input.assertionTypes.filter(t => !foundAssertions.includes(t));
          if (missingAssertions.length > 0) {
            return {
              success: false,
              error: `Assertion types not found: ${missingAssertions.join(', ')}`
            };
          }

          const col = db.collection('healthcare_recipes');
          const cursor = await db.query(`
            FOR r IN healthcare_recipes
            FILTER r.recipeName == @name
            RETURN r
          `, { name: input.recipeName });
          const recipes = await cursor.all();

          if (recipes.length === 0) {
            return { success: false, error: `Recipe '${input.recipeName}' not found` };
          }

          const recipe = recipes[0];
          const existingAssertions = new Set(recipe.assertions || []);
          const newAssertions = [...existingAssertions, ...input.assertionTypes.filter(t => !existingAssertions.has(t))];

          await col.update(recipe._key, {
            assertions: newAssertions,
            assertionConfig: {
              runOn: input.runOn || 'output',
              failureAction: input.failureAction || 'fail'
            },
            updatedAt: new Date().toISOString()
          });

          return {
            success: true,
            recipeName: input.recipeName,
            assertionsAdded: input.assertionTypes.length,
            totalAssertions: newAssertions.length,
            runOn: input.runOn || 'output',
            failureAction: input.failureAction || 'fail',
            message: `${input.assertionTypes.length} assertions added to recipe`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'validate_recipe',
    description: 'Validate recipe structure and dependencies.',
    input_schema: {
      type: 'object',
      properties: {
        recipeName: {
          type: 'string',
          description: 'Recipe to validate'
        },
        checkDependencies: {
          type: 'boolean',
          description: 'Check that all referenced assertions, experts exist',
          default: true
        },
        checkContracts: {
          type: 'boolean',
          description: 'Validate input/output contracts',
          default: true
        }
      },
      required: ['recipeName']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        const issues = [];
        const warnings = [];

        if (db) {
          const cursor = await db.query(`
            FOR r IN healthcare_recipes
            FILTER r.recipeName == @name
            RETURN r
          `, { name: input.recipeName });
          const recipes = await cursor.all();

          if (recipes.length === 0) {
            return { success: false, error: `Recipe '${input.recipeName}' not found` };
          }

          const recipe = recipes[0];

          // Check basic structure
          if (!recipe.steps || recipe.steps.length === 0) {
            issues.push('Recipe has no steps defined');
          }

          if (!recipe.taskType) {
            warnings.push('Recipe has no taskType defined');
          }

          // Validate steps
          const validStepTypes = ['query', 'transform', 'validate', 'analyze', 'aggregate', 'llm.analyze', 'llm.recommend', 'llm.classify'];
          for (let i = 0; i < (recipe.steps || []).length; i++) {
            const step = recipe.steps[i];

            if (!step.name) {
              issues.push(`Step ${i} has no name`);
            }

            if (!validStepTypes.includes(step.type)) {
              issues.push(`Step '${step.name}': Invalid type '${step.type}'`);
            }

            // Check LLM steps have required config
            if (step.type?.startsWith('llm.')) {
              if (!step.systemPrompt && !step.userPrompt) {
                warnings.push(`Step '${step.name}': LLM step should have systemPrompt or userPrompt`);
              }
            }

            // Check query steps have query
            if (step.type === 'query' && !step.query) {
              issues.push(`Step '${step.name}': Query step missing 'query' property`);
            }
          }

          // Check dependencies
          if (input.checkDependencies) {
            // Check assertions exist
            if (recipe.assertions?.length) {
              const assertionCursor = await db.query(`
                FOR a IN assertion_types
                FILTER a.assertionType IN @types
                RETURN a.assertionType
              `, { types: recipe.assertions });
              const foundAssertions = await assertionCursor.all();

              const missingAssertions = recipe.assertions.filter(t => !foundAssertions.includes(t));
              for (const missing of missingAssertions) {
                issues.push(`Referenced assertion '${missing}' not found`);
              }
            }

            // Check expert exists
            if (recipe.expertReviewTrigger?.expertType) {
              const expertCursor = await db.query(`
                FOR e IN ai_experts
                FILTER e.expertType == @type
                RETURN e.expertType
              `, { type: recipe.expertReviewTrigger.expertType });
              const foundExperts = await expertCursor.all();

              if (foundExperts.length === 0) {
                issues.push(`Referenced expert '${recipe.expertReviewTrigger.expertType}' not found`);
              }
            }
          }

          // Check contracts
          if (input.checkContracts) {
            if (!recipe.inputContract?.properties || Object.keys(recipe.inputContract.properties).length === 0) {
              warnings.push('Input contract has no properties defined');
            }

            if (!recipe.outputContract?.properties || Object.keys(recipe.outputContract.properties).length === 0) {
              warnings.push('Output contract has no properties defined');
            }
          }

          // Check PHI handling for healthcare
          if (recipe.phiHandling === 'none') {
            warnings.push('PHI handling is disabled - ensure recipe does not process PHI');
          }

          const isValid = issues.length === 0;

          // Update recipe status if valid
          if (isValid && recipe.status === 'draft') {
            const col = db.collection('healthcare_recipes');
            await col.update(recipe._key, {
              status: 'validated',
              validatedAt: new Date().toISOString()
            });
          }

          return {
            success: true,
            recipeName: input.recipeName,
            valid: isValid,
            status: isValid ? 'validated' : 'invalid',
            issues,
            warnings,
            summary: {
              stepCount: (recipe.steps || []).length,
              assertionCount: (recipe.assertions || []).length,
              hasExpertReview: !!recipe.expertReviewTrigger,
              phiHandling: recipe.phiHandling
            }
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'test_recipe',
    description: 'Execute recipe with sample data.',
    input_schema: {
      type: 'object',
      properties: {
        recipeName: {
          type: 'string',
          description: 'Recipe to test'
        },
        testInput: {
          type: 'object',
          description: 'Test input data',
          additionalProperties: true
        },
        runAssertions: {
          type: 'boolean',
          description: 'Run correctness assertions on output',
          default: true
        },
        dryRun: {
          type: 'boolean',
          description: 'Simulate execution without LLM calls',
          default: false
        }
      },
      required: ['recipeName', 'testInput']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          const cursor = await db.query(`
            FOR r IN healthcare_recipes
            FILTER r.recipeName == @name
            RETURN r
          `, { name: input.recipeName });
          const recipes = await cursor.all();

          if (recipes.length === 0) {
            return { success: false, error: `Recipe '${input.recipeName}' not found` };
          }

          const recipe = recipes[0];

          // Validate input against contract
          const inputValidation = validateAgainstContract(input.testInput, recipe.inputContract);
          if (!inputValidation.valid) {
            return {
              success: false,
              error: 'Input validation failed',
              validationErrors: inputValidation.errors
            };
          }

          // Execute recipe using RecipeEngine if available
          const recipeEngine = orchestrator.recipeEngine;
          if (recipeEngine && !input.dryRun) {
            const execution = await recipeEngine.execute(recipe, {
              ...input.testInput,
              _testMode: true
            });

            // Run assertions if requested
            let assertionResults = null;
            if (input.runAssertions && recipe.assertions?.length && execution.status === 'completed') {
              assertionResults = await runRecipeAssertions(orchestrator, recipe.assertions, execution.outputs);
            }

            return {
              success: execution.status === 'completed',
              recipeName: input.recipeName,
              executionId: execution.id,
              status: execution.status,
              duration: execution.duration,
              stepsExecuted: execution.steps?.length || 0,
              outputs: execution.outputs,
              errors: execution.errors,
              assertions: assertionResults
            };
          }

          // Dry run - simulate execution
          const simulatedSteps = [];
          for (const step of recipe.steps || []) {
            simulatedSteps.push({
              name: step.name,
              type: step.type,
              status: 'simulated',
              outputKey: step.outputKey
            });
          }

          return {
            success: true,
            recipeName: input.recipeName,
            dryRun: true,
            inputValid: true,
            simulatedSteps,
            stepCount: simulatedSteps.length,
            assertions: recipe.assertions,
            message: 'Dry run completed - no actual execution'
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'list_recipes',
    description: 'List all healthcare recipes.',
    input_schema: {
      type: 'object',
      properties: {
        taskType: {
          type: 'string',
          description: 'Filter by task type'
        },
        status: {
          type: 'string',
          enum: ['draft', 'validated', 'active', 'deprecated', 'all'],
          description: 'Filter by status',
          default: 'all'
        },
        includeSteps: {
          type: 'boolean',
          description: 'Include step details',
          default: false
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          let query = 'FOR r IN healthcare_recipes';
          const filters = [];
          const bindVars = {};

          if (input.status !== 'all') {
            filters.push('r.status == @status');
            bindVars.status = input.status;
          }

          if (input.taskType) {
            filters.push('r.taskType == @taskType');
            bindVars.taskType = input.taskType;
          }

          if (filters.length > 0) {
            query += ' FILTER ' + filters.join(' AND ');
          }

          query += ' RETURN r';

          const cursor = await db.query(query, bindVars);
          const recipes = await cursor.all();

          return {
            success: true,
            count: recipes.length,
            recipes: recipes.map(r => ({
              recipeName: r.recipeName,
              displayName: r.displayName,
              description: r.description,
              taskType: r.taskType,
              status: r.status,
              version: r.version,
              stepCount: (r.steps || []).length,
              assertionCount: (r.assertions || []).length,
              hasExpertReview: !!r.expertReviewTrigger,
              phiHandling: r.phiHandling,
              createdAt: r.createdAt,
              ...(input.includeSteps ? {
                steps: r.steps?.map(s => ({ name: s.name, type: s.type })),
                assertions: r.assertions
              } : {})
            }))
          };
        }

        return {
          success: true,
          count: 0,
          recipes: [],
          note: 'Database not available'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];

/**
 * Validate data against JSON Schema contract
 */
function validateAgainstContract(data, contract) {
  const errors = [];

  if (!contract || !contract.properties) {
    return { valid: true, errors };
  }

  // Check required fields
  if (contract.required) {
    for (const field of contract.required) {
      if (data[field] === undefined) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Check property types
  for (const [key, schema] of Object.entries(contract.properties)) {
    if (data[key] !== undefined) {
      const value = data[key];
      if (schema.type === 'string' && typeof value !== 'string') {
        errors.push(`Field '${key}' should be string`);
      }
      if (schema.type === 'number' && typeof value !== 'number') {
        errors.push(`Field '${key}' should be number`);
      }
      if (schema.type === 'boolean' && typeof value !== 'boolean') {
        errors.push(`Field '${key}' should be boolean`);
      }
      if (schema.type === 'array' && !Array.isArray(value)) {
        errors.push(`Field '${key}' should be array`);
      }
      if (schema.type === 'object' && (typeof value !== 'object' || value === null)) {
        errors.push(`Field '${key}' should be object`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Run assertions on recipe output
 */
async function runRecipeAssertions(orchestrator, assertionTypes, outputs) {
  const db = orchestrator.arango?.db;
  if (!db) return null;

  const results = [];

  for (const assertionType of assertionTypes) {
    const ruleCursor = await db.query(`
      FOR r IN assertion_rules
      FILTER r.assertionType == @type AND r.enabled == true
      RETURN r
    `, { type: assertionType });
    const rules = await ruleCursor.all();

    for (const rule of rules) {
      const passed = evaluateRule(rule, outputs);
      results.push({
        assertionType,
        ruleId: rule.ruleId,
        ruleName: rule.name,
        passed,
        severity: rule.severity
      });
    }
  }

  return {
    total: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    results
  };
}

/**
 * Evaluate a single assertion rule
 */
function evaluateRule(rule, data) {
  const { condition } = rule;
  const fieldValue = getNestedValue(data, condition.field);

  switch (condition.operator) {
    case 'equals': return fieldValue === condition.value;
    case 'not_equals': return fieldValue !== condition.value;
    case 'contains': return String(fieldValue).includes(condition.value);
    case 'in': return condition.value.includes(fieldValue);
    case 'exists': return fieldValue !== undefined && fieldValue !== null;
    default: return true;
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
