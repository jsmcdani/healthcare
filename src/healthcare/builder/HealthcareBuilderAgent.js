/**
 * Healthcare Builder Agent
 *
 * Autonomous AI agent for building healthcare platform components:
 * - AI Experts with specialized prompts and knowledge packs
 * - Knowledge packs with clinical guidelines and data
 * - Ground truth sources for clinical validation
 * - Assertions for correctness checking
 * - Calibration test cases with gold-standard answers
 * - Healthcare recipes with correctness integration
 * - Policy rules for compliance
 *
 * Pattern: Follows ServiceBuilderAgent and HealthcareAdminAgent patterns
 */

import { AnthropicPool } from '../../admin/AnthropicPool.js';
import { AuditLogger } from '../../admin/storage/AuditLogger.js';
import {
  canUseTool,
  getToolsForRole,
  sanitizeForRole,
  scopeInputForRole
} from '../../admin/rbac-config.js';
import { Logger } from '../../utils/logger.js';

// Builder-specific role definitions
const BUILDER_ROLES = {
  platform_admin: {
    description: 'Full access to all builder tools',
    canAccess: () => true
  },
  healthcare_admin: {
    description: 'Can manage AI experts, knowledge packs, policies',
    canAccess: (tool) => !tool.startsWith('ground_truth') || tool === 'list_ground_truth_sources'
  },
  healthcare_builder: {
    description: 'Can build recipes, assertions, calibration tests',
    canAccess: (tool) => [
      'create_healthcare_recipe', 'add_recipe_step', 'add_correctness_assertions',
      'validate_recipe', 'test_recipe', 'list_recipes',
      'create_assertion_type', 'create_assertion_rule', 'test_assertion', 'list_assertions',
      'create_test_case', 'create_test_suite', 'run_calibration', 'analyze_calibration_results',
      'list_ai_experts', 'test_ai_expert', 'list_knowledge_packs', 'query_knowledge',
      'list_ground_truth_sources', 'test_source_query',
      'run_correctness_tests', 'validate_expert_output', 'test_end_to_end', 'generate_test_report',
      'check_routable_description', 'gate_routable', 'audit_routing_catalog'
    ].includes(tool)
  },
  developer: {
    description: 'Testing and validation only',
    canAccess: (tool) => [
      'test_ai_expert', 'test_assertion', 'test_recipe', 'test_policy', 'test_source_query',
      'run_correctness_tests', 'validate_expert_output', 'test_end_to_end', 'generate_test_report',
      'list_ai_experts', 'list_knowledge_packs', 'list_recipes', 'list_policies', 'list_assertions',
      'check_routable_description', 'audit_routing_catalog'
    ].includes(tool)
  }
};

export class HealthcareBuilderAgent {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.logger = orchestrator?.logger || new Logger('HealthcareBuilderAgent');

    // Initialize Anthropic pool for rate-limited requests
    this.pool = new AnthropicPool({
      maxRequestsPerMinute: 40,
      maxConcurrent: 3,
      maxRetries: 3
    });

    // Storage and audit
    this.auditLogger = null;

    // Conversation management
    this.activeConversations = new Map();
    this.currentUser = null;

    // System prompt loaded at initialization
    this.systemPrompt = null;

    // Tool registry
    this.allTools = [];
  }

  async initialize() {
    this.logger.info('Building Healthcare Builder Agent...');

    try {
      // Initialize audit logging
      if (this.orchestrator.arango?.db) {
        this.auditLogger = new AuditLogger(
          this.orchestrator.arango.db,
          this.logger
        );
        await this.auditLogger.initialize();
      }

      // Load system prompt
      this.systemPrompt = await this.loadSystemPrompt();

      // Connect Redis for LLM response caching
      if (this.orchestrator?.redisClient) {
        this.pool.setRedisClient(this.orchestrator.redisClient);
      }

      // Pre-load all tools
      this.allTools = await this.loadTools();

      // Register on orchestrator
      if (this.orchestrator) {
        this.orchestrator.healthcareBuilderAgent = this;
      }

      this.logger.info('Healthcare Builder Agent initialized successfully');

      return {
        success: true,
        toolCount: this.allTools.length,
        status: 'initialized'
      };

    } catch (error) {
      this.logger.error('Healthcare Builder Agent initialization failed:', error);
      throw error;
    }
  }

  /**
   * Process builder command from any interface
   */
  async processCommand(userMessage, context = {}) {
    const conversationId = context.conversationId || this.generateConversationId();
    this.currentUser = context.userId || context.actor || 'builder';
    const userRole = context.role || 'developer';

    try {
      // Get or create conversation
      let conversation = this.activeConversations.get(conversationId);
      if (!conversation) {
        conversation = {
          id: conversationId,
          messages: [],
          createdAt: new Date().toISOString(),
          userId: this.currentUser,
          role: userRole,
          context: context
        };
        this.activeConversations.set(conversationId, conversation);
      }

      // Add user message
      conversation.messages.push({
        role: 'user',
        content: userMessage
      });

      // Load tools for user's role
      const tools = await this.loadToolsForRole(userRole);

      let continueLoop = true;
      let finalResponse = null;

      while (continueLoop) {
        // Call Claude with tools via pool
        const response = await this.pool.invoke({
          model: this.orchestrator.llmService?.providers?.ANTHROPIC?.defaultModel || 'claude-sonnet-4-20250514',
          max_tokens: 8192, // Larger for code generation
          system: this.systemPrompt,
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema
          })),
          messages: conversation.messages
        });

        this.logger.debug('Claude response', {
          conversationId,
          stopReason: response.stop_reason,
          contentBlocks: response.content.length
        });

        // Add assistant response to conversation
        conversation.messages.push({
          role: 'assistant',
          content: response.content
        });

        if (response.stop_reason === 'tool_use') {
          // Execute tools
          const toolResults = await this.executeTools(response.content, context);
          conversation.messages.push({
            role: 'user',
            content: toolResults
          });
          continueLoop = true;

        } else if (response.stop_reason === 'end_turn') {
          const textContent = response.content.find(block => block.type === 'text');
          finalResponse = textContent?.text || '';
          continueLoop = false;

        } else {
          finalResponse = 'Command processing completed';
          continueLoop = false;
        }
      }

      const toolsUsed = this.extractToolsFromConversation(conversation);

      return {
        success: true,
        response: finalResponse,
        toolsUsed: toolsUsed,
        conversationId: conversationId
      };

    } catch (error) {
      this.logger.error('Command processing failed:', error);

      if (this.auditLogger) {
        await this.auditLogger.log({
          action: 'builder_command_failed',
          actor: this.currentUser,
          status: 'error',
          metadata: { error: error.message, command: userMessage }
        });
      }

      return {
        success: false,
        error: error.message,
        conversationId: conversationId
      };
    }
  }

  /**
   * Execute tools called by Claude with RBAC enforcement
   */
  async executeTools(contentBlocks, context) {
    const toolResults = [];
    const userRole = context.role || 'developer';
    const userOrgId = context.orgId;

    const tools = await this.loadToolsForRole(userRole);

    for (const block of contentBlocks) {
      if (block.type === 'tool_use') {
        this.logger.info(`Executing builder tool: ${block.name}`, { input: block.input, role: userRole });

        try {
          // Check role-based access
          if (!this.canUseBuilderTool(userRole, block.name)) {
            throw new Error(`Access denied: Role '${userRole}' cannot use tool '${block.name}'`);
          }

          const tool = tools.find(t => t.name === block.name);
          if (!tool || !tool.handler) {
            throw new Error(`Tool ${block.name} not found or missing handler`);
          }

          // Scope input for role
          let scopedInput;
          try {
            scopedInput = this.scopeInputForRole(block.input, userRole, userOrgId);
          } catch (scopeError) {
            throw new Error(`Access denied: ${scopeError.message}`);
          }

          // Execute tool with orchestrator context
          const rawResult = await tool.handler(this.orchestrator, {
            ...scopedInput,
            _context: context,
            _actor: this.currentUser,
            _role: userRole,
            _orgId: userOrgId
          });

          // Sanitize result for role
          const result = this.sanitizeResultForRole(rawResult, userRole, userOrgId);

          // Audit log
          if (this.auditLogger) {
            await this.auditLogger.log({
              action: block.name,
              actor: this.currentUser,
              actorType: 'healthcare-builder-agent',
              actorRole: userRole,
              actorOrgId: userOrgId,
              resource: block.input.expertType || block.input.packId || block.input.recipeName || 'unknown',
              resourceType: 'builder-operation',
              operation: 'execute',
              changes: scopedInput,
              status: 'success'
            });
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result, null, 2)
          });

          this.logger.info(`Tool ${block.name} completed for role ${userRole}`);

        } catch (error) {
          this.logger.error(`Tool ${block.name} failed:`, error);

          if (this.auditLogger) {
            await this.auditLogger.log({
              action: block.name,
              actor: this.currentUser,
              actorRole: userRole,
              status: 'error',
              metadata: { error: error.message, input: block.input }
            });
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ success: false, error: error.message }),
            is_error: true
          });
        }
      }
    }

    return toolResults;
  }

  /**
   * Check if role can use a builder tool
   */
  canUseBuilderTool(role, toolName) {
    const roleConfig = BUILDER_ROLES[role];
    if (!roleConfig) return false;
    return roleConfig.canAccess(toolName);
  }

  /**
   * Scope input based on role
   */
  scopeInputForRole(input, role, orgId) {
    // Platform admins can access any org
    if (role === 'platform_admin') {
      return input;
    }

    // Other roles are scoped to their org
    if (input.orgId && input.orgId !== orgId) {
      throw new Error('Cannot access resources outside your organization');
    }

    return {
      ...input,
      orgId: orgId || input.orgId
    };
  }

  /**
   * Sanitize result for role visibility
   */
  sanitizeResultForRole(result, role, orgId) {
    // Platform admins see everything
    if (role === 'platform_admin') {
      return result;
    }

    // Filter results to user's org if applicable
    if (Array.isArray(result)) {
      return result.filter(item => !item.orgId || item.orgId === orgId);
    }

    return result;
  }

  /**
   * Load all available tools
   */
  async loadTools() {
    const { aiExpertTools } = await import('./tools/ai-expert-tools.js');
    const { knowledgePackTools } = await import('./tools/knowledge-pack-tools.js');
    const { groundTruthTools } = await import('./tools/ground-truth-tools.js');
    const { assertionTools } = await import('./tools/assertion-tools.js');
    const { calibrationTools } = await import('./tools/calibration-tools.js');
    const { recipeTools } = await import('./tools/recipe-tools.js');
    const { policyTools } = await import('./tools/policy-tools.js');
    const { healthcareTestingTools } = await import('./tools/healthcare-testing-tools.js');
    const { routingGovernanceTools } = await import('./tools/routing-governance-tools.js');

    const allTools = [
      ...aiExpertTools,
      ...knowledgePackTools,
      ...groundTruthTools,
      ...assertionTools,
      ...calibrationTools,
      ...recipeTools,
      ...policyTools,
      ...healthcareTestingTools,
      ...routingGovernanceTools
    ];

    this.logger.debug(`Loaded ${allTools.length} builder tools`);
    return allTools;
  }

  /**
   * Load tools filtered by user role
   */
  async loadToolsForRole(role) {
    const allTools = this.allTools.length > 0 ? this.allTools : await this.loadTools();
    const filteredTools = allTools.filter(tool => this.canUseBuilderTool(role, tool.name));

    this.logger.debug(`RBAC: Role '${role}' has access to ${filteredTools.length}/${allTools.length} builder tools`);

    return filteredTools;
  }

  /**
   * Get list of tools available for a role (for API)
   */
  getToolsForRole(role) {
    return this.allTools
      .filter(tool => this.canUseBuilderTool(role, tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        category: this.getToolCategory(tool.name)
      }));
  }

  /**
   * Get tool category from name
   */
  getToolCategory(toolName) {
    if (toolName.includes('expert')) return 'AI Experts';
    if (toolName.includes('knowledge') || toolName.includes('pack')) return 'Knowledge Packs';
    if (toolName.includes('ground_truth') || toolName.includes('source')) return 'Ground Truth';
    if (toolName.includes('assertion')) return 'Assertions';
    if (toolName.includes('calibration') || toolName.includes('test_case') || toolName.includes('test_suite')) return 'Calibration';
    if (toolName.includes('recipe')) return 'Recipes';
    if (toolName.includes('policy') || toolName.includes('phi')) return 'Policies';
    if (toolName.includes('test') || toolName.includes('validate') || toolName.includes('report')) return 'Testing';
    return 'General';
  }

  /**
   * Load system prompt
   */
  async loadSystemPrompt() {
    return `# Healthcare Builder Agent - Metalligent Platform

You are an autonomous agent for building healthcare AI components.

## Your Role

Help healthcare domain experts and developers build:
- AI Experts with specialized prompts and knowledge packs
- Ground truth sources for clinical validation
- Assertions for correctness checking
- Calibration test cases with gold-standard answers
- Healthcare recipes with correctness integration
- Policy rules for compliance

## Core Principles

1. **Correctness First** - Every component must support verification
2. **Contract-Driven** - Use structured schemas for inputs/outputs
3. **Evidence-Based** - Link to authoritative ground truth sources
4. **Risk-Aware** - Classify risk levels, configure escalation
5. **Auditable** - Ensure full traceability

## AI Expert Architecture

Each AI Expert has:
- **System Prompt**: Domain-specific instructions
- **Output Contract**: JSON Schema for structured decisions
- **Knowledge Packs**: Domain data (guidelines, formularies, ranges)
- **Risk Threshold**: When to escalate to senior expert
- **Certainty Requirements**: Minimum confidence levels

## Available Tool Categories

### AI Expert Tools
- create_ai_expert: Register new AI expert with type, prompt, contract
- configure_expert_prompt: Update expert's system prompt
- assign_knowledge_packs: Link knowledge packs to expert
- set_expert_escalation: Configure escalation chain
- list_ai_experts: Show all registered experts
- test_ai_expert: Simulate expert invocation

### Knowledge Pack Tools
- create_knowledge_pack: Create new knowledge pack with content
- import_clinical_guidelines: Import guidelines (NICE, AHA, etc.)
- import_formulary: Import drug formulary data
- import_reference_ranges: Import lab reference ranges
- update_knowledge_pack: Update pack content/version
- list_knowledge_packs: Show all packs
- query_knowledge: Test knowledge retrieval

### Ground Truth Tools
- register_ground_truth_source: Register external source (ICD-10, SNOMED, etc.)
- configure_adapter: Set up adapter for querying source
- test_source_query: Verify source connectivity and queries
- update_source_version: Update to new version of source
- list_ground_truth_sources: Show all registered sources

### Assertion Tools
- create_assertion_type: Define new assertion type
- create_assertion_rule: Create specific validation rule
- test_assertion: Run assertion against sample data
- list_assertions: Show all assertion rules
- analyze_assertion_coverage: Identify gaps in assertion coverage

### Calibration Tools
- create_test_case: Create calibration test case with expected output
- create_test_suite: Group test cases into suite
- run_calibration: Execute calibration suite
- analyze_calibration_results: Review accuracy metrics
- compare_calibration_runs: Detect regressions
- export_test_cases: Export for healthcare partner review

### Recipe Tools
- create_healthcare_recipe: Create recipe with correctness integration
- add_recipe_step: Add step to existing recipe
- add_correctness_assertions: Add assertions to recipe
- validate_recipe: Check recipe structure and dependencies
- test_recipe: Execute recipe with sample data
- list_recipes: Show all healthcare recipes

### Policy Tools
- create_policy_rule: Create new policy rule
- configure_phi_protection: Set PHI handling rules
- set_approval_workflow: Configure approval requirements
- test_policy: Evaluate policy against scenario
- list_policies: Show all policy rules

### Testing Tools
- run_correctness_tests: Run full correctness test suite
- validate_expert_output: Verify AI expert produces valid output
- test_end_to_end: Full workflow test
- generate_test_report: Create comprehensive test report

## Workflow Patterns

### Creating an AI Expert
1. Define specialty and use cases
2. Write system prompt with domain expertise
3. Create output contract (risk analysis, certainty, evidence)
4. Assign knowledge packs
5. Configure escalation chain
6. Create calibration test cases
7. Test expert invocation

### Building a Healthcare Recipe
1. Define input/output contracts
2. Add processing steps (query, transform, analyze)
3. Add LLM steps if needed (llm.analyze, llm.recommend)
4. Add correctness assertions
5. Configure AI expert review triggers
6. Test with sample data
7. Run calibration suite

## Interaction Style

- **Helpful**: Guide users through complex healthcare AI development
- **Educational**: Explain patterns and compliance requirements
- **Efficient**: Generate working configurations quickly
- **Safe**: Validate before executing operations
- **HIPAA-Aware**: Always consider PHI implications

You help healthcare domain experts and developers build better AI components while ensuring correctness and compliance.`;
  }

  /**
   * Extract tools used from conversation
   */
  extractToolsFromConversation(conversation) {
    const tools = [];
    for (const message of conversation.messages) {
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_use') {
            tools.push({ name: block.name, input: block.input });
          }
        }
      }
    }
    return tools;
  }

  generateConversationId() {
    return `builder_conv_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  getConversation(conversationId) {
    return this.activeConversations.get(conversationId);
  }

  async continueConversation(conversationId, message, context = {}) {
    const conversation = this.activeConversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    return await this.processCommand(message, { ...context, conversationId });
  }

  clearOldConversations(maxAge = 3600000) {
    const now = Date.now();
    for (const [id, conv] of this.activeConversations.entries()) {
      const age = now - new Date(conv.createdAt).getTime();
      if (age > maxAge) {
        this.activeConversations.delete(id);
      }
    }
  }

  /**
   * Get agent statistics
   */
  getStats() {
    return {
      conversationCount: this.activeConversations.size,
      toolCount: this.allTools.length,
      poolStats: this.pool.getStats()
    };
  }
}

export default HealthcareBuilderAgent;
