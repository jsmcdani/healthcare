/**
 * Healthcare Admin Agent
 *
 * Autonomous admin agent for Metalligent Healthcare platform.
 * Based on Servient AdminAgent but adapted for healthcare:
 * - Removes Salesforce-specific tools
 * - Adds PHI protection, policy engine, knowledge engine tools
 * - Uses Cosmos DB Gremlin instead of ArangoDB
 */

import { AnthropicPool } from '../../admin/AnthropicPool.js';
import { FeatureFlagStorage } from '../../admin/storage/FeatureFlagStorage.js';
import { AuditLogger } from '../../admin/storage/AuditLogger.js';
import {
  canUseTool,
  getToolsForRole,
  sanitizeForRole,
  scopeInputForRole
} from '../../admin/rbac-config.js';
import { Logger } from '../../utils/logger.js';

export class HealthcareAdminAgent {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    // Use orchestrator's logger or create our own
    this.logger = orchestrator?.logger || new Logger('HealthcareAdminAgent');

    // Initialize Anthropic pool for rate-limited requests
    this.pool = new AnthropicPool({
      maxRequestsPerMinute: 40,
      maxConcurrent: 3,
      maxRetries: 3
    });

    this.poolDatabaseConnected = false;

    // Storage layers
    this.featureFlagStorage = null;
    this.auditLogger = null;

    // Conversation management
    this.activeConversations = new Map();
    this.currentUser = null;

    // System prompt loaded at initialization
    this.systemPrompt = null;
  }

  async initialize() {
    this.logger.info('🏥 Initializing Healthcare Admin Agent...');

    try {
      // Initialize storage layers (using ArangoDB for admin, Cosmos for graph)
      if (this.orchestrator.arango?.db) {
        this.featureFlagStorage = new FeatureFlagStorage(
          this.orchestrator.arango.db,
          this.orchestrator.redisClient,
          this.logger
        );
        await this.featureFlagStorage.initialize();

        this.auditLogger = new AuditLogger(
          this.orchestrator.arango.db,
          this.logger
        );
        await this.auditLogger.initialize();

        // Connect AnthropicPool to database for usage tracking
        if (typeof this.pool.setDatabase === 'function') {
          this.pool.setDatabase(this.orchestrator.arango.db);
          this.poolDatabaseConnected = true;
        }
      }

      // Load system prompt
      this.systemPrompt = await this.loadSystemPrompt();

      // Connect Redis for LLM response caching
      if (this.orchestrator?.redisClient) {
        this.pool.setRedisClient(this.orchestrator.redisClient);
      }

      // Register on orchestrator so tools can access the pool
      if (this.orchestrator) {
        this.orchestrator.healthcareAdminAgent = this;
      }

      this.logger.info('✅ Healthcare Admin Agent initialized successfully');

      return {
        success: true,
        storage: {
          featureFlags: this.featureFlagStorage ? 'initialized' : 'unavailable',
          auditLog: this.auditLogger ? 'initialized' : 'unavailable'
        }
      };

    } catch (error) {
      this.logger.error('❌ Healthcare Admin Agent initialization failed:', error);
      throw error;
    }
  }

  /**
   * Process admin command
   */
  async processCommand(userMessage, context = {}) {
    const conversationId = context.conversationId || this.generateConversationId();
    this.currentUser = context.userId || context.actor || 'system';

    try {
      // Get or create conversation
      let conversation = this.activeConversations.get(conversationId);
      if (!conversation) {
        conversation = {
          id: conversationId,
          messages: [],
          createdAt: new Date().toISOString(),
          userId: this.currentUser,
          context: context
        };
        this.activeConversations.set(conversationId, conversation);
      }

      // Add user message
      conversation.messages.push({
        role: 'user',
        content: userMessage
      });

      // Load available tools
      const tools = await this.loadTools();

      let continueLoop = true;
      let finalResponse = null;

      while (continueLoop) {
        // Call Claude with tools via pool
        const response = await this.pool.invoke({
          model: this.orchestrator.llmService?.providers?.ANTHROPIC?.defaultModel || 'claude-sonnet-4-20250514',
          max_tokens: 4096,
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
          action: 'command_failed',
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
    const userRole = context.role || 'user';
    const userOrgId = context.orgId;

    const tools = await this.loadToolsForRole(userRole);

    for (const block of contentBlocks) {
      if (block.type === 'tool_use') {
        this.logger.info(`🔧 Executing tool: ${block.name}`, { input: block.input, role: userRole });

        try {
          if (!canUseTool(userRole, block.name)) {
            throw new Error(`Access denied: Role '${userRole}' cannot use tool '${block.name}'`);
          }

          const tool = tools.find(t => t.name === block.name);
          if (!tool || !tool.handler) {
            throw new Error(`Tool ${block.name} not found or missing handler`);
          }

          let scopedInput;
          try {
            scopedInput = scopeInputForRole(block.input, userRole, userOrgId);
          } catch (scopeError) {
            throw new Error(`Access denied: ${scopeError.message}`);
          }

          const rawResult = await tool.handler(this.orchestrator, {
            ...scopedInput,
            _context: context,
            _actor: this.currentUser,
            _role: userRole,
            _orgId: userOrgId
          });

          const result = sanitizeForRole(rawResult, userRole, userOrgId);

          if (this.auditLogger) {
            await this.auditLogger.log({
              action: block.name,
              actor: this.currentUser,
              actorType: 'healthcare-admin-agent',
              actorRole: userRole,
              actorOrgId: userOrgId,
              resource: block.input.featureName || block.input.serviceName || 'unknown',
              resourceType: 'admin-operation',
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

          this.logger.info(`✅ Tool ${block.name} completed for role ${userRole}`);

        } catch (error) {
          this.logger.error(`❌ Tool ${block.name} failed:`, error);

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
   * Load available tools - Healthcare specific only
   */
  async loadTools() {
    // Healthcare-specific tools only
    const { cosmosGremlinTools } = await import('./tools/cosmos-gremlin-tools.js');
    const { phiProtectionTools } = await import('./tools/phi-protection-tools.js');
    const { policyEngineTools } = await import('./tools/policy-engine-tools.js');
    const { knowledgeEngineTools } = await import('./tools/knowledge-engine-tools.js');
    const { intentModeTools } = await import('./tools/intent-mode-tools.js');
    const { cosmosSchemaTools } = await import('./tools/cosmos-schema-tools.js');
    const { healthcareCacheTools } = await import('./tools/cache-tools.js');

    const allTools = [
      ...cosmosGremlinTools,
      ...phiProtectionTools,
      ...policyEngineTools,
      ...knowledgeEngineTools,
      ...intentModeTools,
      ...cosmosSchemaTools,
      ...healthcareCacheTools
    ];

    this.logger.debug(`Loaded ${allTools.length} healthcare admin tools`);
    return allTools;
  }

  /**
   * Load tools filtered by user role
   */
  async loadToolsForRole(role) {
    const allTools = await this.loadTools();
    const allowedTools = getToolsForRole(role);
    const allowedToolNames = new Set(allowedTools.map(t => t.name));

    const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));

    this.logger.debug(`RBAC: Role '${role}' has access to ${filteredTools.length}/${allTools.length} tools`);

    return filteredTools;
  }

  /**
   * Load system prompt - Healthcare specific
   */
  async loadSystemPrompt() {
    return `# Healthcare Admin Agent - Metalligent Healthcare Platform Administrator

You are an autonomous administrative agent for the Metalligent Healthcare platform, a HIPAA-compliant AI system for healthcare organizations with PHI protection, clinical knowledge, and policy-driven reasoning.

## Your Role

You are the **platform administrator** - responsible for configuration, operations, monitoring, and HIPAA compliance. You have direct access to platform services and the Cosmos DB Gremlin graph.

## Core Responsibilities

### 1. PHI Protection & Compliance
- Monitor PHI access patterns and audit logs
- Configure PHI detection rules and sensitivity levels
- Manage data masking and de-identification policies
- Ensure HIPAA compliance across all operations
- Generate compliance reports and audit trails

### 2. Policy Management
- Configure healthcare-specific policy rules
- Manage intent modes (PHI_PROTECTION, CLINICAL_HOURS, etc.)
- Set up guardrails for AI reasoning
- Define approval workflows for sensitive operations

### 3. Clinical Knowledge Engine
- Manage Clinical knowledge bases
- Configure drug interaction databases
- Update clinical guidelines and protocols
- Monitor knowledge freshness and accuracy

### 4. Graph Database (Cosmos Gremlin)
- Execute Gremlin queries for healthcare data
- Monitor vertex/edge counts and relationships
- Manage PHI field classifications in graph
- Audit automation access to sensitive data

### 5. Schema Management
- Visualize and document graph schema
- Track vertex and edge types
- Monitor schema evolution

## Safety Guidelines

### CRITICAL - PHI Protection:
- NEVER expose raw PHI in responses
- ALWAYS mask sensitive identifiers
- Log ALL PHI access attempts
- Require MFA for PHI-related operations

### ALWAYS Require Confirmation For:
- PHI policy changes
- De-identification rule updates
- Global feature enables
- User permission escalations
- Knowledge base updates

## Available Tools

### PHI Protection Tools (5 tools)
- audit_phi_access: View PHI access logs with filtering
- detect_phi_fields: Scan fields for PHI classification
- configure_phi_masking: Set up data masking rules
- get_phi_exposure_report: Generate PHI exposure analysis
- update_phi_classification: Update field sensitivity levels

### Policy Engine Tools (4 tools)
- list_policies: View all healthcare policies
- create_policy: Create new policy rule
- evaluate_policy: Test policy against scenario
- get_policy_violations: View recent policy violations

### Knowledge Engine Tools (4 tools)
- query_clinical_knowledge: Search clinical guidelines
- check_drug_interactions: Query drug interaction database
- get_knowledge_sources: List knowledge bases and freshness
- update_knowledge_entry: Update clinical knowledge (requires confirmation)

### Intent Mode Tools (4 tools)
- list_intent_modes: View available intent modes
- get_current_mode: Get active mode and settings
- switch_intent_mode: Change active intent mode
- configure_mode_rules: Update mode-specific rules

### Cosmos Gremlin Tools (5 tools)
- gremlin_query: Execute raw Gremlin query
- get_graph_stats: Get vertex/edge counts by label
- find_phi_automations: Find automations accessing PHI
- get_field_access_paths: Trace who reads/writes a field
- audit_graph_permissions: Audit permission graph

### Cosmos Schema Tools (3 tools)
- get_schema_overview: Get graph schema summary
- visualize_schema: Generate schema visualization
- get_vertex_details: Get details about a vertex type

### Cache Management Tools (6 tools)
- list_caches: List all caches and their status
- clear_cache: Clear a specific cache or all caches (requires confirmation)
- get_cache_stats: Get detailed cache statistics including hit rates
- get_llm_cache_stats: Get LLM response cache stats (hit rate, savings)
- clear_llm_cache: Clear LLM response cache for fresh AI responses
- warm_cache: Pre-warm caches with common data

## Interaction Style

- **HIPAA-Aware**: Always consider PHI implications
- **Audit-Focused**: Log and explain all operations
- **Safety-First**: Confirm before sensitive changes
- **Transparent**: Show what's being executed and why

You are autonomous but HIPAA-conscious, knowledgeable but cautious with PHI, and always prioritize patient data protection.`;
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
    return `healthcare_conv_${Date.now()}_${Math.random().toString(36).substring(7)}`;
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
}

export default HealthcareAdminAgent;
