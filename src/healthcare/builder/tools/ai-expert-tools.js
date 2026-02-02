/**
 * AI Expert Tools for Healthcare Builder Agent
 *
 * Tools for creating and managing AI Experts with specialized prompts,
 * output contracts, knowledge packs, and escalation chains.
 */

export const aiExpertTools = [
  {
    name: 'create_ai_expert',
    description: 'Create a new AI expert with specialized prompt, output contract, and configuration.',
    input_schema: {
      type: 'object',
      properties: {
        expertType: {
          type: 'string',
          description: 'Unique identifier for the expert (e.g., cardiology_specialist, pediatric_dosing)'
        },
        displayName: {
          type: 'string',
          description: 'Human-readable name for the expert'
        },
        specialty: {
          type: 'string',
          description: 'Domain expertise area (e.g., cardiology, oncology, pediatrics)'
        },
        systemPrompt: {
          type: 'string',
          description: 'The expert\'s system prompt with domain-specific instructions'
        },
        outputContract: {
          type: 'object',
          description: 'JSON Schema defining the structured output format',
          properties: {
            type: { type: 'string' },
            properties: { type: 'object' },
            required: { type: 'array', items: { type: 'string' } }
          }
        },
        riskEscalationThreshold: {
          type: 'string',
          enum: ['critical', 'high', 'moderate', 'low'],
          description: 'Risk level at which to escalate to senior expert',
          default: 'high'
        },
        certaintyThreshold: {
          type: 'number',
          description: 'Minimum certainty level (0-1) before escalation',
          default: 0.8
        },
        knowledgePackIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of knowledge packs to assign to this expert'
        },
        escalationTarget: {
          type: 'string',
          description: 'Expert type to escalate to (e.g., physician_ai)'
        }
      },
      required: ['expertType', 'displayName', 'specialty', 'systemPrompt']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        const expertId = `expert_${Date.now()}`;

        // Build default output contract if not provided
        const outputContract = input.outputContract || {
          type: 'object',
          properties: {
            decision: { type: 'string', description: 'The expert\'s clinical decision' },
            riskLevel: { type: 'string', enum: ['critical', 'high', 'moderate', 'low'] },
            certainty: { type: 'number', minimum: 0, maximum: 1 },
            reasoning: { type: 'string', description: 'Clinical reasoning for the decision' },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string' },
                  reference: { type: 'string' },
                  relevance: { type: 'number' }
                }
              }
            },
            recommendations: {
              type: 'array',
              items: { type: 'string' }
            },
            escalationNeeded: { type: 'boolean' },
            escalationReason: { type: 'string' }
          },
          required: ['decision', 'riskLevel', 'certainty', 'reasoning']
        };

        const expert = {
          _key: expertId,
          expertType: input.expertType,
          displayName: input.displayName,
          specialty: input.specialty,
          systemPrompt: input.systemPrompt,
          outputContract,
          riskEscalationThreshold: input.riskEscalationThreshold || 'high',
          certaintyThreshold: input.certaintyThreshold || 0.8,
          knowledgePackIds: input.knowledgePackIds || [],
          escalationTarget: input.escalationTarget,
          status: 'active',
          version: 1,
          createdAt: new Date().toISOString(),
          createdBy: input._actor || 'system',
          orgId: input._orgId || input.orgId
        };

        // Store in database
        if (db) {
          const col = db.collection('ai_experts');
          const exists = await col.exists();
          if (!exists) {
            await db.createCollection('ai_experts');
          }
          await col.save(expert);
        }

        // Register with expert registry if available
        if (orchestrator.correctnessStack?.expertReviewWorkflow?.aiExpertRegistry) {
          orchestrator.correctnessStack.expertReviewWorkflow.aiExpertRegistry.registerExpert({
            type: input.expertType,
            displayName: input.displayName,
            specialty: input.specialty,
            systemPrompt: input.systemPrompt,
            outputContract,
            knowledgePacks: input.knowledgePackIds,
            riskEscalationThreshold: input.riskEscalationThreshold
          });
        }

        return {
          success: true,
          expertId,
          expertType: input.expertType,
          displayName: input.displayName,
          specialty: input.specialty,
          outputContractFields: Object.keys(outputContract.properties || {}),
          knowledgePackCount: (input.knowledgePackIds || []).length,
          message: `AI Expert '${input.displayName}' created successfully`
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'configure_expert_prompt',
    description: 'Update an AI expert\'s system prompt.',
    input_schema: {
      type: 'object',
      properties: {
        expertType: {
          type: 'string',
          description: 'The expert type identifier'
        },
        systemPrompt: {
          type: 'string',
          description: 'The new system prompt'
        },
        versionNote: {
          type: 'string',
          description: 'Note describing the change'
        }
      },
      required: ['expertType', 'systemPrompt']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          const col = db.collection('ai_experts');
          const cursor = await db.query(`
            FOR e IN ai_experts
            FILTER e.expertType == @expertType
            RETURN e
          `, { expertType: input.expertType });
          const experts = await cursor.all();

          if (experts.length === 0) {
            return { success: false, error: `Expert '${input.expertType}' not found` };
          }

          const expert = experts[0];
          const newVersion = (expert.version || 1) + 1;

          await col.update(expert._key, {
            systemPrompt: input.systemPrompt,
            version: newVersion,
            updatedAt: new Date().toISOString(),
            updatedBy: input._actor || 'system',
            versionHistory: [
              ...(expert.versionHistory || []),
              {
                version: expert.version,
                prompt: expert.systemPrompt,
                updatedAt: expert.updatedAt,
                note: input.versionNote
              }
            ]
          });

          return {
            success: true,
            expertType: input.expertType,
            newVersion,
            promptLength: input.systemPrompt.length,
            message: `Expert prompt updated to version ${newVersion}`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'assign_knowledge_packs',
    description: 'Link knowledge packs to an AI expert.',
    input_schema: {
      type: 'object',
      properties: {
        expertType: {
          type: 'string',
          description: 'The expert type identifier'
        },
        knowledgePackIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of knowledge packs to assign'
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description: 'Whether to append to existing packs or replace them',
          default: 'append'
        }
      },
      required: ['expertType', 'knowledgePackIds']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          const col = db.collection('ai_experts');
          const cursor = await db.query(`
            FOR e IN ai_experts
            FILTER e.expertType == @expertType
            RETURN e
          `, { expertType: input.expertType });
          const experts = await cursor.all();

          if (experts.length === 0) {
            return { success: false, error: `Expert '${input.expertType}' not found` };
          }

          const expert = experts[0];
          const existingPacks = expert.knowledgePackIds || [];

          let newPacks;
          if (input.mode === 'replace') {
            newPacks = input.knowledgePackIds;
          } else {
            newPacks = [...new Set([...existingPacks, ...input.knowledgePackIds])];
          }

          await col.update(expert._key, {
            knowledgePackIds: newPacks,
            updatedAt: new Date().toISOString(),
            updatedBy: input._actor || 'system'
          });

          return {
            success: true,
            expertType: input.expertType,
            previousPackCount: existingPacks.length,
            newPackCount: newPacks.length,
            addedPacks: input.knowledgePackIds.filter(p => !existingPacks.includes(p)),
            message: `Knowledge packs assigned to expert '${input.expertType}'`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'set_expert_escalation',
    description: 'Configure escalation chain for an AI expert.',
    input_schema: {
      type: 'object',
      properties: {
        expertType: {
          type: 'string',
          description: 'The expert type identifier'
        },
        escalationTarget: {
          type: 'string',
          description: 'Expert type to escalate to'
        },
        riskEscalationThreshold: {
          type: 'string',
          enum: ['critical', 'high', 'moderate', 'low'],
          description: 'Risk level at which to escalate'
        },
        certaintyThreshold: {
          type: 'number',
          description: 'Certainty level below which to escalate (0-1)'
        },
        escalationConditions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              condition: { type: 'string' },
              description: { type: 'string' }
            }
          },
          description: 'Additional conditions that trigger escalation'
        }
      },
      required: ['expertType', 'escalationTarget']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          const col = db.collection('ai_experts');
          const cursor = await db.query(`
            FOR e IN ai_experts
            FILTER e.expertType == @expertType
            RETURN e
          `, { expertType: input.expertType });
          const experts = await cursor.all();

          if (experts.length === 0) {
            return { success: false, error: `Expert '${input.expertType}' not found` };
          }

          // Verify escalation target exists
          const targetCursor = await db.query(`
            FOR e IN ai_experts
            FILTER e.expertType == @expertType
            RETURN e
          `, { expertType: input.escalationTarget });
          const targets = await targetCursor.all();

          if (targets.length === 0) {
            return {
              success: false,
              error: `Escalation target '${input.escalationTarget}' not found`
            };
          }

          const expert = experts[0];

          await col.update(expert._key, {
            escalationTarget: input.escalationTarget,
            riskEscalationThreshold: input.riskEscalationThreshold || expert.riskEscalationThreshold,
            certaintyThreshold: input.certaintyThreshold || expert.certaintyThreshold,
            escalationConditions: input.escalationConditions || [],
            updatedAt: new Date().toISOString(),
            updatedBy: input._actor || 'system'
          });

          return {
            success: true,
            expertType: input.expertType,
            escalationTarget: input.escalationTarget,
            riskThreshold: input.riskEscalationThreshold || expert.riskEscalationThreshold,
            certaintyThreshold: input.certaintyThreshold || expert.certaintyThreshold,
            conditionCount: (input.escalationConditions || []).length,
            message: `Escalation configured: ${input.expertType} -> ${input.escalationTarget}`
          };
        }

        return { success: false, error: 'Database not available' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'list_ai_experts',
    description: 'List all registered AI experts.',
    input_schema: {
      type: 'object',
      properties: {
        specialty: {
          type: 'string',
          description: 'Filter by specialty'
        },
        status: {
          type: 'string',
          enum: ['active', 'inactive', 'all'],
          description: 'Filter by status',
          default: 'active'
        },
        includePrompts: {
          type: 'boolean',
          description: 'Include full system prompts in response',
          default: false
        }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;

        if (db) {
          let query = 'FOR e IN ai_experts';
          const filters = [];
          const bindVars = {};

          if (input.status !== 'all') {
            filters.push('e.status == @status');
            bindVars.status = input.status || 'active';
          }

          if (input.specialty) {
            filters.push('e.specialty == @specialty');
            bindVars.specialty = input.specialty;
          }

          if (input._orgId) {
            filters.push('(e.orgId == @orgId OR e.orgId == null)');
            bindVars.orgId = input._orgId;
          }

          if (filters.length > 0) {
            query += ' FILTER ' + filters.join(' AND ');
          }

          query += ' RETURN e';

          const cursor = await db.query(query, bindVars);
          const experts = await cursor.all();

          return {
            success: true,
            count: experts.length,
            experts: experts.map(e => ({
              expertType: e.expertType,
              displayName: e.displayName,
              specialty: e.specialty,
              status: e.status,
              version: e.version,
              knowledgePackCount: (e.knowledgePackIds || []).length,
              escalationTarget: e.escalationTarget,
              riskThreshold: e.riskEscalationThreshold,
              createdAt: e.createdAt,
              ...(input.includePrompts ? { systemPrompt: e.systemPrompt } : {})
            }))
          };
        }

        // Return mock data if no database
        return {
          success: true,
          count: 0,
          experts: [],
          note: 'Database not available, no experts loaded'
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'test_ai_expert',
    description: 'Simulate an AI expert invocation with test input.',
    input_schema: {
      type: 'object',
      properties: {
        expertType: {
          type: 'string',
          description: 'The expert type to test'
        },
        testInput: {
          type: 'object',
          description: 'Test input data for the expert'
        },
        validateContract: {
          type: 'boolean',
          description: 'Validate output against the contract schema',
          default: true
        }
      },
      required: ['expertType', 'testInput']
    },
    handler: async (orchestrator, input) => {
      try {
        const db = orchestrator.arango?.db;
        let expert = null;

        if (db) {
          const cursor = await db.query(`
            FOR e IN ai_experts
            FILTER e.expertType == @expertType
            RETURN e
          `, { expertType: input.expertType });
          const experts = await cursor.all();

          if (experts.length === 0) {
            return { success: false, error: `Expert '${input.expertType}' not found` };
          }
          expert = experts[0];
        }

        if (!expert) {
          return { success: false, error: 'Expert not found and database not available' };
        }

        // Simulate expert invocation using LLM service
        const llmService = orchestrator.llmService;
        if (!llmService) {
          return {
            success: false,
            error: 'LLM service not available for expert simulation'
          };
        }

        const startTime = Date.now();

        // Build the user prompt from test input
        const userPrompt = `Analyze the following input and provide a structured response:

${JSON.stringify(input.testInput, null, 2)}

Respond with a JSON object following this schema:
${JSON.stringify(expert.outputContract, null, 2)}`;

        const result = await llmService.invokeLLM(
          input._orgId || 'test',
          input._actor || 'tester',
          {
            provider: 'ANTHROPIC',
            systemPrompt: expert.systemPrompt,
            userPrompt,
            temperature: 0.2,
            maxTokens: 2000,
            skipCache: true
          }
        );

        const duration = Date.now() - startTime;

        // Parse response
        let parsedResponse;
        let parseError = null;
        try {
          parsedResponse = typeof result.response === 'string'
            ? JSON.parse(result.response)
            : result.response;
        } catch (e) {
          parseError = e.message;
          parsedResponse = { rawResponse: result.response };
        }

        // Validate against contract if requested
        let contractValidation = { valid: true, errors: [] };
        if (input.validateContract && expert.outputContract && !parseError) {
          contractValidation = validateAgainstSchema(parsedResponse, expert.outputContract);
        }

        // Check escalation conditions
        const shouldEscalate = checkEscalation(parsedResponse, expert);

        return {
          success: true,
          expertType: input.expertType,
          testInput: input.testInput,
          response: parsedResponse,
          parseError,
          contractValidation,
          escalation: {
            needed: shouldEscalate.needed,
            reason: shouldEscalate.reason,
            target: shouldEscalate.needed ? expert.escalationTarget : null
          },
          performance: {
            duration,
            model: result.model
          }
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];

/**
 * Validate object against JSON Schema (simplified)
 */
function validateAgainstSchema(obj, schema) {
  const errors = [];

  if (schema.required) {
    for (const field of schema.required) {
      if (obj[field] === undefined) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (obj[key] !== undefined) {
        const value = obj[key];
        if (propSchema.type === 'string' && typeof value !== 'string') {
          errors.push(`Field '${key}' should be string, got ${typeof value}`);
        }
        if (propSchema.type === 'number' && typeof value !== 'number') {
          errors.push(`Field '${key}' should be number, got ${typeof value}`);
        }
        if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
          errors.push(`Field '${key}' should be boolean, got ${typeof value}`);
        }
        if (propSchema.type === 'array' && !Array.isArray(value)) {
          errors.push(`Field '${key}' should be array, got ${typeof value}`);
        }
        if (propSchema.enum && !propSchema.enum.includes(value)) {
          errors.push(`Field '${key}' should be one of [${propSchema.enum.join(', ')}], got '${value}'`);
        }
        if (propSchema.minimum !== undefined && value < propSchema.minimum) {
          errors.push(`Field '${key}' should be >= ${propSchema.minimum}, got ${value}`);
        }
        if (propSchema.maximum !== undefined && value > propSchema.maximum) {
          errors.push(`Field '${key}' should be <= ${propSchema.maximum}, got ${value}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if escalation is needed based on response and expert config
 */
function checkEscalation(response, expert) {
  const riskLevels = ['low', 'moderate', 'high', 'critical'];
  const responseRiskIndex = riskLevels.indexOf(response.riskLevel);
  const thresholdIndex = riskLevels.indexOf(expert.riskEscalationThreshold);

  // Check risk level
  if (responseRiskIndex >= thresholdIndex && thresholdIndex >= 0) {
    return {
      needed: true,
      reason: `Risk level '${response.riskLevel}' meets escalation threshold '${expert.riskEscalationThreshold}'`
    };
  }

  // Check certainty
  if (response.certainty !== undefined && response.certainty < expert.certaintyThreshold) {
    return {
      needed: true,
      reason: `Certainty ${response.certainty} below threshold ${expert.certaintyThreshold}`
    };
  }

  // Check explicit escalation flag
  if (response.escalationNeeded) {
    return {
      needed: true,
      reason: response.escalationReason || 'Expert requested escalation'
    };
  }

  return { needed: false, reason: null };
}
