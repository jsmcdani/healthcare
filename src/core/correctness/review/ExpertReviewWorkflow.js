/**
 * ExpertReviewWorkflow - Manages the expert review process
 *
 * Routes outputs requiring review to appropriate experts,
 * tracks review status, and handles escalations.
 */

import { Logger } from '../../../utils/logger.js';
import {
  createExpertReviewRequest,
  recordReviewerDecision,
  waiveReview,
  expireReview,
  ReviewStatus,
  ReviewDecision,
  ReviewerRole,
  UrgencyLevel
} from './ExpertReviewEnvelope.js';
import { ReviewTriggerEvaluator } from './ReviewTriggerEvaluator.js';

/**
 * Review queue management
 */
export class ReviewQueue {
  constructor() {
    this.reviews = new Map();
    this.byStatus = new Map();
    this.byRole = new Map();
    this.byArtifact = new Map();

    // Initialize status indices
    for (const status of Object.values(ReviewStatus)) {
      this.byStatus.set(status, new Set());
    }
  }

  add(reviewEnvelope) {
    const reviewId = reviewEnvelope.payload.reviewId;
    const status = reviewEnvelope.payload.outcome.status;
    const role = reviewEnvelope.payload.requirements.reviewerRole;
    const artifactId = reviewEnvelope.payload.target.artifactId;

    this.reviews.set(reviewId, reviewEnvelope);
    this.byStatus.get(status)?.add(reviewId);

    if (!this.byRole.has(role)) {
      this.byRole.set(role, new Set());
    }
    this.byRole.get(role).add(reviewId);

    if (!this.byArtifact.has(artifactId)) {
      this.byArtifact.set(artifactId, new Set());
    }
    this.byArtifact.get(artifactId).add(reviewId);
  }

  get(reviewId) {
    return this.reviews.get(reviewId);
  }

  updateStatus(reviewId, oldStatus, newStatus) {
    this.byStatus.get(oldStatus)?.delete(reviewId);
    this.byStatus.get(newStatus)?.add(reviewId);
  }

  getByStatus(status) {
    const ids = this.byStatus.get(status) || new Set();
    return Array.from(ids).map(id => this.reviews.get(id)).filter(Boolean);
  }

  getByRole(role) {
    const ids = this.byRole.get(role) || new Set();
    return Array.from(ids).map(id => this.reviews.get(id)).filter(Boolean);
  }

  getByArtifact(artifactId) {
    const ids = this.byArtifact.get(artifactId) || new Set();
    return Array.from(ids).map(id => this.reviews.get(id)).filter(Boolean);
  }

  getPending() {
    return [
      ...this.getByStatus(ReviewStatus.PENDING),
      ...this.getByStatus(ReviewStatus.IN_REVIEW)
    ];
  }

  remove(reviewId) {
    const review = this.reviews.get(reviewId);
    if (!review) return;

    const status = review.payload.outcome.status;
    const role = review.payload.requirements.reviewerRole;
    const artifactId = review.payload.target.artifactId;

    this.reviews.delete(reviewId);
    this.byStatus.get(status)?.delete(reviewId);
    this.byRole.get(role)?.delete(reviewId);
    this.byArtifact.get(artifactId)?.delete(reviewId);
  }
}

/**
 * Expert Review Workflow Manager
 */
export class ExpertReviewWorkflow {
  constructor(options = {}) {
    this.logger = new Logger('ExpertReviewWorkflow');
    this.queue = new ReviewQueue();
    this.triggerEvaluator = new ReviewTriggerEvaluator(options.triggerConfig);
    this.completedReviews = [];
    this.maxCompletedHistory = options.maxCompletedHistory || 1000;

    // Notification callback
    this.onReviewCreated = options.onReviewCreated;
    this.onReviewCompleted = options.onReviewCompleted;
    this.onReviewEscalated = options.onReviewEscalated;

    // Deadline checker
    this.deadlineCheckInterval = options.deadlineCheckInterval || 60000; // 1 minute
    this.deadlineChecker = null;
  }

  /**
   * Start the workflow (begin deadline checking)
   */
  start() {
    if (!this.deadlineChecker) {
      this.deadlineChecker = setInterval(() => {
        this.checkDeadlines();
      }, this.deadlineCheckInterval);
    }
    this.logger.info('Expert review workflow started');
  }

  /**
   * Stop the workflow
   */
  stop() {
    if (this.deadlineChecker) {
      clearInterval(this.deadlineChecker);
      this.deadlineChecker = null;
    }
    this.logger.info('Expert review workflow stopped');
  }

  /**
   * Evaluate if review is needed and create request if so
   */
  async evaluateAndCreateReview(context) {
    const evaluation = this.triggerEvaluator.evaluate(context);

    if (!evaluation.requiresReview) {
      return null;
    }

    return this.createReviewRequest({
      target: {
        artifactId: context.artifact?.id || context.artifactId,
        correctnessEnvelopeId: context.correctnessEnvelope?.header?.envelopeId,
        specificConcern: evaluation.triggers.map(t => t.type).join(', '),
        outputSnapshot: context.artifact?.output || context.output
      },
      trigger: evaluation.toTrigger(),
      reviewerRole: evaluation.suggestedRole,
      urgency: evaluation.suggestedUrgency,
      ...context.reviewOptions
    });
  }

  /**
   * Create a review request directly
   */
  async createReviewRequest(options) {
    const reviewEnvelope = createExpertReviewRequest(options);

    // Add to queue
    this.queue.add(reviewEnvelope);

    this.logger.info('Review request created', {
      reviewId: reviewEnvelope.payload.reviewId,
      artifactId: options.target.artifactId,
      triggerType: options.trigger.type,
      reviewerRole: options.reviewerRole,
      urgency: options.urgency
    });

    // Notify
    if (this.onReviewCreated) {
      try {
        await this.onReviewCreated(reviewEnvelope);
      } catch (error) {
        this.logger.warn('Review creation notification failed', { error: error.message });
      }
    }

    return reviewEnvelope;
  }

  /**
   * Get review by ID
   */
  getReview(reviewId) {
    return this.queue.get(reviewId);
  }

  /**
   * Get pending reviews for a role
   */
  getPendingReviewsForRole(role) {
    return this.queue.getByRole(role)
      .filter(r =>
        r.payload.outcome.status === ReviewStatus.PENDING ||
        r.payload.outcome.status === ReviewStatus.IN_REVIEW
      )
      .sort((a, b) => b.payload.priorityScore - a.payload.priorityScore);
  }

  /**
   * Get reviews for an artifact
   */
  getReviewsForArtifact(artifactId) {
    return this.queue.getByArtifact(artifactId);
  }

  /**
   * Claim a review (mark as in_review)
   */
  claimReview(reviewId, reviewerId) {
    const review = this.queue.get(reviewId);
    if (!review) {
      throw new Error(`Review not found: ${reviewId}`);
    }

    if (review.payload.outcome.status !== ReviewStatus.PENDING) {
      throw new Error(`Review cannot be claimed in status: ${review.payload.outcome.status}`);
    }

    const oldStatus = review.payload.outcome.status;
    review.payload.outcome.status = ReviewStatus.IN_REVIEW;
    this.queue.updateStatus(reviewId, oldStatus, ReviewStatus.IN_REVIEW);

    this.logger.info('Review claimed', { reviewId, reviewerId });

    return review;
  }

  /**
   * Submit a review decision
   */
  async submitReviewDecision(reviewId, decision) {
    const review = this.queue.get(reviewId);
    if (!review) {
      throw new Error(`Review not found: ${reviewId}`);
    }

    const oldStatus = review.payload.outcome.status;

    // Record the decision
    recordReviewerDecision(review, decision);

    const newStatus = review.payload.outcome.status;

    // Update queue if status changed
    if (oldStatus !== newStatus) {
      this.queue.updateStatus(reviewId, oldStatus, newStatus);
    }

    this.logger.info('Review decision submitted', {
      reviewId,
      reviewerId: decision.reviewerId,
      decision: decision.decisionValue,
      status: newStatus
    });

    // Handle completion
    if (this.isReviewComplete(review)) {
      await this.handleReviewCompletion(review);
    }

    // Handle escalation
    if (decision.decisionValue === ReviewDecision.ESCALATE) {
      await this.handleEscalation(review, decision);
    }

    return review;
  }

  /**
   * Check if review is complete
   */
  isReviewComplete(review) {
    const status = review.payload.outcome.status;
    return [
      ReviewStatus.APPROVED,
      ReviewStatus.REJECTED,
      ReviewStatus.MODIFIED,
      ReviewStatus.ESCALATED,
      ReviewStatus.WAIVED,
      ReviewStatus.EXPIRED
    ].includes(status);
  }

  /**
   * Handle review completion
   */
  async handleReviewCompletion(review) {
    const reviewId = review.payload.reviewId;

    // Move to completed history
    this.completedReviews.push(review);
    if (this.completedReviews.length > this.maxCompletedHistory) {
      this.completedReviews.shift();
    }

    // Notify
    if (this.onReviewCompleted) {
      try {
        await this.onReviewCompleted(review);
      } catch (error) {
        this.logger.warn('Review completion notification failed', { error: error.message });
      }
    }

    this.logger.info('Review completed', {
      reviewId,
      finalDecision: review.payload.outcome.finalDecision,
      status: review.payload.outcome.status
    });
  }

  /**
   * Handle escalation
   */
  async handleEscalation(review, decision) {
    // Determine escalation target
    const escalationRole = this.getEscalationRole(review.payload.requirements.reviewerRole);

    // Create escalation review
    const escalationReview = await this.createReviewRequest({
      target: review.payload.target,
      trigger: {
        type: 'manual_request',
        details: `Escalated from review ${review.payload.reviewId}: ${decision.rationale || 'No rationale provided'}`
      },
      reviewerRole: escalationRole,
      urgency: UrgencyLevel.URGENT,
      parentReviewId: review.payload.reviewId
    });

    review.payload.outcome.escalatedTo = escalationReview.payload.reviewId;

    // Notify
    if (this.onReviewEscalated) {
      try {
        await this.onReviewEscalated(review, escalationReview);
      } catch (error) {
        this.logger.warn('Escalation notification failed', { error: error.message });
      }
    }

    this.logger.info('Review escalated', {
      originalReviewId: review.payload.reviewId,
      escalationReviewId: escalationReview.payload.reviewId,
      escalationRole
    });

    return escalationReview;
  }

  /**
   * Get escalation role
   */
  getEscalationRole(currentRole) {
    const escalationPath = {
      [ReviewerRole.NURSE_SPECIALIST]: ReviewerRole.PHYSICIAN,
      [ReviewerRole.CLINICAL_PHARMACIST]: ReviewerRole.PHYSICIAN,
      [ReviewerRole.PHYSICIAN]: ReviewerRole.MEDICAL_DIRECTOR,
      [ReviewerRole.DOMAIN_EXPERT]: ReviewerRole.MEDICAL_DIRECTOR,
      [ReviewerRole.COMPLIANCE_OFFICER]: ReviewerRole.SUPERVISOR,
      [ReviewerRole.SUPERVISOR]: ReviewerRole.MEDICAL_DIRECTOR
    };

    return escalationPath[currentRole] || ReviewerRole.MEDICAL_DIRECTOR;
  }

  /**
   * Waive a review
   */
  async waiveReviewRequest(reviewId, waiverId, reason) {
    const review = this.queue.get(reviewId);
    if (!review) {
      throw new Error(`Review not found: ${reviewId}`);
    }

    const oldStatus = review.payload.outcome.status;
    waiveReview(review, waiverId, reason);
    this.queue.updateStatus(reviewId, oldStatus, ReviewStatus.WAIVED);

    this.logger.info('Review waived', { reviewId, waiverId, reason });

    await this.handleReviewCompletion(review);

    return review;
  }

  /**
   * Check and expire overdue reviews
   */
  checkDeadlines() {
    const now = new Date();
    const pending = this.queue.getPending();

    for (const review of pending) {
      const deadline = review.payload.requirements.deadline;
      if (deadline && new Date(deadline) < now) {
        const oldStatus = review.payload.outcome.status;
        expireReview(review);
        this.queue.updateStatus(review.payload.reviewId, oldStatus, ReviewStatus.EXPIRED);

        this.logger.warn('Review expired', {
          reviewId: review.payload.reviewId,
          deadline
        });
      }
    }
  }

  /**
   * Get review statistics
   */
  getStats() {
    const pending = this.queue.getByStatus(ReviewStatus.PENDING).length;
    const inReview = this.queue.getByStatus(ReviewStatus.IN_REVIEW).length;
    const completed = this.completedReviews.length;

    const byRole = {};
    for (const role of Object.values(ReviewerRole)) {
      byRole[role] = this.queue.getByRole(role)
        .filter(r => r.payload.outcome.status === ReviewStatus.PENDING)
        .length;
    }

    const recentCompletions = this.completedReviews.slice(-100);
    const approvalRate = recentCompletions.length > 0
      ? recentCompletions.filter(r => r.payload.outcome.finalDecision === ReviewDecision.APPROVE).length / recentCompletions.length
      : 0;

    return {
      pending,
      inReview,
      completed,
      total: pending + inReview,
      byRole,
      approvalRate,
      averageTimeToCompletion: this.calculateAverageCompletionTime()
    };
  }

  /**
   * Calculate average completion time
   */
  calculateAverageCompletionTime() {
    const completed = this.completedReviews.filter(r => r.payload.outcome.completedAt);

    if (completed.length === 0) return null;

    let totalMs = 0;
    for (const review of completed) {
      const start = new Date(review.payload.requestedAt);
      const end = new Date(review.payload.outcome.completedAt);
      totalMs += end - start;
    }

    return totalMs / completed.length;
  }
}

export default ExpertReviewWorkflow;
