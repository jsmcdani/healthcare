/**
 * Artifacts Index
 *
 * Export all artifact types for convenient importing.
 */

// Base artifact
export {
  BaseArtifactEnvelopeSchema,
  BaseArtifactPayloadSchema,
  RiskClassificationSchema,
  EvidenceRefSchema,
  ArtifactStatusSchema,
  createBaseArtifact,
  extendArtifactSchema,
  validateBaseArtifact
} from './BaseArtifact.js';

// Determinant Profile
export {
  DeterminantProfileEnvelopeSchema,
  DeterminantProfilePayloadSchema,
  ProfileScopeSchema,
  DeterminantRuleSchema,
  VersionPinSchema,
  createDeterminantProfile,
  addProfileRule,
  pinVersion,
  validateDeterminantProfile
} from './DeterminantProfileEnvelope.js';

// Feature Pack
export {
  FeaturePackEnvelopeSchema,
  FeaturePackPayloadSchema,
  ComputationMetadataSchema,
  DataQualitySchema,
  createFeaturePack,
  addPackItems,
  finalizePack,
  validateFeaturePack
} from './FeaturePackEnvelope.js';

// Proposal
export {
  ProposalEnvelopeSchema,
  ProposalPayloadSchema,
  ProposalTypeSchema,
  ChangeSpecSchema,
  ImpactAssessmentSchema,
  ApprovalRequirementSchema,
  ApprovalActionSchema,
  createProposal,
  submitProposal,
  addApprovalAction,
  markExecuted,
  validateProposal
} from './ProposalEnvelope.js';

// Optimization Run Report
export {
  OptimizationRunReportEnvelopeSchema,
  OptimizationRunReportPayloadSchema,
  RunStatusSchema,
  RunStepResultSchema,
  OptimizationMetricsSchema,
  createOptimizationRunReport,
  startRun,
  addStepResult,
  completeRun,
  validateOptimizationRunReport
} from './OptimizationRunReportEnvelope.js';

// All packs
export * from './packs/index.js';
