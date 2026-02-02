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
  APPROVAL_DECISION: 'publication.approval.decision'
};

export default SchemaIds;
