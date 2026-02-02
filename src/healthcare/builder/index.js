/**
 * Healthcare Builder Module
 *
 * Exports the Healthcare Builder Agent and all tool collections
 * for building healthcare AI components.
 */

// Main agent class
export { HealthcareBuilderAgent } from './HealthcareBuilderAgent.js';
export { default as HealthcareBuilderAgentDefault } from './HealthcareBuilderAgent.js';

// Tool collections
export { aiExpertTools } from './tools/ai-expert-tools.js';
export { knowledgePackTools } from './tools/knowledge-pack-tools.js';
export { groundTruthTools } from './tools/ground-truth-tools.js';
export { assertionTools } from './tools/assertion-tools.js';
export { calibrationTools } from './tools/calibration-tools.js';
export { recipeTools } from './tools/recipe-tools.js';
export { policyTools } from './tools/policy-tools.js';
export { healthcareTestingTools } from './tools/healthcare-testing-tools.js';

// Convenience: all tools combined
export async function getAllBuilderTools() {
  const { aiExpertTools } = await import('./tools/ai-expert-tools.js');
  const { knowledgePackTools } = await import('./tools/knowledge-pack-tools.js');
  const { groundTruthTools } = await import('./tools/ground-truth-tools.js');
  const { assertionTools } = await import('./tools/assertion-tools.js');
  const { calibrationTools } = await import('./tools/calibration-tools.js');
  const { recipeTools } = await import('./tools/recipe-tools.js');
  const { policyTools } = await import('./tools/policy-tools.js');
  const { healthcareTestingTools } = await import('./tools/healthcare-testing-tools.js');

  return [
    ...aiExpertTools,
    ...knowledgePackTools,
    ...groundTruthTools,
    ...assertionTools,
    ...calibrationTools,
    ...recipeTools,
    ...policyTools,
    ...healthcareTestingTools
  ];
}

// Tool category metadata
export const toolCategories = {
  'AI Experts': {
    description: 'Create and manage AI Experts with specialized prompts and knowledge packs',
    tools: ['create_ai_expert', 'configure_expert_prompt', 'assign_knowledge_packs', 'set_expert_escalation', 'list_ai_experts', 'test_ai_expert'],
    requiredRoles: ['healthcare_admin', 'platform_admin']
  },
  'Knowledge Packs': {
    description: 'Create and manage clinical knowledge bases, guidelines, and formularies',
    tools: ['create_knowledge_pack', 'import_clinical_guidelines', 'import_formulary', 'import_reference_ranges', 'update_knowledge_pack', 'list_knowledge_packs', 'query_knowledge'],
    requiredRoles: ['healthcare_admin', 'platform_admin']
  },
  'Ground Truth': {
    description: 'Register and manage authoritative clinical data sources for validation',
    tools: ['register_ground_truth_source', 'configure_adapter', 'test_source_query', 'update_source_version', 'list_ground_truth_sources'],
    requiredRoles: ['platform_admin']
  },
  'Assertions': {
    description: 'Define assertion types and rules for correctness validation',
    tools: ['create_assertion_type', 'create_assertion_rule', 'test_assertion', 'list_assertions', 'analyze_assertion_coverage'],
    requiredRoles: ['healthcare_admin', 'healthcare_builder']
  },
  'Calibration': {
    description: 'Create and run calibration test cases with gold-standard expected outputs',
    tools: ['create_test_case', 'create_test_suite', 'run_calibration', 'analyze_calibration_results', 'compare_calibration_runs', 'export_test_cases'],
    requiredRoles: ['healthcare_admin', 'healthcare_builder']
  },
  'Recipes': {
    description: 'Build healthcare recipes with correctness integration and AI expert triggers',
    tools: ['create_healthcare_recipe', 'add_recipe_step', 'add_correctness_assertions', 'validate_recipe', 'test_recipe', 'list_recipes'],
    requiredRoles: ['healthcare_builder', 'healthcare_admin']
  },
  'Policies': {
    description: 'Configure healthcare policy rules, PHI protection, and approval workflows',
    tools: ['create_policy_rule', 'configure_phi_protection', 'set_approval_workflow', 'test_policy', 'list_policies'],
    requiredRoles: ['healthcare_admin', 'platform_admin']
  },
  'Testing': {
    description: 'Run comprehensive correctness tests and generate reports',
    tools: ['run_correctness_tests', 'validate_expert_output', 'test_end_to_end', 'generate_test_report'],
    requiredRoles: ['healthcare_builder', 'healthcare_admin', 'developer']
  }
};

// Default export
export default {
  HealthcareBuilderAgent: (await import('./HealthcareBuilderAgent.js')).HealthcareBuilderAgent,
  getAllBuilderTools,
  toolCategories
};
