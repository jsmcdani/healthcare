/**
 * ApprovalWorkflow - Manages approval requests and decisions
 *
 * Handles the approval workflow for artifacts that require approval.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../contracts/EnvelopeHeader.js';
import { registerSchema, SchemaIds } from '../contracts/registry.js';
import { getPublicationGate } from './PublicationGate.js';

/**
 * Approval request status
 */
export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired'
]);

/**
 * Approval decision action
 */
export const ApprovalDecisionActionSchema = z.enum([
  'approve',
  'reject',
  'request_changes',
  'delegate',
  'abstain'
]);

/**
 * Approval request payload
 */
export const ApprovalRequestPayloadSchema = z.object({
  requestId: z.string().uuid(),
  artifactId: z.string(),
  artifactType: z.string(),
  artifactName: z.string(),
  artifactVersion: z.string().optional(),
  requestedBy: z.string(),
  requestedAt: z.string().datetime(),
  reason: z.string().describe('Why this artifact needs to be published'),
  urgency: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  status: ApprovalStatusSchema,
  requiredApprovers: z.number(),
  approverRoles: z.array(z.string()),
  decisions: z.array(z.object({
    decisionId: z.string().uuid(),
    approverId: z.string(),
    approverRole: z.string(),
    action: ApprovalDecisionActionSchema,
    timestamp: z.string().datetime(),
    comment: z.string().optional(),
    conditions: z.array(z.string()).optional()
  })),
  deadline: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: z.string().optional()
});

/**
 * Full Approval Request Envelope
 */
export const ApprovalRequestEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: ApprovalRequestPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Approval Workflow - manages approval requests
 */
export class ApprovalWorkflow {
  constructor(options = {}) {
    this.requests = new Map(); // In-memory storage, replace with DB in production
    this.publicationGate = options.publicationGate || getPublicationGate();
    this.notificationHandler = options.notificationHandler || null;
    this.defaultDeadlineDays = options.defaultDeadlineDays || 7;
  }

  /**
   * Create an approval request for an artifact
   */
  async createRequest(artifact, options = {}) {
    const {
      requestedBy,
      reason,
      urgency = 'normal',
      deadline
    } = options;

    if (!requestedBy) {
      throw new Error('requestedBy is required');
    }

    // Check publication gate
    const gateResult = this.publicationGate.evaluate(artifact);

    if (gateResult.gate === 'FORBIDDEN') {
      throw new Error(`Publication is forbidden: ${gateResult.reason}`);
    }

    if (gateResult.gate === 'AUTO_PUBLISH_ALLOWED') {
      return {
        autoApproved: true,
        reason: gateResult.reason
      };
    }

    // Create approval request
    const now = new Date();
    const requestDeadline = deadline || new Date(now.getTime() + this.defaultDeadlineDays * 24 * 60 * 60 * 1000).toISOString();

    const payload = artifact.payload || artifact;

    const header = createEnvelopeHeader({
      schemaId: SchemaIds.APPROVAL_REQUEST,
      schemaVersion: '1.0.0',
      userId: requestedBy,
      action: 'create_approval_request',
      source: 'ApprovalWorkflow'
    });

    const request = {
      header,
      payload: {
        requestId: crypto.randomUUID(),
        artifactId: payload.artifactId,
        artifactType: payload.artifactType,
        artifactName: payload.name,
        artifactVersion: payload.version,
        requestedBy,
        requestedAt: now.toISOString(),
        reason: reason || 'Publication request',
        urgency,
        status: 'pending',
        requiredApprovers: gateResult.requiredApprovers || 1,
        approverRoles: gateResult.approverRoles || ['admin'],
        decisions: [],
        deadline: requestDeadline
      },
      _meta: {
        validated: true,
        validatedAt: now.toISOString()
      }
    };

    this.requests.set(request.payload.requestId, request);

    // Send notifications
    if (this.notificationHandler) {
      await this.notificationHandler.notifyApprovers(request);
    }

    return request;
  }

  /**
   * Add an approval decision
   */
  async addDecision(requestId, decision) {
    const {
      approverId,
      approverRole,
      action,
      comment,
      conditions
    } = decision;

    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    if (request.payload.status !== 'pending') {
      throw new Error(`Request is no longer pending: ${request.payload.status}`);
    }

    // Validate approver role
    if (!request.payload.approverRoles.includes(approverRole)) {
      throw new Error(`Approver role ${approverRole} is not authorized`);
    }

    // Check if approver already decided
    const existingDecision = request.payload.decisions.find(d => d.approverId === approverId);
    if (existingDecision) {
      throw new Error(`Approver ${approverId} has already made a decision`);
    }

    // Add decision
    const decisionEntry = {
      decisionId: crypto.randomUUID(),
      approverId,
      approverRole,
      action,
      timestamp: new Date().toISOString(),
      comment,
      conditions
    };

    request.payload.decisions.push(decisionEntry);

    // Check if resolved
    this.checkResolution(request);

    return decisionEntry;
  }

  /**
   * Check if request is resolved
   */
  checkResolution(request) {
    const approvals = request.payload.decisions.filter(d => d.action === 'approve');
    const rejections = request.payload.decisions.filter(d => d.action === 'reject');

    // Rejected if any rejection
    if (rejections.length > 0) {
      request.payload.status = 'rejected';
      request.payload.resolvedAt = new Date().toISOString();
      request.payload.resolvedBy = rejections[0].approverId;
      return 'rejected';
    }

    // Approved if enough approvals
    if (approvals.length >= request.payload.requiredApprovers) {
      request.payload.status = 'approved';
      request.payload.resolvedAt = new Date().toISOString();
      request.payload.resolvedBy = approvals[approvals.length - 1].approverId;
      return 'approved';
    }

    return 'pending';
  }

  /**
   * Get a request by ID
   */
  getRequest(requestId) {
    return this.requests.get(requestId);
  }

  /**
   * Get pending requests for an approver
   */
  getPendingForApprover(approverRole) {
    return Array.from(this.requests.values())
      .filter(r =>
        r.payload.status === 'pending' &&
        r.payload.approverRoles.includes(approverRole) &&
        !r.payload.decisions.some(d => d.approverRole === approverRole)
      );
  }

  /**
   * Get all requests for an artifact
   */
  getRequestsForArtifact(artifactId) {
    return Array.from(this.requests.values())
      .filter(r => r.payload.artifactId === artifactId);
  }

  /**
   * Cancel a request
   */
  cancelRequest(requestId, cancelledBy, reason) {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Approval request not found: ${requestId}`);
    }

    if (request.payload.status !== 'pending') {
      throw new Error(`Cannot cancel request with status: ${request.payload.status}`);
    }

    // Only requester or admin can cancel
    if (request.payload.requestedBy !== cancelledBy) {
      // Would check for admin role in real implementation
    }

    request.payload.status = 'cancelled';
    request.payload.resolvedAt = new Date().toISOString();
    request.payload.resolvedBy = cancelledBy;

    // Add cancellation as a decision
    request.payload.decisions.push({
      decisionId: crypto.randomUUID(),
      approverId: cancelledBy,
      approverRole: 'requester',
      action: 'abstain',
      timestamp: new Date().toISOString(),
      comment: reason || 'Request cancelled'
    });

    return request;
  }

  /**
   * Check for expired requests
   */
  checkExpiredRequests() {
    const now = new Date();
    const expired = [];

    for (const request of this.requests.values()) {
      if (request.payload.status === 'pending' &&
          request.payload.deadline &&
          new Date(request.payload.deadline) < now) {
        request.payload.status = 'expired';
        request.payload.resolvedAt = now.toISOString();
        expired.push(request);
      }
    }

    return expired;
  }

  /**
   * Get statistics
   */
  getStats() {
    const all = Array.from(this.requests.values());
    return {
      total: all.length,
      pending: all.filter(r => r.payload.status === 'pending').length,
      approved: all.filter(r => r.payload.status === 'approved').length,
      rejected: all.filter(r => r.payload.status === 'rejected').length,
      cancelled: all.filter(r => r.payload.status === 'cancelled').length,
      expired: all.filter(r => r.payload.status === 'expired').length
    };
  }
}

// Singleton instance
let workflowInstance = null;

/**
 * Get the global approval workflow instance
 */
export function getApprovalWorkflow() {
  if (!workflowInstance) {
    workflowInstance = new ApprovalWorkflow();
  }
  return workflowInstance;
}

/**
 * Create an approval request
 */
export async function requestApproval(artifact, options) {
  return getApprovalWorkflow().createRequest(artifact, options);
}

/**
 * Add an approval decision
 */
export async function addApprovalDecision(requestId, decision) {
  return getApprovalWorkflow().addDecision(requestId, decision);
}

// Register schemas on load
try {
  registerSchema(SchemaIds.APPROVAL_REQUEST, '1.0.0', ApprovalRequestEnvelopeSchema);
} catch (e) {
  // Already registered
}

export default ApprovalWorkflow;
