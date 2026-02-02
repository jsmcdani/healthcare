/**
 * Admin Agent RBAC Configuration
 *
 * Defines tool permissions and data sanitization rules by role.
 *
 * Roles (hierarchical):
 * - platform_admin: Full access to everything, all orgs
 * - org_admin: Manage own org, users, cache - no cross-org or dangerous ops
 * - healthcare_admin: Manage AI experts, knowledge packs, policies (healthcare domain)
 * - healthcare_builder: Build recipes, assertions, calibration tests
 * - developer: Testing and validation only
 * - admin: Read-only access to own org data
 * - user: Basic read-only access
 */

/**
 * Tool Permission Levels
 *
 * CRITICAL: Can destroy data, affect all orgs, change security
 * ELEVATED: Can modify data, affect users, change configurations
 * STANDARD: Can read/write within org scope
 * READ_ONLY: Can only read data
 */
export const PERMISSION_LEVELS = {
  CRITICAL: 'critical',
  ELEVATED: 'elevated',
  STANDARD: 'standard',
  READ_ONLY: 'read_only'
};

/**
 * Role definitions with allowed permission levels
 */
export const ROLE_PERMISSIONS = {
  platform_admin: [PERMISSION_LEVELS.CRITICAL, PERMISSION_LEVELS.ELEVATED, PERMISSION_LEVELS.STANDARD, PERMISSION_LEVELS.READ_ONLY],
  org_admin: [PERMISSION_LEVELS.ELEVATED, PERMISSION_LEVELS.STANDARD, PERMISSION_LEVELS.READ_ONLY],
  healthcare_admin: [PERMISSION_LEVELS.ELEVATED, PERMISSION_LEVELS.STANDARD, PERMISSION_LEVELS.READ_ONLY],
  healthcare_builder: [PERMISSION_LEVELS.STANDARD, PERMISSION_LEVELS.READ_ONLY],
  developer: [PERMISSION_LEVELS.STANDARD, PERMISSION_LEVELS.READ_ONLY],
  admin: [PERMISSION_LEVELS.STANDARD, PERMISSION_LEVELS.READ_ONLY],
  user: [PERMISSION_LEVELS.READ_ONLY]
};

/**
 * Tool permissions - maps tool name to permission level and org-scoping rules
 */
export const TOOL_PERMISSIONS = {
  // ========================================
  // CRITICAL - Platform Admin Only
  // ========================================

  // Database Management - Can destroy data
  create_database_backup: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  restore_database_backup: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  migrate_to_cluster_mode: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  enable_cluster_mode: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // Organization Management - Cross-org operations
  create_organization: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  delete_organization: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  list_organizations: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // LLM Configuration - API keys, costs
  update_llm_config: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  apply_llm_profile: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  reset_llm_config: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  set_spending_limit: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  configure_task_routing: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // Scheduled Tasks - System-wide operations
  create_scheduled_task: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  delete_scheduled_task: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  trigger_task_now: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  run_system_task: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // Entity/Service Registry
  register_service: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  register_agent: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  delete_entity: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  bulk_update_entities: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // Alerting - System-wide
  configure_notification_channel: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  delete_alert: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // Prompt Management - Affects AI behavior
  update_prompt: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  activate_prompt: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // Ground Truth Sources - Platform Admin Only (affects validation across system)
  register_ground_truth_source: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  configure_adapter: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },
  update_source_version: { level: PERMISSION_LEVELS.CRITICAL, orgScoped: false },

  // ========================================
  // ELEVATED - Org Admin+
  // ========================================

  // User Management - Within org
  create_user: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  update_user: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  delete_user: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  assign_user_to_org: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  invite_user: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  reset_user_password: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  unlock_user: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Session Management - Within org
  revoke_session: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  revoke_all_user_sessions: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Cache Management - Within org
  clear_cache: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  update_cache_policy: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  clear_metadata_cache: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Feature Flags - Within org
  enable_feature: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  disable_feature: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  rollout_feature: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Organization Settings
  update_organization: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  configure_org_services: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  complete_org_setup: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Salesforce Connections - Org-specific
  add_salesforce_connection: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  remove_salesforce_connection: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Metadata Operations - Org-specific
  trigger_metadata_ingestion: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  analyze_technical_debt: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Alerting - Org-specific
  configure_alert: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  acknowledge_alert: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Jobs - Org-specific
  cancel_job: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  retry_failed_job: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Entity Management - Org-specific
  create_entity: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  update_entity: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Healthcare Builder - AI Expert Management (healthcare_admin+)
  create_ai_expert: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  configure_expert_prompt: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  assign_knowledge_packs: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  set_expert_escalation: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Healthcare Builder - Knowledge Pack Management (healthcare_admin+)
  create_knowledge_pack: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  import_clinical_guidelines: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  import_formulary: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  import_reference_ranges: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  update_knowledge_pack: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Healthcare Builder - Policy Management (healthcare_admin+)
  create_policy_rule: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  configure_phi_protection: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },
  set_approval_workflow: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // ========================================
  // STANDARD - Admin+
  // ========================================

  // Graph Queries - Org-scoped reads
  run_graph_query: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  explore_edges: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  find_node_connections: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },

  // Flow Operations - Org-scoped
  list_org_flows: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  get_flow_details: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  get_execution_order: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  find_flow_dependencies: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  list_workflow_rules: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  compare_flows: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },

  // Recipe Operations
  run_recipe: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  validate_recipe: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },

  // Test Operations
  test_salesforce_connection: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  test_llm_connection: { level: PERMISSION_LEVELS.STANDARD, orgScoped: false },
  test_notification_channel: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  run_precommit_check: { level: PERMISSION_LEVELS.STANDARD, orgScoped: false },
  run_service_validation: { level: PERMISSION_LEVELS.STANDARD, orgScoped: false },
  run_compliance_suite: { level: PERMISSION_LEVELS.STANDARD, orgScoped: false },

  // Healthcare Builder - Assertion Tools (healthcare_builder+)
  create_assertion_type: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  create_assertion_rule: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  test_assertion: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },

  // Healthcare Builder - Calibration Tools (healthcare_builder+)
  create_test_case: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  create_test_suite: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  run_calibration: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },

  // Healthcare Builder - Recipe Tools (healthcare_builder+)
  create_healthcare_recipe: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  add_recipe_step: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  add_correctness_assertions: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  validate_healthcare_recipe: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  test_recipe: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },

  // Healthcare Builder - Testing Tools (healthcare_builder+, developer)
  run_correctness_tests: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  validate_expert_output: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  test_end_to_end: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  generate_test_report: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  test_ai_expert: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  test_policy: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },
  test_source_query: { level: PERMISSION_LEVELS.STANDARD, orgScoped: true },

  // ========================================
  // READ_ONLY - All authenticated users
  // ========================================

  // User Reads
  list_users: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_user: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  list_pending_users: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  list_pending_invites: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Session/Audit Reads
  list_active_sessions: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_user_sessions: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  view_audit_log: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  view_login_attempts: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_security_summary: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Feature Flag Reads
  list_feature_flags: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  check_feature_status: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // System Health Reads
  get_system_health: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_service_health: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_error_summary: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_performance_stats: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  list_registered_services: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_environment_info: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },

  // Database Stats (read-only)
  get_database_stats: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  list_backups: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },

  // Graph Stats
  get_graph_stats: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_collection_schema: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  list_org_collections: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Organization Reads
  get_organization: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_service_status: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Metadata Reads
  get_ingestion_status: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_metadata_summary: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  discover_salesforce_metadata: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // LLM Reads
  get_llm_config: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_llm_costs: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_cost_summary: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_spending_limits: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_cost_forecast: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_cost_anomalies: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  analyze_llm_usage: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_available_profiles: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  recommend_llm_settings: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_model_capabilities: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  record_llm_cost: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true }, // Actually writes but scoped

  // Recipe Reads
  list_recipes: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_recipe: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_recipe_history: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Prompt Reads
  list_prompts: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_prompt: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },

  // Scheduled Task Reads
  list_scheduled_tasks: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_task_history: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_task_templates: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  enable_disable_task: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true }, // Read-only for status
  update_scheduled_task: { level: PERMISSION_LEVELS.ELEVATED, orgScoped: true },

  // Alert Reads
  list_alerts: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_triggered_alerts: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  list_notification_channels: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },

  // Job Reads
  list_active_jobs: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_job_status: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  list_system_scheduled_tasks: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },
  get_job_history: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Entity Reads
  list_entities: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_entity: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  discover_capabilities: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_entity_relationships: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  query_entities_by_org: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  get_registry_stats: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },

  // Healthcare Builder - AI Expert Reads
  list_ai_experts: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Healthcare Builder - Knowledge Pack Reads
  list_knowledge_packs: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  query_knowledge: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Healthcare Builder - Ground Truth Reads
  list_ground_truth_sources: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: false },

  // Healthcare Builder - Assertion Reads
  list_assertions: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  analyze_assertion_coverage: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Healthcare Builder - Calibration Reads
  analyze_calibration_results: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  compare_calibration_runs: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },
  export_test_cases: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Healthcare Builder - Recipe Reads
  list_healthcare_recipes: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true },

  // Healthcare Builder - Policy Reads
  list_policies: { level: PERMISSION_LEVELS.READ_ONLY, orgScoped: true }
};

/**
 * Fields to sanitize/redact by role
 */
export const FIELD_SANITIZATION = {
  // Fields to completely remove for non-platform_admin
  platform_admin_only: [
    'passwordHash',
    'apiKey',
    'clientSecret',
    'refreshToken',
    'accessToken',
    'encryptedCredentials',
    'privateKey'
  ],

  // Fields to mask (show partial) for org_admin
  mask_for_org_admin: [
    'email' // Show first 3 chars + domain
  ],

  // Fields to completely hide for regular admin
  hide_for_admin: [
    'email',
    'lastLogin',
    'loginAttempts',
    'ipAddress'
  ]
};

/**
 * Check if a role can use a tool
 */
export function canUseTool(role, toolName) {
  const toolConfig = TOOL_PERMISSIONS[toolName];
  if (!toolConfig) {
    // Unknown tool - deny by default
    return false;
  }

  const allowedLevels = ROLE_PERMISSIONS[role] || [];
  return allowedLevels.includes(toolConfig.level);
}

/**
 * Get all tools available for a role
 */
export function getToolsForRole(role) {
  const allowedLevels = ROLE_PERMISSIONS[role] || [];
  return Object.entries(TOOL_PERMISSIONS)
    .filter(([_, config]) => allowedLevels.includes(config.level))
    .map(([name, config]) => ({ name, ...config }));
}

/**
 * Check if tool requires org scoping
 */
export function isOrgScoped(toolName) {
  return TOOL_PERMISSIONS[toolName]?.orgScoped ?? true;
}

/**
 * Sanitize data based on role
 */
export function sanitizeForRole(data, role, userOrgId = null) {
  if (!data || typeof data !== 'object') return data;
  if (role === 'platform_admin') return data; // Full access

  const sanitized = Array.isArray(data) ? [...data] : { ...data };

  // Helper to process a single object
  const processObject = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;

    const result = { ...obj };

    // Remove platform_admin only fields
    for (const field of FIELD_SANITIZATION.platform_admin_only) {
      if (field in result) {
        result[field] = '[REDACTED]';
      }
    }

    // For org_admin - mask certain fields
    if (role === 'org_admin') {
      for (const field of FIELD_SANITIZATION.mask_for_org_admin) {
        if (result[field] && typeof result[field] === 'string') {
          if (field === 'email') {
            const [local, domain] = result[field].split('@');
            result[field] = `${local.slice(0, 3)}***@${domain}`;
          }
        }
      }
    }

    // For regular admin - hide more fields
    if (role === 'admin' || role === 'user') {
      for (const field of FIELD_SANITIZATION.hide_for_admin) {
        if (field in result) {
          result[field] = '[HIDDEN]';
        }
      }
    }

    // Filter by org if user is not platform_admin
    if (userOrgId && result.orgId && result.orgId !== userOrgId) {
      return null; // Filter out cross-org data
    }

    return result;
  };

  // Process array or single object
  if (Array.isArray(sanitized)) {
    return sanitized
      .map(processObject)
      .filter(item => item !== null);
  }

  return processObject(sanitized);
}

/**
 * Validate and scope input parameters based on role
 */
export function scopeInputForRole(input, role, userOrgId) {
  if (role === 'platform_admin') return input; // No restrictions

  const scoped = { ...input };

  // Force org scoping for non-platform admins
  if (userOrgId) {
    // If they specified a different org, deny
    if (scoped.orgId && scoped.orgId !== userOrgId) {
      throw new Error(`Access denied: Cannot access org ${scoped.orgId}`);
    }
    // Force their org
    scoped.orgId = userOrgId;
  }

  return scoped;
}

export default {
  PERMISSION_LEVELS,
  ROLE_PERMISSIONS,
  TOOL_PERMISSIONS,
  FIELD_SANITIZATION,
  canUseTool,
  getToolsForRole,
  isOrgScoped,
  sanitizeForRole,
  scopeInputForRole
};
