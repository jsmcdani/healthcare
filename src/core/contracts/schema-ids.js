/**
 * Schema IDs - Constants only, no dependencies
 *
 * Separated to break circular dependency chain.
 */

export const SchemaIds = {
  // Envelopes
  STEP_INPUT: 'envelope.step.input',
  STEP_OUTPUT: 'envelope.step.output',
  REQUEST: 'envelope.api.request',
  RESPONSE: 'envelope.api.response',
  ERROR: 'envelope.error',

  // Artifacts
  ARTIFACT_BASE: 'artifact.base',
  ARTIFACT_PROFILE: 'artifact.profile',
  ARTIFACT_PACK: 'artifact.pack',
  ARTIFACT_PROPOSAL: 'artifact.proposal',

  // Packs
  PACK_HOTSPOT: 'pack.hotspot',
  PACK_COVERAGE: 'pack.coverage',
  PACK_AFFINITY: 'pack.affinity',

  // Publication
  PUBLICATION_GATE: 'publication.gate',
  APPROVAL_REQUEST: 'publication.approval.request',
  APPROVAL_DECISION: 'publication.approval.decision',

  // Policy Engine (Phase 8)
  POLICY_RULE: 'policy.rule',
  POLICY_EVALUATION: 'policy.evaluation',
  POLICY_VIOLATION: 'policy.violation',

  // Knowledge Integration (Phase 8)
  KNOWLEDGE_QUERY: 'knowledge.query',
  KNOWLEDGE_RESPONSE: 'knowledge.response',
  KNOWLEDGE_SOURCE: 'knowledge.source',

  // PHI/Compliance (Phase 8)
  PHI_CLASSIFICATION: 'phi.classification',
  MASKING_RULE: 'phi.masking.rule',
  AUDIT_TRAIL: 'compliance.audit.trail',
  COMPLIANCE_REPORT: 'compliance.report',

  // Correctness Assurance (Phase 9)
  GROUND_TRUTH_SOURCE: 'correctness.ground_truth.source',
  CORRECTNESS_ASSERTION: 'correctness.assertion',
  CORRECTNESS_ENVELOPE: 'correctness.envelope',
  CALIBRATION_TEST_CASE: 'correctness.calibration.test_case',
  CALIBRATION_RUN: 'correctness.calibration.run',
  EXPERT_REVIEW: 'correctness.review.expert',
  OUTCOME_RECORD: 'correctness.feedback.outcome'
};

export default SchemaIds;
