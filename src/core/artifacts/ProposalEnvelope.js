/**
 * ProposalEnvelope - Governed change proposals
 *
 * Proposals represent requested changes that require approval.
 * They capture the what, why, and impact of proposed changes.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../contracts/EnvelopeHeader.js';
import { registerSchema, SchemaIds } from '../contracts/registry.js';
import { BaseArtifactPayloadSchema, RiskClassificationSchema, EvidenceRefSchema } from './BaseArtifact.js';

/**
 * Proposal type - what kind of change is being proposed
 */
export const ProposalTypeSchema = z.enum([
  'profile_update',      // Update to a determinant profile
  'pack_promotion',      // Promote a pack to production
  'schema_change',       // Schema modification
  'policy_change',       // Policy rule change
  'configuration',       // Configuration change
  'data_correction'      // Correction to source data
]).describe('Type of change being proposed');

/**
 * Change specification - what will change
 */
export const ChangeSpecSchema = z.object({
  targetType: z.string().describe('Type of artifact being changed'),
  targetId: z.string().describe('ID of artifact being changed'),
  targetVersion: z.string().optional().describe('Current version of target'),
  changeType: z.enum(['create', 'update', 'delete', 'promote', 'deprecate']),
  diff: z.object({
    before: z.any().optional().describe('State before change'),
    after: z.any().describe('State after change'),
    fields: z.array(z.string()).optional().describe('Fields being modified')
  }).optional(),
  rollbackPlan: z.string().optional().describe('How to rollback if needed')
});

/**
 * Impact assessment
 */
export const ImpactAssessmentSchema = z.object({
  affectedArtifacts: z.array(z.object({
    artifactId: z.string(),
    artifactType: z.string(),
    impactType: z.enum(['direct', 'indirect', 'dependent']),
    severity: z.enum(['none', 'low', 'medium', 'high', 'critical'])
  })).optional(),
  affectedUsers: z.number().optional().describe('Estimated number of affected users'),
  affectedWorkflows: z.array(z.string()).optional(),
  riskAssessment: z.string().optional(),
  mitigationPlan: z.string().optional()
});

/**
 * Approval requirement
 */
export const ApprovalRequirementSchema = z.object({
  approverRole: z.string().describe('Role required to approve'),
  approverCount: z.number().default(1).describe('Number of approvals needed'),
  escalationPath: z.string().optional().describe('Escalation if not approved in time'),
  deadline: z.string().datetime().optional()
});

/**
 * Approval action
 */
export const ApprovalActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'request_changes', 'abstain']),
  approverId: z.string(),
  approverRole: z.string(),
  timestamp: z.string().datetime(),
  comment: z.string().optional(),
  conditions: z.array(z.string()).optional().describe('Conditions for conditional approval')
});

/**
 * Proposal payload
 */
export const ProposalPayloadSchema = BaseArtifactPayloadSchema.extend({
  artifactType: z.literal('proposal'),
  proposalType: ProposalTypeSchema,
  title: z.string().describe('Short title for the proposal'),
  rationale: z.string().describe('Why this change is needed'),
  urgency: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  changeSpec: ChangeSpecSchema,
  impactAssessment: ImpactAssessmentSchema.optional(),
  approvalRequirements: z.array(ApprovalRequirementSchema),
  approvalActions: z.array(ApprovalActionSchema).default([]),
  submittedAt: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
  resolution: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'expired']).default('pending'),
  executedAt: z.string().datetime().optional().describe('When the change was applied')
});

/**
 * Full Proposal Envelope
 */
export const ProposalEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: ProposalPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a proposal
 */
export function createProposal(options) {
  const {
    name,
    description,
    orgId,
    createdBy,
    proposalType,
    title,
    rationale,
    urgency = 'normal',
    changeSpec,
    impactAssessment,
    approvalRequirements,
    tags,
    traceId
  } = options;

  const now = new Date().toISOString();

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.ARTIFACT_PROPOSAL,
    schemaVersion: '1.0.0',
    userId: createdBy,
    action: 'create_proposal',
    source: 'ProposalFactory',
    traceId
  });

  // Determine risk based on proposal type
  const riskClassification = {
    'profile_update': 'HIGH',
    'schema_change': 'CRITICAL',
    'policy_change': 'HIGH',
    'pack_promotion': 'MEDIUM',
    'configuration': 'MEDIUM',
    'data_correction': 'LOW'
  }[proposalType] || 'MEDIUM';

  return {
    header,
    payload: {
      artifactId: crypto.randomUUID(),
      artifactType: 'proposal',
      name: name || title,
      description: description || rationale,
      version: '1.0.0',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      createdBy,
      orgId,
      tags,
      riskClassification,
      proposalType,
      title,
      rationale,
      urgency,
      changeSpec,
      impactAssessment,
      approvalRequirements: approvalRequirements || [{
        approverRole: 'admin',
        approverCount: 1
      }],
      approvalActions: [],
      resolution: 'pending'
    },
    _meta: {
      validated: true,
      validatedAt: now
    }
  };
}

/**
 * Submit a proposal for review
 */
export function submitProposal(proposal) {
  if (proposal.payload.status !== 'draft') {
    throw new Error('Can only submit draft proposals');
  }

  const now = new Date().toISOString();
  proposal.payload.status = 'pending';
  proposal.payload.submittedAt = now;
  proposal.payload.updatedAt = now;

  return proposal;
}

/**
 * Add an approval action
 */
export function addApprovalAction(proposal, action) {
  const approvalAction = {
    ...action,
    timestamp: new Date().toISOString()
  };

  proposal.payload.approvalActions.push(approvalAction);
  proposal.payload.updatedAt = new Date().toISOString();

  // Check if fully approved
  const approvedCount = proposal.payload.approvalActions.filter(
    a => a.action === 'approve'
  ).length;

  const requiredCount = proposal.payload.approvalRequirements.reduce(
    (sum, req) => sum + req.approverCount, 0
  );

  if (approvedCount >= requiredCount) {
    proposal.payload.resolution = 'approved';
    proposal.payload.status = 'approved';
    proposal.payload.resolvedAt = new Date().toISOString();
  }

  // Check if rejected
  const rejections = proposal.payload.approvalActions.filter(
    a => a.action === 'reject'
  );
  if (rejections.length > 0) {
    proposal.payload.resolution = 'rejected';
    proposal.payload.status = 'archived';
    proposal.payload.resolvedAt = new Date().toISOString();
  }

  return approvalAction;
}

/**
 * Mark proposal as executed
 */
export function markExecuted(proposal) {
  if (proposal.payload.resolution !== 'approved') {
    throw new Error('Can only execute approved proposals');
  }

  proposal.payload.executedAt = new Date().toISOString();
  proposal.payload.status = 'published';
  proposal.payload.updatedAt = new Date().toISOString();

  return proposal;
}

/**
 * Validate a proposal
 */
export function validateProposal(proposal) {
  return ProposalEnvelopeSchema.safeParse(proposal);
}

// Register schema on load
try {
  registerSchema(SchemaIds.ARTIFACT_PROPOSAL, '1.0.0', ProposalEnvelopeSchema);
} catch (e) {
  // Already registered
}

export default ProposalEnvelopeSchema;
