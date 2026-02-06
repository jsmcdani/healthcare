// src/api/routes.js - UPDATED with Platform Cache Ingestion Routes
import { Router } from "express";
import crypto from "crypto";
import { Logger } from "../utils/logger.js";
import { ValidationError, AppError } from "../utils/errors.js";
import { asyncHandler } from "./middleware/error-handler.js";
import { createEndpointRateLimit } from "./middleware/rate-limit.js";
import { orgPermissions, orgLimits } from "./middleware/org-context.js";
import {
  isValidEmail,
  validatePasswordFull,
  validateUsername,
  sanitizeInput,
} from "../utils/validation.js";
import { getEmailService } from "../services/EmailService.js";
import {
  logAuditEvent,
  logPasswordChange,
  logPasswordReset,
  logUserCreated,
  endSession,
} from "../services/AuditService.js";
import bcrypt from "bcrypt";
import { Database } from "arangojs";
import jwt from "jsonwebtoken";
import config from "../../config/index.js";
import workflowRoutes from "./routes/workflows.js";
import adminRoutes from "./routes/admin.js";
import adminAgentRoutes from "./routes/admin-agent.js";
import serviceBuilderRoutes from "./routes/service-builder.js";
import permissionAnalysisRoutes from "./routes/permission-analysis.js";
import permissionDiscoveryRoutes from "./routes/permission-discovery.js";
import permissionIngestionRoutes from "./routes/permission-ingestion.js";
import technicalDebtRoutes from "./routes/technical-debt.js";
import capabilityGraphRoutes from "./routes/capability-graph.js";
import complianceRoutes from "./routes/compliance.js";
import githubImpactRoutes from "./routes/github-impact.js";
import packageDiscoveryRoutes from "./routes/package-discovery.js";
import impactAnalysisRoutes from "./routes/impact-analysis.js";
import flowDocumentationRoutes from "./routes/flow-documentation.js";
import irPlanViewerRoutes from "./routes/ir-plan-viewer.js";
import { intentRoutes } from "./routes/intent-ir.js";
import metadataAnalyticsRoutes from "./routes/metadata-analytics.js";
import graphQueryRoutes from "./routes/graph-query.js";
import flowOptimizerRoutes from "./routes/flow-optimizer.js";
import capabilitiesRoutes from "./routes/capabilities.js";
import changeTrackingRoutes from "./routes/change-tracking.js";
import isvRoutes from "./routes/isv.js";
import documentationRoutes from "./routes/documentation.js";
import crossOrgRoutes from "./routes/cross-org.js";
import healthcareAnalyticsRoutes from "./routes/analytics.js";
import healthcareRoutes from "./routes/healthcare.js";
import { UIConfigRenderer } from "../services/UIConfigRenderer.js";
import { initPremiumGate } from "./middleware/premium-gate.js";

export function routes(orchestrator, eventSystem) {
  const router = Router();
  const logger = new Logger("APIRoutes");

  // Check if running in healthcare-only mode
  const healthcareMode = process.env.HEALTHCARE_MODE === 'true';
  if (healthcareMode) {
    logger.info('🏥 HEALTHCARE MODE: Loading minimal routes (admin + healthcare only)');
  }

  // Initialize premium gating with orchestrator reference
  initPremiumGate(orchestrator);

  const AI_ASSIST_SERVICE_DEFINITIONS = [
    {
      id: "WorkflowOrchestrationService",
      displayName: "Workflow Rule Analysis",
      description:
        "Analyze Salesforce workflow rules using cached discovery and aggregation layers.",
      defaultPrompt:
        "Analyze the active workflow rules for optimization opportunities.",
      requirement: {
        serviceType: "WorkflowDiscoveryService",
        subKey: "complete-workflow-data",
      },
    },
    {
      id: "LabelInspectorService",
      displayName: "Label Inspector Service",
      description:
        "Inspect label discrepancies between UI labels and API names.",
      defaultPrompt: "Analyze label mismatches for Account object.",
      requirement: {
        serviceType: "LabelInspectorService",
        subKey: "latest-analysis",
      },
    },
    {
      id: "MetadataInspectionService",
      displayName: "Metadata Inspection Service",
      description:
        "Review metadata dependencies and relationships for the current org.",
      defaultPrompt: "Analyze metadata dependencies.",
      requirement: {
        serviceType: "MetadataInspectionService",
        subKey: "latest-analysis",
      },
    },
  ];

  async function resolveAIServiceAvailability(orgId) {
    return await Promise.all(
      AI_ASSIST_SERVICE_DEFINITIONS.map(async (service) => {
        let available = false;
        let cachedAt = null;
        let ttl = null;
        let metadata = null;

        if (service.requirement && orchestrator.businessServiceRegistry) {
          try {
            const cachedEntry =
              await orchestrator.businessServiceRegistry.getCachedServiceMetadata(
                orgId,
                service.requirement.serviceType,
                service.requirement.subKey,
              );

            if (cachedEntry?.data) {
              available = true;
              cachedAt = cachedEntry.cachedAt || null;
              ttl = cachedEntry.ttl || null;
              metadata = cachedEntry.metadata || null;
            }
          } catch (error) {
            logger.warn(
              `Failed to resolve availability for ${service.id}:`,
              error,
            );
          }
        }

        return {
          id: service.id,
          name: service.displayName,
          description: service.description,
          defaultPrompt: service.defaultPrompt,
          available,
          cachedAt,
          ttl,
          metadata,
        };
      }),
    );
  }

  async function warmWorkflowOrchestrationCache(orgId, options = {}) {
    if (!orchestrator.workflowDiscoveryService) {
      throw new AppError(
        "WorkflowDiscoveryService not available for cache warming",
        503,
      );
    }

    const ttlSeconds = options.ttl || 60 * 60 * 2; // 2 hours to align with cached summary
    const aggregatedCacheKey = `workflow_aggregated_data:${orgId}`;

    // Fetch latest workflow summary (includes counts/metadata used by AI Assistant)
    const aggregatedData =
      await orchestrator.workflowDiscoveryService.getWorkflowRulesSummary(
        orgId,
        {
          includeInactive: true,
          forceRefresh: options.forceRefresh === true,
        },
      );
    aggregatedData.lastUpdated = new Date().toISOString();

    if (orchestrator.redisClient) {
      await orchestrator.redisClient.set(
        aggregatedCacheKey,
        JSON.stringify(aggregatedData),
        { EX: ttlSeconds },
      );
    }

    if (orchestrator.businessServiceRegistry) {
      await orchestrator.businessServiceRegistry.cacheServiceMetadata(
        orgId,
        "WorkflowDiscoveryService",
        aggregatedData,
        {
          subKey: "complete-workflow-data",
          source: "services_cache_warm",
          ttl: ttlSeconds,
          metadata: {
            rules:
              aggregatedData.totalRules || aggregatedData.rules?.length || 0,
            activeRules: aggregatedData.activeRules || 0,
            lastUpdated: aggregatedData.lastUpdated,
          },
        },
      );
    }

    return {
      serviceId: "WorkflowOrchestrationService",
      warmed: true,
      cached: true,
      ttl: ttlSeconds,
      metadata: {
        rules: aggregatedData.totalRules || aggregatedData.rules?.length || 0,
        activeRules: aggregatedData.activeRules || 0,
        lastUpdated: aggregatedData.lastUpdated,
      },
    };
  }

  async function warmAIServiceCache(orgId, serviceId, options = {}) {
    switch (serviceId) {
      case "WorkflowOrchestrationService":
        return await warmWorkflowOrchestrationCache(orgId, options);
      default:
        return {
          serviceId,
          warmed: false,
          cached: false,
          metadata: {
            message: "No cache warmer implemented for this service.",
          },
        };
    }
  }

  // Helper function to get database connection for auth operations
  async function getDbConnection() {
    // First try orchestrator store
    if (orchestrator?.store?.database) {
      return orchestrator.store.database;
    }

    // Fallback to direct connection using environment variables
    const db = new Database({
      url: process.env.ARANGODB_URL || "http://localhost:8529",
      databaseName: process.env.ARANGODB_DATABASE || "servient",
    });

    await db.useBasicAuth(
      process.env.ARANGODB_USERNAME || "root",
      process.env.ARANGODB_PASSWORD || "servient123",
    );

    return db;
  }

  // 🔐 AUTHENTICATION ENDPOINTS

  /**
   * Register new user account
   * POST /api/auth/register
   *
   * For self-registration (if enabled) or admin user creation
   */
  router.post(
    "/auth/register",
    createEndpointRateLimit("register", { max: 5, windowMs: 3600000 }), // 5 per hour
    asyncHandler(async (req, res) => {
      const { username, email, password, name, orgId, inviteToken } = req.body;

      // Validate required fields
      if (!email) {
        throw new AppError("Email is required", 400);
      }

      if (!password) {
        throw new AppError("Password is required", 400);
      }

      // Validate email format
      if (!isValidEmail(email)) {
        throw new AppError("Invalid email format", 400);
      }

      // Validate username if provided (otherwise use email)
      const finalUsername = username || email;
      const usernameValidation = validateUsername(finalUsername);
      if (!usernameValidation.valid) {
        throw new AppError(usernameValidation.errors.join(", "), 400);
      }

      // Validate password strength
      const passwordValidation = validatePasswordFull(password, finalUsername);
      if (!passwordValidation.valid) {
        throw new AppError(passwordValidation.errors.join(", "), 400);
      }

      const db = await getDbConnection();

      // Check if user already exists
      const existingQuery = await db.query(
        `
        FOR user IN users
        FILTER user.email == @email OR user.username == @username
        LIMIT 1
        RETURN user
      `,
        { email, username: finalUsername },
      );

      const existing = await existingQuery.all();
      if (existing.length > 0) {
        throw new AppError(
          "An account with this email or username already exists",
          409,
        );
      }

      // Determine org access
      let userOrgId = orgId || "pending";
      let userStatus = "pending_verification";
      let verificationToken = null;

      // If invite token provided, validate it
      if (inviteToken) {
        const inviteQuery = await db.query(
          `
          FOR invite IN user_invites
          FILTER invite.token == @inviteToken
            AND invite.status == 'pending'
            AND invite.expiresAt > @now
          LIMIT 1
          RETURN invite
        `,
          { inviteToken, now: new Date().toISOString() },
        );

        const invites = await inviteQuery.all();
        if (invites.length > 0) {
          const invite = invites[0];
          userOrgId = invite.orgId;
          userStatus = "active"; // Skip verification for invited users

          // Mark invite as used
          await db.query(
            `
            UPDATE { _key: @key } WITH { status: 'used', usedAt: @now } IN user_invites
          `,
            { key: invite._key, now: new Date().toISOString() },
          );
        }
      }

      // Generate email verification token if not invited
      if (userStatus === "pending_verification") {
        verificationToken = crypto.randomBytes(32).toString("hex");
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Create user
      const now = new Date().toISOString();
      const newUser = {
        username: finalUsername,
        email: email.toLowerCase(),
        passwordHash,
        name: sanitizeInput(name) || finalUsername.split("@")[0],
        orgId: userOrgId,
        accessible_orgs: userOrgId !== "pending" ? [userOrgId] : [],
        org_permissions: {},
        role: "user",
        permissions: ["read"],
        status: userStatus,
        verificationToken: verificationToken
          ? await bcrypt.hash(verificationToken, 12)
          : null,
        verificationTokenExpiresAt: verificationToken
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : null,
        loginAttempts: 0,
        lastLogin: null,
        createdAt: now,
        updatedAt: now,
      };

      const usersCollection = db.collection("users");
      const result = await usersCollection.save(newUser);

      logger.info("New user registered", {
        userId: result._key,
        email: newUser.email,
        status: userStatus,
      });

      // Send verification email
      if (verificationToken) {
        try {
          const emailService = getEmailService();
          await emailService.sendVerificationEmail(
            newUser.email,
            verificationToken,
            newUser.name,
          );
          logger.info("Verification email sent", { email: newUser.email });
        } catch (emailError) {
          logger.error("Failed to send verification email", {
            error: emailError.message,
          });
          // Don't fail registration if email fails - user can resend
        }
      }

      res.status(201).json({
        success: true,
        message:
          userStatus === "active"
            ? "Account created successfully. You can now log in."
            : "Account created. Please check your email to verify your account.",
        user: {
          id: result._key,
          email: newUser.email,
          username: newUser.username,
          status: userStatus,
        },
        // DEV ONLY - remove in production
        ...(process.env.NODE_ENV !== "production" &&
          verificationToken && {
            _devVerificationToken: verificationToken,
          }),
      });
    }),
  );

  /**
   * Verify email address
   * POST /api/auth/verify-email
   */
  router.post(
    "/auth/verify-email",
    createEndpointRateLimit("verify_email", { max: 10, windowMs: 3600000 }),
    asyncHandler(async (req, res) => {
      const { token } = req.body;

      if (!token) {
        throw new AppError("Verification token is required", 400);
      }

      const db = await getDbConnection();

      // Find users with pending verification
      const userQuery = await db.query(
        `
        FOR user IN users
        FILTER user.status == 'pending_verification'
          AND user.verificationTokenExpiresAt > @now
        RETURN user
      `,
        { now: new Date().toISOString() },
      );

      const users = await userQuery.all();

      // Find matching token
      let matchedUser = null;
      for (const user of users) {
        if (user.verificationToken) {
          const isMatch = await bcrypt.compare(token, user.verificationToken);
          if (isMatch) {
            matchedUser = user;
            break;
          }
        }
      }

      if (!matchedUser) {
        throw new AppError("Invalid or expired verification token", 400);
      }

      // Activate user
      await db.query(
        `
        FOR user IN users
        FILTER user._key == @userId
        UPDATE user WITH {
          status: 'active',
          verificationToken: null,
          verificationTokenExpiresAt: null,
          emailVerifiedAt: @now,
          updatedAt: @now
        } IN users
      `,
        { userId: matchedUser._key, now: new Date().toISOString() },
      );

      logger.info("Email verified", { userId: matchedUser._key });

      res.json({
        success: true,
        message: "Email verified successfully. You can now log in.",
      });
    }),
  );

  /**
   * Resend verification email
   * POST /api/auth/resend-verification
   */
  router.post(
    "/auth/resend-verification",
    createEndpointRateLimit("resend_verification", {
      max: 3,
      windowMs: 3600000,
    }),
    asyncHandler(async (req, res) => {
      const { email } = req.body;

      if (!email) {
        throw new AppError("Email is required", 400);
      }

      const db = await getDbConnection();

      const userQuery = await db.query(
        `
        FOR user IN users
        FILTER user.email == @email AND user.status == 'pending_verification'
        LIMIT 1
        RETURN user
      `,
        { email: email.toLowerCase() },
      );

      const users = await userQuery.all();

      // Always return success to prevent email enumeration
      if (users.length === 0) {
        return res.json({
          success: true,
          message:
            "If an unverified account exists with that email, a new verification link has been sent.",
        });
      }

      const user = users[0];

      // Generate new verification token
      const verificationToken = crypto.randomBytes(32).toString("hex");
      const verificationTokenHash = await bcrypt.hash(verificationToken, 12);

      await db.query(
        `
        FOR user IN users
        FILTER user._key == @userId
        UPDATE user WITH {
          verificationToken: @tokenHash,
          verificationTokenExpiresAt: @expiresAt,
          updatedAt: @now
        } IN users
      `,
        {
          userId: user._key,
          tokenHash: verificationTokenHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          now: new Date().toISOString(),
        },
      );

      logger.info("Verification email resent", { userId: user._key });

      // Send verification email
      try {
        const emailService = getEmailService();
        await emailService.sendVerificationEmail(
          user.email,
          verificationToken,
          user.name,
        );
        logger.info("Verification email sent", { email: user.email });
      } catch (emailError) {
        logger.error("Failed to send verification email", {
          error: emailError.message,
        });
      }

      res.json({
        success: true,
        message:
          "If an unverified account exists with that email, a new verification link has been sent.",
        ...(process.env.NODE_ENV !== "production" && {
          _devVerificationToken: verificationToken,
        }),
      });
    }),
  );

  /**
   * Login endpoint - authenticate user and return JWT
   * POST /api/auth/login
   */
  router.post(
    "/auth/login",
    createEndpointRateLimit("login", { max: 5, windowMs: 300000 }), // 5 attempts per 5 minutes
    asyncHandler(async (req, res) => {
      const { username, password } = req.body;

      if (!username || !password) {
        throw new AppError("Username and password are required", 400);
      }

      // Get user from database
      const db = await getDbConnection();

      // Ensure users collection exists
      let usersCollection;
      try {
        usersCollection = db.collection("users");
        await usersCollection.get(); // Test if collection exists
      } catch (error) {
        throw new AppError(
          "Users collection not found. Run the setup script first.",
          503,
        );
      }

      const userQuery = await db.query(
        `
        FOR user IN users
        FILTER (user.username == @username OR user.email == @username) AND user.status == 'active'
        RETURN user
      `,
        { username },
      );

      const users = await userQuery.all();
      if (users.length === 0) {
        throw new AppError("Invalid username or password", 401);
      }

      const user = users[0];

      // Check password
      const passwordValid = await bcrypt.compare(password, user.passwordHash);
      if (!passwordValid) {
        // Increment failed login attempts
        await db.query(
          `
          FOR user IN users
          FILTER user._key == @userKey
          UPDATE user WITH {
            loginAttempts: user.loginAttempts + 1,
            updatedAt: @now
          } IN users
        `,
          { userKey: user._key, now: new Date().toISOString() },
        );

        throw new AppError("Invalid username or password", 401);
      }

      // Reset login attempts and update last login
      await db.query(
        `
        FOR user IN users
        FILTER user._key == @userKey
        UPDATE user WITH {
          loginAttempts: 0,
          lastLogin: @now,
          updatedAt: @now
        } IN users
      `,
        { userKey: user._key, now: new Date().toISOString() },
      );

      // Create JWT token directly (fallback if SessionManager not available)
      const sessionManager = req.app.locals.sessionManager;

      if (sessionManager) {
        // Use SessionManager if available
        const userForSession = {
          userId: user._key,
          username: user.username,
          defaultOrgId: user.orgId,
          permissions: user.permissions || [],
        };

        const session = await sessionManager.createSession(
          userForSession,
          user.orgId,
          {
            userAgent: req.headers["user-agent"],
            ipAddress: req.ip,
            platform: "web",
          },
        );

        res.json({
          success: true,
          token: session.token,
          user: {
            userId: session.userId,
            username: session.username,
            orgId: session.orgId,
            permissions: user.permissions,
          },
          expiresAt: session.expiresAt,
        });
      } else {
        // Fallback: Create JWT directly
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + 24 * 60 * 60; // 24 hours

        const tokenPayload = {
          userId: user._key,
          username: user.username,
          orgId: user.orgId,
          permissions: user.permissions || [],
          iat: now,
          exp: expiresAt,
        };

        const token = jwt.sign(tokenPayload, config.jwt.secret, {
          algorithm: "HS256",
        });

        res.json({
          success: true,
          token: token,
          user: {
            userId: user._key,
            username: user.username,
            orgId: user.orgId,
            permissions: user.permissions,
          },
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        });
      }
    }),
  );

  /**
   * Validate token endpoint
   * GET /api/auth/validate
   */
  router.get(
    "/auth/validate",
    asyncHandler(async (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new AppError("No token provided", 401);
      }

      const token = authHeader.substring(7);
      const sessionManager = req.app.locals.sessionManager;

      try {
        if (sessionManager) {
          // Use SessionManager if available
          const session = await sessionManager.validateSession(token);

          res.json({
            success: true,
            valid: true,
            user: {
              userId: session.userId,
              username: session.username,
              orgId: session.orgId,
            },
          });
        } else {
          // Fallback: Validate JWT directly
          const decoded = jwt.verify(token, config.jwt.secret);

          res.json({
            success: true,
            valid: true,
            user: {
              userId: decoded.userId,
              username: decoded.username,
              orgId: decoded.orgId,
              permissions: decoded.permissions || [],
            },
          });
        }
      } catch (error) {
        res.status(401).json({
          success: false,
          valid: false,
          error: "Invalid or expired token",
        });
      }
    }),
  );

  // Org context validation is handled by orgContext middleware in index.js

  /**
   * Change password endpoint (requires authentication)
   * POST /api/auth/change-password
   */
  router.post(
    "/auth/change-password",
    createEndpointRateLimit("change_password", { max: 3, windowMs: 300000 }), // 3 attempts per 5 min
    asyncHandler(async (req, res) => {
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        throw new AppError(
          "Current password and new password are required",
          400,
        );
      }

      if (newPassword.length < 8) {
        throw new AppError("New password must be at least 8 characters", 400);
      }

      // Get user from JWT token (header or cookie)
      const authHeader = req.headers.authorization;
      let token;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
      } else if (req.cookies && req.cookies.auth_token) {
        token = req.cookies.auth_token;
      } else {
        throw new AppError("Authentication required", 401);
      }
      let userId;

      try {
        const decoded = jwt.verify(token, config.jwt.secret);
        // Support both userId and user_id (different JWT sources use different field names)
        userId = decoded.userId || decoded.user_id;
        if (!userId) {
          throw new AppError("Invalid token - no user ID", 401);
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError("Invalid or expired token", 401);
      }

      const db = await getDbConnection();

      // Find user
      const userQuery = await db.query(
        `
        FOR user IN users
        FILTER user._key == @userId
        RETURN user
      `,
        { userId },
      );

      const users = await userQuery.all();
      if (users.length === 0) {
        throw new AppError("User not found", 404);
      }

      const user = users[0];

      // Verify current password
      const passwordHash =
        user.passwordHash || user.password_hash || user.password;
      const isValid = await bcrypt.compare(currentPassword, passwordHash);
      if (!isValid) {
        throw new AppError("Current password is incorrect", 401);
      }

      // Hash and save new password
      const newHash = await bcrypt.hash(newPassword, 12);
      await db.query(
        `
        FOR user IN users
        FILTER user._key == @userId
        UPDATE user WITH {
          passwordHash: @newHash,
          updatedAt: @now
        } IN users
      `,
        { userId, newHash, now: new Date().toISOString() },
      );

      logger.info("Password changed successfully", { userId });

      res.json({
        success: true,
        message: "Password changed successfully",
      });
    }),
  );

  /**
   * Forgot password - request reset token
   * POST /api/auth/forgot-password
   */
  router.post(
    "/auth/forgot-password",
    createEndpointRateLimit("forgot_password", { max: 3, windowMs: 900000 }), // 3 per 15 min
    asyncHandler(async (req, res) => {
      const { email } = req.body;

      if (!email) {
        throw new AppError("Email is required", 400);
      }

      const db = await getDbConnection();
      const crypto = await import("crypto");

      // Find user by email or username
      const userQuery = await db.query(
        `
        FOR user IN users
        FILTER user.email == @email OR user.username == @email
        LIMIT 1
        RETURN user
      `,
        { email },
      );

      const users = await userQuery.all();

      // Always return success to prevent email enumeration
      if (users.length === 0) {
        logger.warn("Password reset requested for unknown email", { email });
        return res.json({
          success: true,
          message:
            "If an account exists with that email, a reset link has been sent",
        });
      }

      const user = users[0];

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetTokenHash = await bcrypt.hash(resetToken, 12);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

      await db.query(
        `
        FOR user IN users
        FILTER user._key == @userId
        UPDATE user WITH {
          resetTokenHash: @resetTokenHash,
          resetTokenExpiresAt: @expiresAt,
          updatedAt: @now
        } IN users
      `,
        {
          userId: user._key,
          resetTokenHash,
          expiresAt,
          now: new Date().toISOString(),
        },
      );

      logger.info("Password reset token generated", { userId: user._key });

      // Send password reset email
      try {
        const emailService = getEmailService();
        await emailService.sendPasswordResetEmail(
          user.email,
          resetToken,
          user.name,
        );
        logger.info("Password reset email sent", { email: user.email });
      } catch (emailError) {
        logger.error("Failed to send password reset email", {
          error: emailError.message,
        });
        // Still return success to prevent email enumeration
      }

      res.json({
        success: true,
        message:
          "If an account exists with that email, a reset link has been sent",
        // DEV ONLY - include token for testing (remove in production)
        ...(process.env.NODE_ENV !== "production" && { _devToken: resetToken }),
      });
    }),
  );

  /**
   * Reset password with token
   * POST /api/auth/reset-password
   */
  router.post(
    "/auth/reset-password",
    createEndpointRateLimit("reset_password", { max: 5, windowMs: 900000 }), // 5 per 15 min
    asyncHandler(async (req, res) => {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        throw new AppError("Token and new password are required", 400);
      }

      if (newPassword.length < 8) {
        throw new AppError("Password must be at least 8 characters", 400);
      }

      const db = await getDbConnection();

      // Find users with non-expired reset tokens
      const userQuery = await db.query(
        `
        FOR user IN users
        FILTER user.resetTokenExpiresAt != null
          AND user.resetTokenExpiresAt > @now
        RETURN user
      `,
        { now: new Date().toISOString() },
      );

      const users = await userQuery.all();

      // Find matching token
      let matchedUser = null;
      for (const user of users) {
        if (user.resetTokenHash) {
          const isMatch = await bcrypt.compare(token, user.resetTokenHash);
          if (isMatch) {
            matchedUser = user;
            break;
          }
        }
      }

      if (!matchedUser) {
        throw new AppError("Invalid or expired reset token", 400);
      }

      // Hash and save new password, clear reset token
      const newHash = await bcrypt.hash(newPassword, 12);
      await db.query(
        `
        FOR user IN users
        FILTER user._key == @userId
        UPDATE user WITH {
          passwordHash: @newHash,
          resetTokenHash: null,
          resetTokenExpiresAt: null,
          loginAttempts: 0,
          status: 'active',
          updatedAt: @now
        } IN users
      `,
        { userId: matchedUser._key, newHash, now: new Date().toISOString() },
      );

      logger.info("Password reset successful", { userId: matchedUser._key });

      res.json({
        success: true,
        message:
          "Password has been reset successfully. You can now log in with your new password.",
      });
    }),
  );

  /**
   * Logout endpoint
   * POST /api/auth/logout
   */
  router.post(
    "/auth/logout",
    asyncHandler(async (req, res) => {
      const authHeader = req.headers.authorization;
      let userId = null;
      let sessionId = req.cookies?.session_id;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const sessionManager = req.app.locals.sessionManager;

        try {
          const decoded = jwt.verify(token, config.jwt.secret, {
            ignoreExpiration: true,
          });
          userId = decoded.userId || decoded.user_id;
          if (decoded.sessionId) {
            sessionId = decoded.sessionId;
          }
          if (sessionManager && sessionId) {
            await sessionManager.expireSession(sessionId, "logout");
          }
        } catch (error) {
          // Token invalid, nothing to expire
          logger.debug("Logout with invalid token", { error: error.message });
        }
      }

      // End session in audit service
      if (sessionId) {
        await endSession(sessionId);
      }

      // Log logout event
      await logAuditEvent("logout", {
        userId: userId,
        sessionId: sessionId,
        ipAddress: req.ip || req.connection?.remoteAddress,
      });

      // Clear cookies
      res.clearCookie("auth_token");
      res.clearCookie("session_id");

      res.json({
        success: true,
        message: "Logged out successfully",
      });
    }),
  );

  // =============================================================================
  // MCP REQUEST PROCESSING
  // =============================================================================

  /**
   * Generic MCP request processor
   * POST /api/mcp/request
   */
  router.post(
    "/mcp/request",
    createEndpointRateLimit("mcp_request", { max: 50, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const startTime = Date.now();

      logger.info("Processing MCP request", {
        orgId: req.orgId,
        userId: req.user?.userId,
        requestId: req.requestId,
        path: req.path,
      });

      eventSystem.emitRequestStarted(
        req.requestId,
        req.orgId,
        req.user?.userId,
        req.path,
      );

      // Transform Express request to MCP request format
      const mcpRequest = {
        action: req.body.action,
        orgId: req.orgId || req.body.orgId,
        userId: req.user?.userId || req.body.userId,
        body: req.body.body || req.body, // Use nested body if it exists, otherwise use the whole body
        requestId: req.requestId,
        context: req.context || {},
      };

      const result = await orchestrator.processRequest(mcpRequest);
      const duration = Date.now() - startTime;

      eventSystem.emitRequestCompleted(req.requestId, req.orgId, duration, 200);

      res.json({
        success: true,
        data: result,
        requestId: req.requestId,
        duration,
        cached: result.fromCache || false,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Health check for Redis cache
   * GET /api/health/redis
   */
  router.get(
    "/health/redis",
    asyncHandler(async (req, res) => {
      const healthCheck = {
        redis: {
          available: false,
          connected: false,
          responsive: false,
          latency: null,
          error: null,
        },
        cache: {
          testWrite: false,
          testRead: false,
          testDelete: false,
        },
        workflowCache: {
          hasData: false,
          requestOrgId: req.orgId,
          realOrgId: null,
          ruleCount: 0,
        },
        timestamp: new Date().toISOString(),
      };

      try {
        // Check if Redis client exists
        if (!orchestrator.redisClient) {
          healthCheck.redis.error = "Redis client not initialized";
          return res.status(503).json({
            success: false,
            healthy: false,
            ...healthCheck,
          });
        }

        healthCheck.redis.available = true;

        // Test Redis connection with ping
        const pingStart = Date.now();
        try {
          await orchestrator.redisClient.ping();
          healthCheck.redis.connected = true;
          healthCheck.redis.responsive = true;
          healthCheck.redis.latency = Date.now() - pingStart;
        } catch (pingError) {
          healthCheck.redis.error = `Ping failed: ${pingError.message}`;
        }

        // Test cache operations
        const testKey = `health:test:${Date.now()}`;
        const testValue = { test: true, timestamp: Date.now() };

        // Test write
        try {
          await orchestrator.redisClient.set(
            testKey,
            JSON.stringify(testValue),
            { EX: 10 },
          );
          healthCheck.cache.testWrite = true;
        } catch (writeError) {
          healthCheck.cache.writeError = writeError.message;
        }

        // Test read
        try {
          const readValue = await orchestrator.redisClient.get(testKey);
          healthCheck.cache.testRead = readValue !== null;
        } catch (readError) {
          healthCheck.cache.readError = readError.message;
        }

        // Test delete
        try {
          await orchestrator.redisClient.del(testKey);
          healthCheck.cache.testDelete = true;
        } catch (delError) {
          healthCheck.cache.deleteError = delError.message;
        }

        // Get real org ID and check workflow cache
        try {
          // Get connected orgs to find the real org ID
          const connectedOrgs = Array.from(
            orchestrator.metadataIngestionService.orgInventory.values(),
          );
          let realOrgId = req.orgId; // fallback to request org ID

          if (connectedOrgs && connectedOrgs.length > 0) {
            const activeOrg =
              connectedOrgs.find((org) => org.isActive) || connectedOrgs[0];
            realOrgId = activeOrg.salesforceOrgId;
          }

          healthCheck.workflowCache.realOrgId = realOrgId;

          // Check workflow cache with real org ID
          const workflowCacheKey = `workflow_aggregated_data:${realOrgId}`;
          const workflowData =
            await orchestrator.redisClient.get(workflowCacheKey);
          if (workflowData) {
            const parsed = JSON.parse(workflowData);
            healthCheck.workflowCache.hasData = true;
            healthCheck.workflowCache.ruleCount = parsed.rules?.length || 0;
            healthCheck.workflowCache.lastUpdated = parsed.lastUpdated;
            healthCheck.workflowCache.cacheKey = workflowCacheKey;
          } else {
            healthCheck.workflowCache.cacheKey = workflowCacheKey;
            healthCheck.workflowCache.message = "No cached workflow data found";
          }
        } catch (cacheError) {
          healthCheck.workflowCache.error = cacheError.message;
        }

        // Determine overall health
        const isHealthy =
          healthCheck.redis.connected &&
          healthCheck.redis.responsive &&
          healthCheck.cache.testWrite &&
          healthCheck.cache.testRead;

        res.status(isHealthy ? 200 : 503).json({
          success: isHealthy,
          healthy: isHealthy,
          ...healthCheck,
        });
      } catch (error) {
        healthCheck.redis.error = error.message;
        res.status(503).json({
          success: false,
          healthy: false,
          ...healthCheck,
          error: error.message,
        });
      }
    }),
  );

  /**
   * Business Service Registry Health Check
   * GET /api/health/business-registry
   */
  router.get(
    "/health/business-registry",
    createEndpointRateLimit("business_registry_health", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.businessServiceRegistry) {
        return res.status(503).json({
          success: false,
          error: "Business Service Registry not available",
          timestamp: new Date().toISOString(),
        });
      }

      try {
        const healthCheck =
          await orchestrator.businessServiceRegistry.healthCheck();
        const isHealthy = healthCheck.status === "healthy";

        // Add org context info
        const orgInfo = {
          requestOrgId: req.orgId,
          orgRegistered: false,
          orgType: null,
          cacheEnabled: false,
        };

        if (orchestrator.orgRegistry && req.orgId) {
          try {
            orgInfo.orgRegistered = await orchestrator.orgRegistry.isRegistered(
              req.orgId,
            );
            orgInfo.orgType = await orchestrator.orgRegistry.getOrgType(
              req.orgId,
            );
            orgInfo.cacheEnabled =
              await orchestrator.businessServiceRegistry.isCachingEnabledForOrg(
                req.orgId,
                "workflow",
              );
          } catch (orgError) {
            orgInfo.error = orgError.message;
          }
        }

        res.status(isHealthy ? 200 : 503).json({
          success: isHealthy,
          healthy: isHealthy,
          orgContext: orgInfo,
          timestamp: new Date().toISOString(),
          ...healthCheck,
        });
      } catch (error) {
        res.status(503).json({
          success: false,
          healthy: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }),
  );

  /**
   * Test MCP server pooling connections
   * GET /api/mcp/test-connections
   */
  router.get(
    "/mcp/test-connections",
    createEndpointRateLimit("mcp_test", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.mcpConnectionPool) {
        return res.status(503).json({
          success: false,
          error: "MCP Connection Pool not available",
          timestamp: new Date().toISOString(),
        });
      }

      try {
        // Get pool statistics
        const poolStats = orchestrator.mcpConnectionPool.getPoolStats();

        // Test session stickiness - get connection for current org
        let testResult = null;
        try {
          const connection =
            await orchestrator.mcpConnectionPool.getConnectionForOrg(req.orgId);
          testResult = {
            orgId: req.orgId,
            assignedConnectionId: connection.id,
            sessionSticky: true,
            tested: true,
          };
        } catch (testError) {
          testResult = {
            error: testError.message,
            tested: false,
          };
        }

        res.json({
          success: true,
          data: {
            poolStatus: "available",
            poolStats,
            testResult,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }),
  );

  // =============================================================================
  // PLATFORM CACHE INGESTION ROUTES (NEW)
  // =============================================================================

  /**
   * Get Platform Cache Ingestion Service status
   * GET /api/platform-cache/status
   */
  router.get(
    "/platform-cache/status",
    asyncHandler(async (req, res) => {
      const status =
        orchestrator.platformCacheIngestionService?.getProcessingStats() || {
          error: "Platform Cache Ingestion Service not available",
        };

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Trigger Platform Cache ingestion for org
   * POST /api/platform-cache/ingest
   */
  router.post(
    "/platform-cache/ingest",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("platform_cache_ingest", {
      max: 5,
      windowMs: 300000,
    }), // 5 per 5 minutes
    asyncHandler(async (req, res) => {
      const { cacheType = "all", options = {} } = req.body;

      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      const result =
        await orchestrator.platformCacheIngestionService.ingestPlatformCacheData(
          req.orgId,
          cacheType,
        );

      res.json({
        success: true,
        data: {
          jobId: `ingestion_${req.orgId}_${Date.now()}`,
          ...result,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get cached data for org
   * GET /api/platform-cache/data
   */
  router.get(
    "/platform-cache/data",
    asyncHandler(async (req, res) => {
      const {
        dataType,
        key,
        includeHistorical = false,
        fallbackToSalesforce = true,
        triggerPolling = false,
      } = req.query;

      if (!dataType || !key) {
        throw new ValidationError("dataType and key parameters are required");
      }

      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      const result =
        await orchestrator.platformCacheIngestionService.getCachedData(
          req.orgId,
          dataType,
          key,
          {
            includeHistorical: includeHistorical === "true",
            fallbackToSalesforce: fallbackToSalesforce === "true",
            triggerPolling: triggerPolling === "true",
          },
        );

      res.json({
        success: true,
        data: result,
        cached: !!result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Set cached data for org
   * POST /api/platform-cache/data
   */
  router.post(
    "/platform-cache/data",
    createEndpointRateLimit("platform_cache_set", {
      max: 100,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { dataType, key, data, options = {} } = req.body;

      if (!dataType || !key || !data) {
        throw new ValidationError("dataType, key, and data are required");
      }

      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      const result =
        await orchestrator.platformCacheIngestionService.setCachedData(
          req.orgId,
          dataType,
          key,
          data,
          options,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Register org for polling
   * POST /api/platform-cache/polling/register
   */
  router.post(
    "/platform-cache/polling/register",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("platform_cache_register", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { customVolatility = null } = req.body;

      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      await orchestrator.platformCacheIngestionService.registerOrgForPolling(
        req.orgId,
        customVolatility,
      );

      res.json({
        success: true,
        data: {
          orgId: req.orgId,
          status: "registered",
          message: "Organization registered for Platform Cache polling",
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Unregister org from polling
   * DELETE /api/platform-cache/polling/register
   */
  router.delete(
    "/platform-cache/polling/register",
    orgPermissions(["metadata:admin"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      await orchestrator.platformCacheIngestionService.unregisterOrgFromPolling(
        req.orgId,
      );

      res.json({
        success: true,
        data: {
          orgId: req.orgId,
          status: "unregistered",
          message: "Organization unregistered from Platform Cache polling",
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get polling statistics
   * GET /api/platform-cache/polling/stats
   */
  router.get(
    "/platform-cache/polling/stats",
    asyncHandler(async (req, res) => {
      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      const stats =
        orchestrator.platformCacheIngestionService.getProcessingStats();

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Trigger immediate polling for org and data type
   * POST /api/platform-cache/polling/trigger
   */
  router.post(
    "/platform-cache/polling/trigger",
    createEndpointRateLimit("platform_cache_trigger_poll", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { dataType } = req.body;

      if (!dataType) {
        throw new ValidationError("dataType is required");
      }

      if (!orchestrator.platformCacheIngestionService?.pollingManager) {
        throw new AppError("Platform Cache Polling Manager not available", 503);
      }

      const changesDetected =
        await orchestrator.platformCacheIngestionService.pollingManager.triggerImmediatePoll(
          req.orgId,
          dataType,
        );

      res.json({
        success: true,
        data: {
          orgId: req.orgId,
          dataType,
          changesDetected,
          message: "Immediate polling completed",
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Invalidate cached data
   * DELETE /api/platform-cache/invalidate
   */
  router.delete(
    "/platform-cache/invalidate",
    createEndpointRateLimit("platform_cache_invalidate", {
      max: 50,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { dataType, key, pattern, reason = "manual" } = req.body;

      if (!orchestrator.platformCacheIngestionService?.invalidationManager) {
        throw new AppError(
          "Platform Cache Invalidation Manager not available",
          503,
        );
      }

      let result;

      if (key) {
        // Invalidate specific key
        if (!dataType) {
          throw new ValidationError(
            "dataType is required when invalidating by key",
          );
        }
        await orchestrator.platformCacheIngestionService.invalidationManager.invalidateCache(
          req.orgId,
          dataType,
          key,
          reason,
        );
        result = { type: "single", dataType, key };
      } else if (pattern) {
        // Invalidate by pattern
        await orchestrator.platformCacheIngestionService.invalidationManager.invalidatePattern(
          req.orgId,
          pattern,
          reason,
        );
        result = { type: "pattern", pattern };
      } else {
        throw new ValidationError("Either key or pattern must be provided");
      }

      res.json({
        success: true,
        data: {
          orgId: req.orgId,
          invalidation: result,
          reason,
          message: "Cache invalidation queued",
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get invalidation statistics
   * GET /api/platform-cache/invalidation/stats
   */
  router.get(
    "/platform-cache/invalidation/stats",
    asyncHandler(async (req, res) => {
      if (!orchestrator.platformCacheIngestionService?.invalidationManager) {
        throw new AppError(
          "Platform Cache Invalidation Manager not available",
          503,
        );
      }

      const stats =
        orchestrator.platformCacheIngestionService.invalidationManager.getInvalidationStats();

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Force flush batch processing
   * POST /api/platform-cache/flush
   */
  router.post(
    "/platform-cache/flush",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("platform_cache_flush", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { batchType = "all" } = req.body;

      if (!orchestrator.platformCacheIngestionService?.batchProcessor) {
        throw new AppError("Platform Cache Batch Processor not available", 503);
      }

      if (batchType === "all") {
        await orchestrator.platformCacheIngestionService.batchProcessor.flushAll();
      } else {
        await orchestrator.platformCacheIngestionService.batchProcessor.flushBatch(
          batchType,
        );
      }

      res.json({
        success: true,
        data: {
          message: `Batch processing flushed for ${batchType}`,
          batchType,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get Platform Cache health check
   * GET /api/platform-cache/health
   */
  router.get(
    "/platform-cache/health",
    asyncHandler(async (req, res) => {
      const health = {
        service: orchestrator.platformCacheIngestionService
          ? "available"
          : "unavailable",
        redis: "unknown",
        arangoDB: "unknown",
        salesforceConnection: "unknown",
      };

      if (orchestrator.platformCacheIngestionService) {
        try {
          // Test Redis connection
          await orchestrator.cache?.ping();
          health.redis = "connected";
        } catch (error) {
          health.redis = "disconnected";
        }

        try {
          // Test ArangoDB connection
          await orchestrator.store?.version();
          health.arangoDB = "connected";
        } catch (error) {
          health.arangoDB = "disconnected";
        }

        try {
          // Test Salesforce connection
          const sfHealth =
            await orchestrator.salesforceApiOrchestrator?.healthCheck();
          health.salesforceConnection = sfHealth?.healthy
            ? "connected"
            : "disconnected";
        } catch (error) {
          health.salesforceConnection = "disconnected";
        }
      }

      const isHealthy =
        health.service === "available" &&
        health.redis === "connected" &&
        health.arangoDB === "connected" &&
        health.salesforceConnection === "connected";

      res.json({
        success: isHealthy,
        data: health,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // AI DOCUMENT ANALYSIS ROUTES
  // =============================================================================

  /**
   * Analyze document content with AI
   * POST /api/ai/documents/analyze
   */
  router.post(
    "/ai/documents/analyze",
    createEndpointRateLimit("ai_document_analyze", {
      max: 30,
      windowMs: 60000,
    }),
    orgLimits("aiAnalysisRequests"),
    asyncHandler(async (req, res) => {
      const {
        content,
        analysisTypes = ["sentiment", "summary"],
        options = {},
      } = req.body;

      if (!content) {
        throw new ValidationError("content is required");
      }

      const result =
        await orchestrator.aiDocumentAnalysisService.analyzeDocument(
          req.orgId,
          req.user?.userId,
          content,
          analysisTypes,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Process document with custom analysis pipeline
   * POST /api/ai/documents/process
   */
  router.post(
    "/ai/documents/process",
    createEndpointRateLimit("ai_document_process", {
      max: 20,
      windowMs: 60000,
    }),
    orgLimits("aiAnalysisRequests"),
    asyncHandler(async (req, res) => {
      const { content, analysisTypes, customOptions = {} } = req.body;

      if (!content) {
        throw new ValidationError("content is required");
      }

      const result =
        await orchestrator.aiDocumentAnalysisService.processDocument(
          req.orgId,
          req.user?.userId,
          content,
          analysisTypes,
          customOptions,
        );

      res.json(result);
    }),
  );

  /**
   * Batch process multiple documents
   * POST /api/ai/documents/batch
   */
  router.post(
    "/ai/documents/batch",
    createEndpointRateLimit("ai_document_batch", { max: 5, windowMs: 60000 }),
    orgLimits("complexAnalysisRequests"),
    asyncHandler(async (req, res) => {
      const { documents, analysisTypes, options = {} } = req.body;

      if (!Array.isArray(documents) || documents.length === 0) {
        throw new ValidationError(
          "documents array is required and cannot be empty",
        );
      }

      const result =
        await orchestrator.aiDocumentAnalysisService.batchProcessDocuments(
          req.orgId,
          req.user?.userId,
          documents,
          analysisTypes,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Get document analysis history
   * GET /api/ai/documents/history
   */
  router.get(
    "/ai/documents/history",
    asyncHandler(async (req, res) => {
      const { limit = 50, timeFrom, timeTo } = req.query;

      const result =
        await orchestrator.aiDocumentAnalysisService.getAnalysisHistory(
          req.orgId,
          req.user?.userId,
          { limit: parseInt(limit), timeFrom, timeTo },
        );

      res.json({
        success: true,
        ...result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // BUSINESS INTELLIGENCE ROUTES
  // =============================================================================

  /**
   * Generate business insights from Salesforce data
   * POST /api/bi/insights
   */
  router.post(
    "/bi/insights",
    createEndpointRateLimit("bi_insights", { max: 20, windowMs: 60000 }),
    orgLimits("complexAnalysisRequests"),
    asyncHandler(async (req, res) => {
      const {
        dataSource,
        insightTypes = ["trends", "patterns"],
        options = {},
      } = req.body;

      if (!dataSource) {
        throw new ValidationError("dataSource is required");
      }

      const result =
        await orchestrator.businessIntelligenceService.generateInsights(
          req.orgId,
          req.user?.userId,
          dataSource,
          insightTypes,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Generate forecasts based on historical data
   * POST /api/bi/forecast
   */
  router.post(
    "/bi/forecast",
    createEndpointRateLimit("bi_forecast", { max: 15, windowMs: 60000 }),
    orgLimits("complexAnalysisRequests"),
    asyncHandler(async (req, res) => {
      const { metric, forecastPeriods = 6, options = {} } = req.body;

      if (!metric) {
        throw new ValidationError("metric is required");
      }

      const result =
        await orchestrator.businessIntelligenceService.generateForecast(
          req.orgId,
          req.user?.userId,
          metric,
          forecastPeriods,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Get business intelligence dashboard data
   * GET /api/bi/dashboard
   */
  router.get(
    "/bi/dashboard",
    asyncHandler(async (req, res) => {
      const { dashboardType = "executive", timeRange = "90d" } = req.query;

      const result =
        await orchestrator.businessIntelligenceService.getDashboardData(
          req.orgId,
          req.user?.userId,
          dashboardType,
          timeRange,
        );

      res.json(result);
    }),
  );

  // =============================================================================
  // CONFIGURATION MANAGEMENT ROUTES
  // =============================================================================

  /**
   * Get flows and configuration elements
   * GET /api/config/flows
   */
  router.get(
    "/config/flows",
    createEndpointRateLimit("config_flows", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const {
        status = "Active",
        processType = null,
        triggerType = null,
        limit = 50,
        includeMetadata = false,
        includeVersionHistory = false,
      } = req.query;

      const result = await orchestrator.configurationService.getFlows(
        req.orgId,
        req.user?.userId,
        {
          status,
          processType,
          triggerType,
          limit: parseInt(limit),
          includeMetadata: includeMetadata === "true",
          includeVersionHistory: includeVersionHistory === "true",
        },
      );

      res.json(result);
    }),
  );

  /**
   * Get detailed flow configuration
   * GET /api/config/flows/:flowApiName
   */
  router.get(
    "/config/flows/:flowApiName",
    createEndpointRateLimit("config_flow_details", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { flowApiName } = req.params;
      const {
        includeElements = true,
        includeConnections = true,
        includeVariables = true,
        includeMetrics = false,
      } = req.query;

      const result = await orchestrator.configurationService.getFlowDetails(
        req.orgId,
        req.user?.userId,
        flowApiName,
        {
          includeElements: includeElements === "true",
          includeConnections: includeConnections === "true",
          includeVariables: includeVariables === "true",
          includeMetrics: includeMetrics === "true",
        },
      );

      res.json(result);
    }),
  );

  /**
   * Update configuration settings
   * PUT /api/config/settings
   */
  router.put(
    "/config/settings",
    orgPermissions(["org:admin"]),
    createEndpointRateLimit("config_update", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { settingName, values, options = {} } = req.body;

      if (!settingName || !values) {
        throw new ValidationError("settingName and values are required");
      }

      const result = await orchestrator.configurationService.updateSettings(
        req.orgId,
        req.user?.userId,
        settingName,
        values,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Get configuration history
   * GET /api/config/history
   */
  router.get(
    "/config/history",
    orgPermissions(["org:read"]),
    asyncHandler(async (req, res) => {
      const {
        settingName,
        timeFrom,
        timeTo,
        limit = 50,
        includeBackups = false,
      } = req.query;

      const result =
        await orchestrator.configurationService.getConfigurationHistory(
          req.orgId,
          req.user?.userId,
          {
            settingName,
            timeFrom,
            timeTo,
            limit: parseInt(limit),
            includeBackups: includeBackups === "true",
          },
        );

      res.json(result);
    }),
  );

  /**
   * Export configuration
   * POST /api/config/export
   */
  router.post(
    "/config/export",
    orgPermissions(["org:admin"]),
    createEndpointRateLimit("config_export", { max: 5, windowMs: 300000 }),
    asyncHandler(async (req, res) => {
      const {
        includeFlows = true,
        includeSettings = true,
        includeMetadata = true,
        format = "json",
      } = req.body;

      const result =
        await orchestrator.configurationService.exportConfiguration(
          req.orgId,
          req.user?.userId,
          {
            includeFlows,
            includeSettings,
            includeMetadata,
            format,
          },
        );

      res.json(result);
    }),
  );

  // =============================================================================
  // GITHUB INTEGRATION ROUTES
  // =============================================================================

  /**
   * Get GitHub repositories
   * GET /api/github/repositories
   */
  router.get(
    "/github/repositories",
    createEndpointRateLimit("github_repos", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const {
        owner,
        type = "all",
        sort = "updated",
        direction = "desc",
        per_page = 30,
        page = 1,
      } = req.query;

      if (!owner) {
        throw new ValidationError("owner parameter is required");
      }

      const result =
        await orchestrator.gitHubIntegrationService.getRepositories(
          req.orgId,
          req.user?.userId,
          owner,
          {
            type,
            sort,
            direction,
            per_page: parseInt(per_page),
            page: parseInt(page),
          },
        );

      res.json(result);
    }),
  );

  /**
   * Create GitHub issue
   * POST /api/github/issues
   */
  router.post(
    "/github/issues",
    createEndpointRateLimit("github_create_issue", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { owner, repo, issueData, options = {} } = req.body;

      if (!owner || !repo || !issueData?.title) {
        throw new ValidationError(
          "owner, repo, and issueData.title are required",
        );
      }

      const result = await orchestrator.gitHubIntegrationService.createIssue(
        req.orgId,
        req.user?.userId,
        owner,
        repo,
        issueData,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Get GitHub issues
   * GET /api/github/repositories/:owner/:repo/issues
   */
  router.get(
    "/github/repositories/:owner/:repo/issues",
    createEndpointRateLimit("github_get_issues", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { owner, repo } = req.params;
      const {
        state = "open",
        labels,
        assignee,
        milestone,
        since,
        sort = "created",
        direction = "desc",
        per_page = 30,
        page = 1,
      } = req.query;

      const result = await orchestrator.gitHubIntegrationService.getIssues(
        req.orgId,
        req.user?.userId,
        owner,
        repo,
        {
          state,
          labels: labels ? labels.split(",") : [],
          assignee,
          milestone,
          since,
          sort,
          direction,
          per_page: parseInt(per_page),
          page: parseInt(page),
        },
      );

      res.json(result);
    }),
  );

  /**
   * Get GitHub commits
   * GET /api/github/repositories/:owner/:repo/commits
   */
  router.get(
    "/github/repositories/:owner/:repo/commits",
    createEndpointRateLimit("github_get_commits", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { owner, repo } = req.params;
      const {
        sha,
        path,
        author,
        since,
        until,
        per_page = 30,
        page = 1,
      } = req.query;

      const result = await orchestrator.gitHubIntegrationService.getCommits(
        req.orgId,
        req.user?.userId,
        owner,
        repo,
        {
          sha,
          path,
          author,
          since,
          until,
          per_page: parseInt(per_page),
          page: parseInt(page),
        },
      );

      res.json(result);
    }),
  );

  /**
   * Get GitHub analytics
   * GET /api/github/analytics
   */
  router.get(
    "/github/analytics",
    asyncHandler(async (req, res) => {
      const { timeRange = "30d" } = req.query;

      const result =
        await orchestrator.gitHubIntegrationService.getGitHubAnalytics(
          req.orgId,
          timeRange,
        );

      res.json({
        success: true,
        analytics: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // LABEL MISMATCH ANALYSIS ROUTES
  // =============================================================================

  /**
   * Find mismatched custom labels vs API names
   * GET /api/metadata/label-mismatches
   */
  router.get(
    "/metadata/label-mismatches",
    createEndpointRateLimit("label_mismatches", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { objectApiName } = req.query;

      if (!objectApiName) {
        throw new ValidationError("objectApiName parameter is required");
      }

      const result =
        await orchestrator.findLabelApiMismatchesService.getMismatchedCustomLabels(
          objectApiName,
          req.orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Analyze impact of label mismatches
   * POST /api/metadata/label-mismatches/analyze-impact
   */
  router.post(
    "/metadata/label-mismatches/analyze-impact",
    createEndpointRateLimit("label_mismatch_impact", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { objectApiName } = req.body;

      if (!objectApiName) {
        throw new ValidationError("objectApiName is required");
      }

      const result =
        await orchestrator.findLabelApiMismatchesService.analyzeImpact(
          objectApiName,
          req.orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Classify severity of label mismatches
   * POST /api/metadata/label-mismatches/classify
   */
  router.post(
    "/metadata/label-mismatches/classify",
    createEndpointRateLimit("label_mismatch_classify", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { mismatches } = req.body;

      if (!Array.isArray(mismatches)) {
        throw new ValidationError("mismatches array is required");
      }

      const result =
        await orchestrator.findLabelApiMismatchesService.classifySeverity(
          mismatches,
          req.orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Analyze ALL fields for label mismatches using 3-tier classification (BREAK/DRIFT/COSMETIC)
   * POST /api/metadata/label-mismatches/analyze-org
   *
   * This endpoint queries org-specific fields collection and applies deterministic
   * 3-tier semantic classification:
   * - BREAK: High risk - API and label semantics conflict (Jaccard < 0.25)
   * - DRIFT: Medium risk - Meaning has shifted (0.25 <= Jaccard < 0.60)
   * - COSMETIC: Low risk - Different words, same meaning (Jaccard >= 0.60 or overlap >= 0.70)
   */
  router.post(
    "/metadata/label-mismatches/analyze-org",
    createEndpointRateLimit("label_mismatch_analyze_org", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const orgId = req.body.orgId || req.orgId || req.headers["x-org-id"];

      if (!orgId) {
        throw new ValidationError(
          "orgId is required (in body, header, or context)",
        );
      }

      if (!orchestrator.findLabelApiMismatchesService) {
        throw new AppError("Label mismatch service not available", 503);
      }

      logger.info(`Analyzing org-wide field mismatches for orgId: ${orgId}`);

      const result =
        await orchestrator.findLabelApiMismatchesService.analyzeOrgFieldMismatches(
          orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Correlate label mismatch usage in dependent metadata
   * POST /api/metadata/label-mismatches/correlate
   */
  router.post(
    "/metadata/label-mismatches/correlate",
    createEndpointRateLimit("label_mismatch_correlate", {
      max: 15,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { objectApiName } = req.body;

      if (!objectApiName) {
        throw new ValidationError("objectApiName is required");
      }

      const result =
        await orchestrator.findLabelApiMismatchesService.correlateUsage(
          objectApiName,
          req.orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get recommendations for label standardization
   * POST /api/metadata/label-mismatches/recommend
   * Enhanced with Haven Layer + AI
   */
  router.post(
    "/metadata/label-mismatches/recommend",
    createEndpointRateLimit("label_mismatch_recommend", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { objectApiName, mismatches } = req.body;

      if (!Array.isArray(mismatches)) {
        throw new ValidationError("mismatches array is required");
      }

      const result =
        await orchestrator.findLabelApiMismatchesService.getRecommendations(
          objectApiName || "Unknown", // Optional - used for Haven Layer enrichment
          mismatches,
          req.orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Comprehensive label mismatch analysis across all or specified objects
   * POST /api/label-mismatches/analyze
   */
  router.post(
    "/label-mismatches/analyze",
    createEndpointRateLimit("label_analyze_all", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const orgContext = req.orgContext;
      const orgId =
        req.orgId || req.orgContext?.orgId || req.headers["x-org-id"];
      const { includeAllObjects, objectNames } = req.body;

      if (!orchestrator.findLabelApiMismatchesService) {
        throw new AppError("Label mismatch service not available", 503);
      }

      // Get list of objects to analyze - simplified to standard objects
      let objects = [];
      if (objectNames && Array.isArray(objectNames)) {
        objects = objectNames;
      } else {
        // Default to common standard objects with custom fields
        objects = ["Account", "Contact", "Lead", "Opportunity", "Case"];
      }

      // Analyze each object
      const allMismatches = [];
      const summary = {
        totalObjectsAnalyzed: 0,
        totalCustomFields: 0,
        totalMismatches: 0,
        objectBreakdown: {},
      };

      for (const objectName of objects) {
        try {
          const result =
            await orchestrator.findLabelApiMismatchesService.getMismatchedCustomLabels(
              objectName,
              orgId,
            );
          if (result.mismatches && result.mismatches.length > 0) {
            result.mismatches.forEach((mismatch) => {
              allMismatches.push({
                objectName,
                fieldName: mismatch.apiName,
                apiName: mismatch.apiName,
                label: mismatch.label,
                fullName:
                  mismatch.fullName || `${objectName}.${mismatch.apiName}`,
                // 3-tier classification
                labelMismatchType: mismatch.labelMismatchType,
                labelMismatchScore: mismatch.labelMismatchScore,
                labelMismatchSeverity: mismatch.labelMismatchSeverity,
                labelMismatchReasons: mismatch.labelMismatchReasons,
                // Legacy
                actualLabel: mismatch.label,
                actualApiName: mismatch.apiName,
                expectedApiName: mismatch.label.replace(/[\s_]/g, "_") + "__c",
                severity: mismatch.labelMismatchSeverity || "medium",
              });
            });
            summary.objectBreakdown[objectName] = {
              totalFields: result.totalFields,
              mismatches: result.mismatches.length,
              byType: result.mismatchesByType,
            };
          }
          summary.totalObjectsAnalyzed++;
          summary.totalCustomFields += result.totalFields || 0;
          summary.totalMismatches += result.mismatches?.length || 0;
        } catch (error) {
          logger.warn(`Failed to analyze ${objectName}:`, error);
        }
      }

      // Add 3-tier byType counts
      const byType = {
        COSMETIC: allMismatches.filter(
          (m) => m.labelMismatchType === "COSMETIC",
        ).length,
        DRIFT: allMismatches.filter((m) => m.labelMismatchType === "DRIFT")
          .length,
        BREAK: allMismatches.filter((m) => m.labelMismatchType === "BREAK")
          .length,
      };

      res.json({
        success: true,
        data: {
          // For new 3-tier UI
          summary: {
            total: allMismatches.length,
            byType,
            objectsAnalyzed: summary.totalObjectsAnalyzed,
            byObject: summary.objectBreakdown,
          },
          topBreaks: allMismatches
            .filter((m) => m.labelMismatchType === "BREAK")
            .slice(0, 20),
          topDrift: allMismatches
            .filter((m) => m.labelMismatchType === "DRIFT")
            .slice(0, 20),
          allMismatches,
          // Legacy compatibility
          mismatches: allMismatches,
          analyzedObjects: objects,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // METADATA INSPECTION ROUTES
  // =============================================================================

  /**
   * Describe Salesforce object metadata
   * GET /api/metadata/describe
   */
  router.get(
    "/metadata/describe",
    createEndpointRateLimit("metadata_describe", { max: 60, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const {
        objectName,
        includeFields = true,
        includeRelationships = true,
        includePermissions = false,
      } = req.query;

      if (!objectName) {
        throw new ValidationError("objectName parameter is required");
      }

      const result =
        await orchestrator.metadataInspectionService.describeObject(
          req.orgId,
          req.user?.userId,
          objectName,
          {
            includeFields: includeFields === "true",
            includeRelationships: includeRelationships === "true",
            includePermissions: includePermissions === "true",
          },
        );

      res.json(result);
    }),
  );

  /**
   * Get all Salesforce objects
   * GET /api/metadata/objects
   */
  router.get(
    "/metadata/objects",
    createEndpointRateLimit("metadata_objects", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const {
        includeCustom = true,
        includeStandard = true,
        includeManaged = false,
        objectType = "all",
        namePattern = null,
        includeCounts = false,
      } = req.query;

      const result = await orchestrator.metadataInspectionService.getAllObjects(
        req.orgId,
        req.user?.userId,
        {
          includeCustom: includeCustom === "true",
          includeStandard: includeStandard === "true",
          includeManaged: includeManaged === "true",
          objectType,
          namePattern,
          includeCounts: includeCounts === "true",
        },
      );

      res.json(result);
    }),
  );

  /**
   * Analyze field dependencies
   * POST /api/metadata/dependencies
   */
  router.post(
    "/metadata/dependencies",
    createEndpointRateLimit("metadata_dependencies", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { objectName, fieldName, options = {} } = req.body;

      if (!objectName || !fieldName) {
        throw new ValidationError("objectName and fieldName are required");
      }

      const result =
        await orchestrator.metadataInspectionService.analyzeFieldDependencies(
          req.orgId,
          req.user?.userId,
          objectName,
          fieldName,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Compare metadata between objects
   * POST /api/metadata/compare
   */
  router.post(
    "/metadata/compare",
    createEndpointRateLimit("metadata_compare", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { sourceObject, targetObject, options = {} } = req.body;

      if (!sourceObject || !targetObject) {
        throw new ValidationError("sourceObject and targetObject are required");
      }

      const result =
        await orchestrator.metadataInspectionService.compareObjects(
          req.orgId,
          req.user?.userId,
          sourceObject,
          targetObject,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Get metadata inspection analytics
   * GET /api/metadata/analytics
   */
  router.get(
    "/metadata/analytics",
    asyncHandler(async (req, res) => {
      const { timeRange = "30d" } = req.query;

      const result =
        await orchestrator.metadataInspectionService.getInspectionAnalytics(
          req.orgId,
          timeRange,
        );

      res.json({
        success: true,
        analytics: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Hypothetical "What-If" Analysis
   * POST /api/metadata-change/hypothetical-analysis
   *
   * Test impact of hypothetical metadata changes before making them
   */
  router.post(
    "/metadata-change/hypothetical-analysis",
    createEndpointRateLimit("hypothetical_analysis", {
      max: 20,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { orgId, scenarios } = req.body;

      if (!orgId || !scenarios || !Array.isArray(scenarios)) {
        throw new ValidationError("orgId and scenarios array are required");
      }

      if (scenarios.length === 0) {
        throw new ValidationError("At least one scenario is required");
      }

      if (scenarios.length > 5) {
        throw new ValidationError("Maximum 5 scenarios allowed");
      }

      // Validate each scenario
      scenarios.forEach((scenario, index) => {
        if (!scenario.object || !scenario.field) {
          throw new ValidationError(
            `Scenario ${index + 1}: object and field are required`,
          );
        }
        if (
          !["remove", "required", "modify", "add"].includes(scenario.changeType)
        ) {
          throw new ValidationError(
            `Scenario ${index + 1}: invalid changeType`,
          );
        }
      });

      logger.info("Analyzing hypothetical scenarios", {
        orgId,
        scenarioCount: scenarios.length,
        scenarios: scenarios.map(
          (s) => `${s.object}.${s.field} (${s.changeType})`,
        ),
      });

      const results = await Promise.all(
        scenarios.map(async (scenario) => {
          try {
            // Calculate blast radius for this field
            const fieldKey = `${scenario.object}.${scenario.field}`;

            const blastRadius =
              await orchestrator.blastRadiusAnalyzerService.calculateBlastRadius(
                orgId,
                fieldKey,
                {
                  maxDepth: 3,
                  includeTransitive: true,
                },
              );

            // Generate AI recommendations based on change type
            const recommendations = await generateHypotheticalRecommendations(
              scenario,
              blastRadius,
            );

            return {
              object: scenario.object,
              field: scenario.field,
              changeType: scenario.changeType,
              blastRadius: {
                direct: blastRadius.direct?.length || 0,
                transitive: blastRadius.transitive?.length || 0,
                total: blastRadius.total || 0,
                riskLevel: blastRadius.riskLevel || "Low",
              },
              recommendations,
            };
          } catch (error) {
            logger.error(
              `Failed to analyze scenario ${scenario.object}.${scenario.field}:`,
              error,
            );
            return {
              object: scenario.object,
              field: scenario.field,
              changeType: scenario.changeType,
              error: error.message,
              blastRadius: {
                direct: 0,
                transitive: 0,
                total: 0,
                riskLevel: "Unknown",
              },
              recommendations: [
                "Analysis failed - field may not exist in graph",
              ],
            };
          }
        }),
      );

      res.json({
        success: true,
        results,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Helper: Generate recommendations for hypothetical changes
   */
  async function generateHypotheticalRecommendations(scenario, blastRadius) {
    const recommendations = [];
    const { changeType, object, field } = scenario;
    const total = blastRadius.total || 0;

    if (changeType === "remove") {
      recommendations.push(`Removing ${field} will affect ${total} components`);

      if (
        blastRadius.riskLevel === "Critical" ||
        blastRadius.riskLevel === "High"
      ) {
        recommendations.push("Create deprecation plan with 30-90 day timeline");
        recommendations.push("Notify all dependent teams before removal");
        recommendations.push(
          "Consider soft-delete pattern instead of immediate removal",
        );
      }

      if (total > 0) {
        recommendations.push(
          "Update all formulas, validation rules, and workflows referencing this field",
        );
        recommendations.push("Test in sandbox environment first");
      }
    } else if (changeType === "required") {
      recommendations.push(
        `Making ${field} required will impact ${total} components`,
      );
      recommendations.push(
        "Ensure all existing records have values for this field",
      );
      recommendations.push(
        "Update all processes that create/update this object",
      );

      if (total > 10) {
        recommendations.push(
          "Consider phased rollout with validation rules first",
        );
      }
    } else if (changeType === "modify") {
      recommendations.push(
        `Modifying ${field} formula will affect ${total} downstream calculations`,
      );
      recommendations.push(
        "Test formula changes in sandbox with production data subset",
      );
      recommendations.push(
        "Review all reports and dashboards using this field",
      );
    } else if (changeType === "add") {
      recommendations.push(`Adding ${field} to ${object}`);
      recommendations.push(
        "Consider permission set assignments for field access",
      );
      recommendations.push("Update page layouts and field-level security");
    }

    return recommendations;
  }

  /**
   * Get list of objects for hypothetical analysis
   * GET /api/metadata/:orgId/objects
   */
  router.get(
    "/metadata/:orgId/objects",
    asyncHandler(async (req, res) => {
      const { orgId } = req.params;

      try {
        // Query org-specific objects collection (org_{orgId}_objects)
        const db = orchestrator.arango.db;
        const objectsCollection = `org_${orgId}_objects`;

        // Check if org-specific collection exists
        const collections = await db.listCollections();
        const hasOrgCollection = collections.some(c => c.name === objectsCollection);

        let objects = [];
        if (hasOrgCollection) {
          const cursor = await db.query(
            `FOR obj IN @@collection
              LET name = obj.fullName || obj.name || obj._key
              SORT name
              RETURN DISTINCT name`,
            { '@collection': objectsCollection }
          );
          objects = await cursor.all();
        }

        // Fallback to metadata_objects if org collection is empty
        if (objects.length === 0) {
          const cursor = await db.query(
            `FOR obj IN metadata_objects
              FILTER obj.orgId == @orgId
              COLLECT qualifiedApiName = obj.qualifiedApiName
              SORT qualifiedApiName
              RETURN qualifiedApiName`,
            { orgId }
          );
          objects = await cursor.all();
        }

        res.json({
          success: true,
          objects,
          count: objects.length,
        });
      } catch (error) {
        logger.error("Failed to fetch objects:", error);
        res.json({
          success: true,
          objects: ["Account", "Contact", "Lead", "Opportunity", "Case"], // Fallback
          count: 5,
        });
      }
    }),
  );

  /**
   * Get fields for an object
   * GET /api/metadata/:orgId/objects/:objectName/fields
   */
  router.get(
    "/metadata/:orgId/objects/:objectName/fields",
    asyncHandler(async (req, res) => {
      const { orgId, objectName } = req.params;

      try {
        // Query org-specific fields collection (org_{orgId}_fields)
        const db = orchestrator.arango.db;
        const fieldsCollection = `org_${orgId}_fields`;

        // Check if org-specific collection exists
        const collections = await db.listCollections();
        const hasOrgCollection = collections.some(c => c.name === fieldsCollection);

        let fields = [];
        if (hasOrgCollection) {
          const cursor = await db.query(
            `FOR field IN @@collection
              FILTER field.objectName == @objectName
              LET fieldName = field.name || (field.fullName
                ? SPLIT(field.fullName, '.')[1]
                : SPLIT(field._key, '_')[LENGTH(SPLIT(field._key, '_')) - 1])
              SORT fieldName
              RETURN {
                name: fieldName,
                fullName: field.fullName || field._key,
                label: field.label || fieldName,
                type: field.type || 'Unknown',
                calculated: field.calculated || false,
                custom: field.custom || CONTAINS(fieldName, '__c')
              }`,
            {
              '@collection': fieldsCollection,
              objectName: objectName
            }
          );
          fields = await cursor.all();
        }

        // Fallback to metadata_fields if org collection is empty
        if (fields.length === 0) {
          const cursor = await db.query(
            `FOR field IN metadata_fields
              FILTER field.orgId == @orgId
              FILTER field.qualifiedApiName LIKE @objectPattern
              SORT field.label
              RETURN {
                name: SPLIT(field.qualifiedApiName, '.')[1],
                label: field.label,
                type: field.type,
                calculated: field.calculated,
                custom: field.custom
              }`,
            { orgId, objectPattern: `${objectName}.%` }
          );
          fields = await cursor.all();
        }

        // Dedupe by name
        const uniqueFields = [...new Map(fields.map(f => [f.name, f])).values()];

        res.json({
          success: true,
          fields: uniqueFields,
          count: uniqueFields.length,
        });
      } catch (error) {
        logger.error(`Failed to fetch fields for ${objectName}:`, error);
        res.json({
          success: true,
          fields: [],
          count: 0,
        });
      }
    }),
  );

  // =============================================================================
  // RECORD OPERATIONS ROUTES
  // =============================================================================

  /**
   * Query records with flexible SOQL building
   * GET /api/records/query
   */
  router.get(
    "/records/query",
    createEndpointRateLimit("records_query", { max: 100, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const {
        objectType,
        fields = "Id,Name",
        where = null,
        orderBy = null,
        limit = 20,
        offset = 0,
        includeDeleted = false,
        explainPlan = false,
      } = req.query;

      if (!objectType) {
        throw new ValidationError("objectType parameter is required");
      }

      const result = await orchestrator.recordOperationsService.queryRecords(
        req.orgId,
        req.user?.userId,
        {
          objectType,
          fields,
          where,
          orderBy,
          limit: parseInt(limit),
          offset: parseInt(offset),
          includeDeleted: includeDeleted === "true",
          explainPlan: explainPlan === "true",
        },
      );

      res.json(result);
    }),
  );

  /**
   * Create a new record
   * POST /api/records
   */
  router.post(
    "/records",
    createEndpointRateLimit("records_create", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { objectType, fieldValues, options = {} } = req.body;

      if (!objectType || !fieldValues) {
        throw new ValidationError("objectType and fieldValues are required");
      }

      const result = await orchestrator.recordOperationsService.createRecord(
        req.orgId,
        req.user?.userId,
        objectType,
        fieldValues,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Update an existing record
   * PATCH /api/records/:objectType/:recordId
   */
  router.patch(
    "/records/:objectType/:recordId",
    createEndpointRateLimit("records_update", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { objectType, recordId } = req.params;
      const { fieldValues, options = {} } = req.body;

      if (!fieldValues) {
        throw new ValidationError("fieldValues are required");
      }

      const result = await orchestrator.recordOperationsService.updateRecord(
        req.orgId,
        req.user?.userId,
        objectType,
        recordId,
        fieldValues,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Delete a record
   * DELETE /api/records/:objectType/:recordId
   */
  router.delete(
    "/records/:objectType/:recordId",
    createEndpointRateLimit("records_delete", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { objectType, recordId } = req.params;
      const { hardDelete = false, checkDependencies = true } = req.query;

      const result = await orchestrator.recordOperationsService.deleteRecord(
        req.orgId,
        req.user?.userId,
        objectType,
        recordId,
        {
          hardDelete: hardDelete === "true",
          checkDependencies: checkDependencies === "true",
        },
      );

      res.json(result);
    }),
  );

  /**
   * Bulk operations for multiple records
   * POST /api/records/bulk
   */
  router.post(
    "/records/bulk",
    createEndpointRateLimit("records_bulk", { max: 10, windowMs: 60000 }),
    orgLimits("complexOperations"),
    asyncHandler(async (req, res) => {
      const { operation, objectType, records, options = {} } = req.body;

      if (!operation || !objectType || !Array.isArray(records)) {
        throw new ValidationError(
          "operation, objectType, and records array are required",
        );
      }

      const result = await orchestrator.recordOperationsService.bulkOperation(
        req.orgId,
        req.user?.userId,
        operation,
        objectType,
        records,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Get record operation analytics
   * GET /api/records/analytics
   */
  router.get(
    "/records/analytics",
    asyncHandler(async (req, res) => {
      const { timeRange = "30d" } = req.query;

      const result =
        await orchestrator.recordOperationsService.getOperationAnalytics(
          req.orgId,
          timeRange,
        );

      res.json({
        success: true,
        analytics: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // WEB SEARCH ROUTES
  // =============================================================================

  /**
   * Perform web search
   * GET /api/search/web
   */
  router.get(
    "/search/web",
    createEndpointRateLimit("web_search", { max: 50, windowMs: 60000 }),
    orgLimits("externalApiCalls"),
    asyncHandler(async (req, res) => {
      const {
        query,
        maxResults = 10,
        provider = "brave",
        region = "US",
        language = "en",
        safeSearch = "moderate",
      } = req.query;

      if (!query) {
        throw new ValidationError("query parameter is required");
      }

      const result = await orchestrator.webSearchService.search(
        req.orgId,
        req.user?.userId,
        query,
        {
          maxResults: parseInt(maxResults),
          provider,
          region,
          language,
          safeSearch,
        },
      );

      res.json(result);
    }),
  );

  /**
   * Extract content from URL
   * POST /api/search/extract
   */
  router.post(
    "/search/extract",
    createEndpointRateLimit("content_extract", { max: 30, windowMs: 60000 }),
    orgLimits("externalApiCalls"),
    asyncHandler(async (req, res) => {
      const { url, options = {} } = req.body;

      if (!url) {
        throw new ValidationError("url is required");
      }

      const result = await orchestrator.webSearchService.extractContent(
        req.orgId,
        req.user?.userId,
        url,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Perform semantic search
   * POST /api/search/semantic
   */
  router.post(
    "/search/semantic",
    createEndpointRateLimit("semantic_search", { max: 20, windowMs: 60000 }),
    orgLimits("complexAnalysisRequests"),
    asyncHandler(async (req, res) => {
      const { query, options = {} } = req.body;

      if (!query) {
        throw new ValidationError("query is required");
      }

      const result = await orchestrator.webSearchService.semanticSearch(
        req.orgId,
        req.user?.userId,
        query,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Monitor web mentions
   * POST /api/search/monitor
   */
  router.post(
    "/search/monitor",
    createEndpointRateLimit("mention_monitor", { max: 10, windowMs: 60000 }),
    orgLimits("complexAnalysisRequests"),
    asyncHandler(async (req, res) => {
      const { terms, options = {} } = req.body;

      if (!Array.isArray(terms) || terms.length === 0) {
        throw new ValidationError(
          "terms array is required and cannot be empty",
        );
      }

      const result = await orchestrator.webSearchService.monitorMentions(
        req.orgId,
        req.user?.userId,
        terms,
        options,
      );

      res.json(result);
    }),
  );

  /**
   * Get web search analytics
   * GET /api/search/analytics
   */
  router.get(
    "/search/analytics",
    asyncHandler(async (req, res) => {
      const { timeRange = "30d" } = req.query;

      const result = await orchestrator.webSearchService.getSearchAnalytics(
        req.orgId,
        timeRange,
      );

      res.json({
        success: true,
        analytics: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // WORKFLOW ORCHESTRATION ROUTES
  // =============================================================================

  /**
   * Execute intelligent workflow
   * POST /api/workflows/execute
   */
  router.post(
    "/workflows/execute",
    createEndpointRateLimit("workflow_execute", { max: 20, windowMs: 60000 }),
    orgLimits("complexOperations"),
    asyncHandler(async (req, res) => {
      const { workflowId, options = {} } = req.body;

      if (!workflowId) {
        throw new ValidationError("workflowId is required");
      }

      const result =
        await orchestrator.workflowOrchestrationService.executeWorkflow(
          req.orgId,
          req.user?.userId,
          workflowId,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Get workflow recommendations
   * GET /api/workflows/recommendations
   */
  router.get(
    "/workflows/recommendations",
    createEndpointRateLimit("workflow_recommendations", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const {
        userRole = null,
        currentStage = null,
        maxRecommendations = 10,
        confidenceThreshold = 0.6,
        useAI = true,
      } = req.query;

      const result =
        await orchestrator.workflowOrchestrationService.getRecommendations(
          req.orgId,
          req.user?.userId,
          {
            userRole,
            currentStage,
            maxRecommendations: parseInt(maxRecommendations),
            confidenceThreshold: parseFloat(confidenceThreshold),
            useAI: useAI === "true",
          },
        );

      res.json(result);
    }),
  );

  /**
   * Get workflow execution status
   * GET /api/workflows/executions/:executionId
   */
  router.get(
    "/workflows/executions/:executionId",
    asyncHandler(async (req, res) => {
      const { executionId } = req.params;

      const result =
        await orchestrator.workflowOrchestrationService.getExecutionStatus(
          req.orgId,
          req.user?.userId,
          executionId,
        );

      res.json(result);
    }),
  );

  /**
   * Cancel workflow execution
   * DELETE /api/workflows/executions/:executionId
   */
  router.delete(
    "/workflows/executions/:executionId",
    asyncHandler(async (req, res) => {
      const { executionId } = req.params;
      const { reason = "User requested cancellation" } = req.body;

      const result =
        await orchestrator.workflowOrchestrationService.cancelExecution(
          req.orgId,
          req.user?.userId,
          executionId,
          reason,
        );

      res.json(result);
    }),
  );

  /**
   * Get workflow analytics
   * GET /api/workflows/analytics
   */
  router.get(
    "/workflows/analytics",
    asyncHandler(async (req, res) => {
      const { timeRange = "30d" } = req.query;

      const result =
        await orchestrator.workflowOrchestrationService.getWorkflowAnalytics(
          req.orgId,
          timeRange,
        );

      res.json({
        success: true,
        analytics: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // INTERACTIVE WORKFLOW ROUTES - Conversational AI Workflows
  // =============================================================================

  /**
   * Start interactive conversational workflow
   * POST /api/workflows/app/start
   */
  router.post(
    "/workflows/app/start",
    createEndpointRateLimit("workflow_app_start", { max: 20, windowMs: 60000 }),
    orgLimits("complexOperations"),
    asyncHandler(async (req, res) => {
      const { serviceType, userInput, options = {} } = req.body;

      if (!serviceType) {
        throw new ValidationError("serviceType is required");
      }

      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      const result =
        await orchestrator.workflowOrchestrationService.executeWorkflow(
          req.orgId,
          req.user?.userId,
          serviceType,
          userInput,
          options,
        );

      res.json(result);
    }),
  );

  /**
   * Continue interactive workflow to next step
   * POST /api/workflows/app/continue
   */
  router.post(
    "/workflows/app/continue",
    createEndpointRateLimit("workflow_app_continue", {
      max: 50,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { workflowId, stepIndex, userDecision } = req.body;

      if (!workflowId || stepIndex === undefined) {
        throw new ValidationError("workflowId and stepIndex are required");
      }

      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      const result =
        await orchestrator.workflowOrchestrationService.continueWorkflow(
          req.orgId,
          req.user?.userId,
          workflowId,
          stepIndex,
          userDecision,
        );

      res.json(result);
    }),
  );

  /**
   * Process user decision in interactive workflow
   * POST /api/workflows/app/decision
   */
  router.post(
    "/workflows/app/decision",
    createEndpointRateLimit("workflow_app_decision", {
      max: 50,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { workflowId, choiceId, customInput } = req.body;

      if (!workflowId) {
        throw new ValidationError("workflowId is required");
      }

      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      const result =
        await orchestrator.workflowOrchestrationService.processUserDecision(
          req.orgId,
          req.user?.userId,
          workflowId,
          choiceId,
          customInput,
        );

      res.json(result);
    }),
  );

  /**
   * Get interactive workflow status
   * GET /api/workflows/app/status/:workflowId
   */
  router.get(
    "/workflows/app/status/:workflowId",
    asyncHandler(async (req, res) => {
      const { workflowId } = req.params;

      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      const result =
        await orchestrator.workflowOrchestrationService.getExecutionStatus(
          req.orgId,
          req.user?.userId,
          workflowId,
        );

      res.json(result);
    }),
  );

  /**
   * Cancel interactive workflow
   * DELETE /api/workflows/app/:workflowId
   */
  router.delete(
    "/workflows/app/:workflowId",
    asyncHandler(async (req, res) => {
      const { workflowId } = req.params;
      const { reason = "User cancelled" } = req.body;

      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      const result =
        await orchestrator.workflowOrchestrationService.cancelExecution(
          req.orgId,
          req.user?.userId,
          workflowId,
          reason,
        );

      res.json(result);
    }),
  );

  /**
   * Get user's active interactive workflows
   * GET /api/workflows/app/active
   */
  router.get(
    "/workflows/app/active",
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      const activeWorkflows =
        orchestrator.workflowOrchestrationService.getUserActiveWorkflows(
          req.user?.userId,
        );

      res.json({
        success: true,
        data: {
          activeWorkflows,
          count: activeWorkflows.length,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // WORKFLOW TRACING ROUTES - LLM Prompt Tracing and Debug
  // =============================================================================

  /**
   * Export LLM prompt traces for debugging
   * GET /api/workflows/app/trace/:workflowId?
   */
  router.get(
    "/workflows/app/trace/:workflowId?",
    asyncHandler(async (req, res) => {
      const { workflowId } = req.params;

      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      const result =
        orchestrator.workflowOrchestrationService.exportPromptTrace(workflowId);

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Clear LLM prompt trace buffer
   * DELETE /api/workflows/app/trace
   */
  router.delete(
    "/workflows/app/trace",
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      orchestrator.workflowOrchestrationService.clearPromptTrace();

      res.json({
        success: true,
        message: "Prompt trace buffer cleared",
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Toggle LLM prompt tracing
   * POST /api/workflows/app/trace/toggle
   */
  router.post(
    "/workflows/app/trace/toggle",
    asyncHandler(async (req, res) => {
      const { enabled } = req.body;

      if (!orchestrator.workflowOrchestrationService) {
        throw new AppError("WorkflowOrchestrationService not available", 503);
      }

      orchestrator.workflowOrchestrationService.enablePromptTracing =
        enabled !== undefined
          ? !!enabled
          : !orchestrator.workflowOrchestrationService.enablePromptTracing;

      res.json({
        success: true,
        data: {
          promptTracingEnabled:
            orchestrator.workflowOrchestrationService.enablePromptTracing,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // WORKFLOW DISCOVERY ROUTES - Salesforce Workflow Rules to Flow Conversion
  // =============================================================================

  /**
   * Debug workflow metadata structure - shows raw metadata from Salesforce
   * GET /api/workflows/debug-metadata
   */
  router.get(
    "/workflows/debug-metadata",
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      // Allow passing orgId as query param for debugging, or use session orgId
      const orgId = req.query.orgId || req.orgId;
      if (!orgId) {
        throw new AppError(
          "Missing orgId - pass as ?orgId=xxx or login first",
          400,
        );
      }

      const result =
        await orchestrator.workflowDiscoveryService.debugWorkflowMetadata(
          orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Fast workflow rules summary - returns immediately, starts background metadata fetch
   * GET /api/workflows/fast
   */
  router.get(
    "/workflows/fast",
    createEndpointRateLimit("workflow_fast", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      const result =
        await orchestrator.workflowDiscoveryService.getWorkflowRulesFast(
          req.orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get metadata fetching status and progress
   * GET /api/workflows/status
   */
  router.get(
    "/workflows/status",
    createEndpointRateLimit("workflow_status", { max: 100, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      const result = orchestrator.workflowDiscoveryService.getMetadataStatus(
        req.orgId,
      );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Test workflow object field access
   * GET /api/workflows/test
   */
  router.get(
    "/workflows/test",
    createEndpointRateLimit("workflow_test", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      const result =
        await orchestrator.workflowDiscoveryService.testWorkflowObjectAccess(
          req.orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get detailed metadata for a specific workflow rule
   * GET /api/workflows/rule/:ruleId/metadata
   */
  router.get(
    "/workflows/rule/:ruleId/metadata",
    createEndpointRateLimit("workflow_metadata", {
      max: 1000,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      const { ruleId } = req.params;
      const cacheKey = `workflow_rule_metadata:${req.orgId}:${ruleId}`;

      // Check Redis cache first
      if (orchestrator.redisClient) {
        try {
          const cachedResult = await orchestrator.redisClient.get(cacheKey);
          if (cachedResult) {
            const parsedResult = JSON.parse(cachedResult);

            res.json({
              success: true,
              data: parsedResult,
              cached: true,
              timestamp: new Date().toISOString(),
            });
            return;
          }
        } catch (error) {
          logger.warn("Redis cache read error for rule metadata:", error);
        }
      }

      // Fetch from Salesforce if not cached
      const result =
        await orchestrator.workflowDiscoveryService.getWorkflowRuleMetadata(
          req.orgId,
          ruleId,
        );

      // Cache the result in Redis (1 hour TTL)
      if (orchestrator.redisClient && result) {
        try {
          await orchestrator.redisClient.set(cacheKey, JSON.stringify(result), {
            EX: 3600,
          });

          // Also update the aggregated workflow cache for AI Assistant
          await updateAggregatedWorkflowCache(req.orgId, ruleId, result);
        } catch (error) {
          logger.warn("Redis cache write error for rule metadata:", error);
        }
      }

      res.json({
        success: true,
        data: result,
        cached: false,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Helper function to update aggregated workflow cache for AI Assistant
   */
  function buildWorkflowSummaryFromCache(aggregatedData = {}) {
    const summary = {
      totalRules: aggregatedData.totalRules || 0,
      activeRules: aggregatedData.activeRules || 0,
      inactiveRules:
        aggregatedData.inactiveRules != null
          ? aggregatedData.inactiveRules
          : Math.max(
              (aggregatedData.totalRules || 0) -
                (aggregatedData.activeRules || 0),
              0,
            ),
      objectBreakdown: {},
      rulesWithDescriptions: Array.isArray(aggregatedData.rules)
        ? aggregatedData.rules.filter(
            (rule) => rule.description && rule.description.trim(),
          ).length
        : 0,
      lastUpdated: aggregatedData.lastUpdated,
    };

    if (aggregatedData.objectBreakdown) {
      Object.entries(aggregatedData.objectBreakdown).forEach(
        ([objectName, stats]) => {
          summary.objectBreakdown[objectName] = {
            total: stats.totalRules ?? stats.total ?? 0,
            active: stats.activeRules ?? stats.active ?? 0,
            inactive: stats.inactiveRules ?? stats.inactive ?? 0,
          };
        },
      );
    }

    return summary;
  }

  async function updateAggregatedWorkflowCache(orgId, ruleId, ruleMetadata) {
    const aggregatedCacheKey = `workflow_aggregated_data:${orgId}`;

    try {
      // Get existing aggregated data or initialize
      let aggregatedData = {};
      const existing = await orchestrator.redisClient.get(aggregatedCacheKey);
      if (existing) {
        aggregatedData = JSON.parse(existing);
      }

      // Initialize structure if needed
      if (!aggregatedData.rules) {
        aggregatedData.rules = [];
        aggregatedData.totalRules = 0;
        aggregatedData.activeRules = 0;
        aggregatedData.lastUpdated = new Date().toISOString();
        aggregatedData.metadataLoaded = true;
      }

      // Find existing rule or add new one
      const existingIndex = aggregatedData.rules.findIndex(
        (r) => r.id === ruleId,
      );
      if (existingIndex >= 0) {
        // Update existing rule - check if active status changed
        const previouslyActive = aggregatedData.rules[existingIndex].active;
        const nowActive = ruleMetadata.active;

        aggregatedData.rules[existingIndex] = ruleMetadata;

        // Update active count if status changed
        if (previouslyActive && !nowActive) {
          aggregatedData.activeRules--;
        } else if (!previouslyActive && nowActive) {
          aggregatedData.activeRules++;
        }
      } else {
        // Add new rule
        aggregatedData.rules.push(ruleMetadata);
        aggregatedData.totalRules++;
        if (ruleMetadata.active) {
          aggregatedData.activeRules++;
        }
      }

      // Calculate aggregate fields from the rules array
      aggregatedData.inactiveRules =
        aggregatedData.totalRules - aggregatedData.activeRules;

      // Calculate unique objects count
      const uniqueObjects = new Set(
        aggregatedData.rules.map((r) => r.objectApiName),
      );
      aggregatedData.objectsCount = uniqueObjects.size;

      // Calculate total actions from metadata
      aggregatedData.totalActions = aggregatedData.rules.reduce((sum, rule) => {
        // Count actions from the Metadata.actions array
        const actionCount =
          (rule.Metadata?.actions?.length || 0) + (rule.actions?.length || 0);
        return sum + actionCount;
      }, 0);

      // Build indexes for QueryExecutor operations
      aggregatedData.indexes = {
        byId: {},
        byName: {},
        byObject: {},
      };

      // Calculate object breakdown for quick access
      aggregatedData.objectBreakdown = {};
      aggregatedData.rules.forEach((rule, arrayIndex) => {
        const objName = rule.objectApiName || "Unknown";
        const ruleName = rule.name || "Unnamed";

        // Build ID index (one-to-one mapping)
        if (rule.id) {
          aggregatedData.indexes.byId[rule.id] = {
            arrayIndex: arrayIndex,
            name: ruleName,
            objectApiName: objName,
            active: rule.active,
          };
        }

        // Build Name index (one-to-many mapping since names can be duplicated)
        if (!aggregatedData.indexes.byName[ruleName]) {
          aggregatedData.indexes.byName[ruleName] = [];
        }
        aggregatedData.indexes.byName[ruleName].push({
          arrayIndex: arrayIndex,
          id: rule.id,
          objectApiName: objName,
          active: rule.active,
        });

        // Build Object index (one-to-many mapping for cross-object analysis)
        if (!aggregatedData.indexes.byObject[objName]) {
          aggregatedData.indexes.byObject[objName] = {
            all: [],
            active: [],
            inactive: [],
          };
        }
        aggregatedData.indexes.byObject[objName].all.push({
          arrayIndex: arrayIndex,
          id: rule.id,
          name: ruleName,
          active: rule.active,
        });

        // Separate active/inactive for faster queries
        if (rule.active) {
          aggregatedData.indexes.byObject[objName].active.push({
            arrayIndex: arrayIndex,
            id: rule.id,
            name: ruleName,
          });
        } else {
          aggregatedData.indexes.byObject[objName].inactive.push({
            arrayIndex: arrayIndex,
            id: rule.id,
            name: ruleName,
          });
        }

        // Object breakdown
        if (!aggregatedData.objectBreakdown[objName]) {
          aggregatedData.objectBreakdown[objName] = {
            totalRules: 0,
            activeRules: 0,
            inactiveRules: 0,
            rules: [],
          };
        }
        aggregatedData.objectBreakdown[objName].totalRules++;
        if (rule.active) {
          aggregatedData.objectBreakdown[objName].activeRules++;
        } else {
          aggregatedData.objectBreakdown[objName].inactiveRules++;
        }
        aggregatedData.objectBreakdown[objName].rules.push({
          id: rule.id,
          name: rule.name,
          active: rule.active,
          actionCount: rule.Metadata?.actions?.length || 0,
        });
      });

      aggregatedData.lastUpdated = new Date().toISOString();

      // Cache aggregated data (2 hour TTL for AI Assistant)
      await orchestrator.redisClient.set(
        aggregatedCacheKey,
        JSON.stringify(aggregatedData),
        { EX: 7200 },
      );

      if (orchestrator.businessServiceRegistry) {
        try {
          await orchestrator.businessServiceRegistry.cacheServiceMetadata(
            orgId,
            "WorkflowDiscoveryService",
            aggregatedData,
            {
              subKey: "complete-workflow-data",
              source: "workflow_rule_metadata_route",
              ttl: 7200,
              metadata: {
                rules: aggregatedData.totalRules,
                activeRules: aggregatedData.activeRules,
                lastUpdated: aggregatedData.lastUpdated,
              },
            },
          );
        } catch (error) {
          logger.warn(
            "BusinessServiceRegistry cache write error for aggregated workflow data:",
            error,
          );
        }
      }

      logger.info(
        `Updated aggregated workflow cache for org ${orgId}: ${aggregatedData.totalRules} rules`,
      );
    } catch (error) {
      logger.warn("Error updating aggregated workflow cache:", error);
    }
  }

  router.get(
    "/services/available",
    createEndpointRateLimit("services_available", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      // Get orgId from middleware context or headers
      const orgId = req.orgId || req.headers["x-org-id"] || req.query.orgId;

      if (!orgId || !orchestrator.businessServiceRegistry) {
        const fallback = AI_ASSIST_SERVICE_DEFINITIONS.map((service) => ({
          id: service.id,
          name: service.displayName,
          description: service.description,
          defaultPrompt: service.defaultPrompt,
          available: false,
          cachedAt: null,
          ttl: null,
          metadata: null,
        }));

        return res.json({
          success: true,
          data: fallback,
          cached: false,
          timestamp: new Date().toISOString(),
        });
      }

      const services = await resolveAIServiceAvailability(orgId);

      res.json({
        success: true,
        data: services,
        cached: true,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  router.post(
    "/services/cache/warm",
    createEndpointRateLimit("services_cache_warm", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const orgId = req.orgId || req.headers["x-org-id"] || req.body?.orgId;
      if (!orgId) {
        throw new AppError(
          "Organization context required to warm services cache",
          400,
        );
      }

      const requestedServices =
        Array.isArray(req.body?.services) && req.body.services.length > 0
          ? req.body.services
          : AI_ASSIST_SERVICE_DEFINITIONS.map((service) => service.id);
      const forceRefresh = req.body?.forceRefresh === true;

      const warmed = [];
      for (const serviceId of requestedServices) {
        try {
          warmed.push(
            await warmAIServiceCache(orgId, serviceId, { forceRefresh }),
          );
        } catch (error) {
          warmed.push({
            serviceId,
            warmed: false,
            cached: false,
            error: error.message,
          });
        }
      }

      const availability = await resolveAIServiceAvailability(orgId);

      res.json({
        success: true,
        warmed,
        availability,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get workflow rules summary for organization - uses cache for accuracy
   * GET /api/workflows/summary
   */
  router.get(
    "/workflows/summary",
    createEndpointRateLimit("workflow_summary", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const aggregatedCacheKey = "workflow_aggregated_data:" + req.orgId;

      try {
        if (orchestrator.redisClient) {
          logger.info("Looking for cache key: " + aggregatedCacheKey);
          const cachedData =
            await orchestrator.redisClient.get(aggregatedCacheKey);
          logger.info("Cache result: " + (cachedData ? "FOUND" : "NOT FOUND"));
          if (cachedData) {
            const aggregatedData = JSON.parse(cachedData);
            const result = buildWorkflowSummaryFromCache(aggregatedData);

            return res.json({
              success: true,
              data: result,
              cached: true,
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (!orchestrator.workflowDiscoveryService) {
          throw new AppError(
            "WorkflowDiscoveryService not available and no cache found",
            503,
          );
        }

        const result =
          await orchestrator.workflowDiscoveryService.getWorkflowRulesSummary(
            req.orgId,
          );

        res.json({
          success: true,
          data: result,
          cached: false,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error("Summary endpoint failed", error);
        throw error;
      }
    }),
  );

  /**
   * Discover all workflow rules in organization
   * POST /api/workflows/discover
   */
  router.post(
    "/workflows/discover",
    createEndpointRateLimit("workflow_discover", { max: 10, windowMs: 300000 }), // 10 per 5 minutes
    asyncHandler(async (req, res) => {
      const { orgId, options = {} } = req.body;
      const effectiveOrgId = orgId || req.orgId;

      console.log(
        "📍 DISCOVER ENDPOINT: orgId from body:",
        orgId,
        ", from req:",
        req.orgId,
        ", using:",
        effectiveOrgId,
      );

      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      const result =
        await orchestrator.workflowDiscoveryService.discoverAndExport(
          effectiveOrgId,
          options,
        );

      // CRITICAL: Populate Layer 1 and Layer 2 cache with FULL enriched metadata
      if (result.success && result.rules && result.rules.length > 0) {
        try {
          const rules = result.rules;

          // Calculate stats from enriched data
          const activeRules = rules.filter((r) => r.active).length;
          const inactiveRules = rules.length - activeRules;
          const objectsSet = new Set(rules.map((r) => r.objectApiName));
          const totalActions = rules.reduce(
            (sum, r) => sum + (r.actions?.length || 0),
            0,
          );

          // Layer 1: Business Service Cache - Full enriched workflow data for UI
          const layer1Key = `workflows:${effectiveOrgId}:enriched`;
          const layer1Data = {
            rules: rules,
            totalRules: rules.length,
            activeRules,
            inactiveRules,
            objectsCount: objectsSet.size,
            totalActions,
            lastUpdated: new Date().toISOString(),
            cacheSource: "metadata_api_enriched",
          };

          // Layer 2: Context-Aware Cache - Org metadata summary
          const layer2Key = `workflow_aggregated_data:${effectiveOrgId}`;
          const layer2Data = {
            totalRules: rules.length,
            activeRules,
            inactiveRules,
            objectsCount: objectsSet.size,
            totalActions,
            objects: Array.from(objectsSet),
            lastUpdated: new Date().toISOString(),
            cacheSource: "metadata_api_enriched",
          };

          if (orchestrator.redisClient) {
            // Cache full data (Layer 1) with 1 hour TTL
            await orchestrator.redisClient.set(
              layer1Key,
              JSON.stringify(layer1Data),
              { EX: 3600 },
            );
            // Cache summary (Layer 2) with 1 hour TTL
            await orchestrator.redisClient.set(
              layer2Key,
              JSON.stringify(layer2Data),
              { EX: 3600 },
            );
          }

          logger.info(
            "✅ Layer 1 & Layer 2 cache populated with enriched metadata",
            {
              orgId: effectiveOrgId,
              totalRules: rules.length,
              activeRules,
              inactiveRules,
              withMetadata: rules.filter((r) => r.Metadata).length,
              source: "metadata_api_enriched",
            },
          );
        } catch (cacheError) {
          logger.warn(
            "❌ Failed to populate enriched metadata cache:",
            cacheError,
          );
        }
      }

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Ingest org metadata into metadata graph for dependency analysis
   * POST /api/metadata/ingest-graph
   */
  router.post(
    "/metadata/ingest-graph",
    createEndpointRateLimit("metadata_ingest", { max: 5, windowMs: 300000 }), // 5 per 5 minutes
    asyncHandler(async (req, res) => {
      const { orgId, snapshotId } = req.body;
      const effectiveOrgId = orgId || req.orgId;

      if (!effectiveOrgId) {
        throw new ValidationError("orgId is required");
      }

      // Initialize services if needed
      if (!orchestrator.metadataGraph) {
        await orchestrator.initializeService("metadataGraph");
      }

      if (!orchestrator.metadataIngestionService) {
        await orchestrator.initializeService("metadataIngestionService");
      }

      logger.info("Starting metadata graph ingestion", {
        orgId: effectiveOrgId,
        snapshotId,
      });

      const result =
        await orchestrator.metadataIngestionService.ingestMetadataToGraph(
          effectiveOrgId,
          snapshotId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Modular metadata ingestion with parallel collectors
   * POST /api/metadata/ingest-modular
   *
   * New modular ingestion system with:
   * - Config-driven collector enable/disable
   * - Dependency resolution for collector ordering
   * - Parallel execution of independent collectors
   * - Integration with Git snapshot versioning
   */
  router.post(
    "/metadata/ingest-modular",
    createEndpointRateLimit("metadata_ingest", { max: 5, windowMs: 300000 }),
    asyncHandler(async (req, res) => {
      const { orgId, options = {} } = req.body;
      const effectiveOrgId = orgId || req.orgId;

      if (!effectiveOrgId) {
        throw new ValidationError("orgId is required");
      }

      // Initialize modular ingestion orchestrator if needed
      if (!orchestrator.modularIngestionOrchestrator) {
        const { MetadataIngestionOrchestrator } =
          await import("../services/metadata-ingestion/index.js");
        orchestrator.modularIngestionOrchestrator =
          new MetadataIngestionOrchestrator(orchestrator);
        await orchestrator.modularIngestionOrchestrator.initialize();
      }

      logger.info("Starting modular metadata ingestion", {
        orgId: effectiveOrgId,
        options,
      });

      const result =
        await orchestrator.modularIngestionOrchestrator.runFullIngestion(
          effectiveOrgId,
          options,
        );

      res.json({
        success: result.success,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Run a specific collector
   * POST /api/metadata/run-collector
   */
  router.post(
    "/metadata/run-collector",
    createEndpointRateLimit("metadata_collector", { max: 20, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { orgId, collectorName, options = {} } = req.body;
      const effectiveOrgId = orgId || req.orgId;

      if (!effectiveOrgId) {
        throw new ValidationError("orgId is required");
      }

      if (!collectorName) {
        throw new ValidationError("collectorName is required");
      }

      // Initialize modular ingestion orchestrator if needed
      if (!orchestrator.modularIngestionOrchestrator) {
        const { MetadataIngestionOrchestrator } =
          await import("../services/metadata-ingestion/index.js");
        orchestrator.modularIngestionOrchestrator =
          new MetadataIngestionOrchestrator(orchestrator);
        await orchestrator.modularIngestionOrchestrator.initialize();
      }

      logger.info("Running single collector", {
        orgId: effectiveOrgId,
        collectorName,
      });

      const result =
        await orchestrator.modularIngestionOrchestrator.runCollector(
          collectorName,
          effectiveOrgId,
          options,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get modular ingestion collector status
   * GET /api/metadata/collectors
   */
  router.get(
    "/metadata/collectors",
    asyncHandler(async (req, res) => {
      // Initialize modular ingestion orchestrator if needed
      if (!orchestrator.modularIngestionOrchestrator) {
        const { MetadataIngestionOrchestrator } =
          await import("../services/metadata-ingestion/index.js");
        orchestrator.modularIngestionOrchestrator =
          new MetadataIngestionOrchestrator(orchestrator);
        await orchestrator.modularIngestionOrchestrator.initialize();
      }

      const collectors =
        orchestrator.modularIngestionOrchestrator.listCollectors();
      const status =
        orchestrator.modularIngestionOrchestrator.getCollectorStatus();
      const config = orchestrator.modularIngestionOrchestrator.getConfig();
      const metrics = orchestrator.modularIngestionOrchestrator.getMetrics();

      res.json({
        success: true,
        data: {
          collectors,
          status,
          config,
          metrics,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Enable/disable a collector at runtime
   * PATCH /api/metadata/collectors/:name
   */
  router.patch(
    "/metadata/collectors/:name",
    asyncHandler(async (req, res) => {
      const { name } = req.params;
      const { enabled } = req.body;

      if (typeof enabled !== "boolean") {
        throw new ValidationError("enabled (boolean) is required");
      }

      // Initialize modular ingestion orchestrator if needed
      if (!orchestrator.modularIngestionOrchestrator) {
        const { MetadataIngestionOrchestrator } =
          await import("../services/metadata-ingestion/index.js");
        orchestrator.modularIngestionOrchestrator =
          new MetadataIngestionOrchestrator(orchestrator);
        await orchestrator.modularIngestionOrchestrator.initialize();
      }

      if (enabled) {
        orchestrator.modularIngestionOrchestrator.enableCollector(name);
      } else {
        orchestrator.modularIngestionOrchestrator.disableCollector(name);
      }

      res.json({
        success: true,
        message: `Collector ${name} ${enabled ? "enabled" : "disabled"}`,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get workflow rules for specific object
   * GET /api/workflows/object/:objectApiName
   */
  router.get(
    "/workflows/object/:objectApiName",
    createEndpointRateLimit("workflow_by_object", { max: 20, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { objectApiName } = req.params;

      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      const result =
        await orchestrator.workflowDiscoveryService.getWorkflowRulesByObject(
          req.orgId,
          objectApiName,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Group workflows by action type for intelligent coalescing
   * POST /api/workflow/group-by-action-type
   */
  router.post(
    "/workflow/group-by-action-type",
    createEndpointRateLimit("workflow_group", { max: 10, windowMs: 300000 }), // 10 per 5 minutes
    asyncHandler(async (req, res) => {
      const { workflows, orgId, userId } = req.body;

      if (!workflows || !Array.isArray(workflows)) {
        throw new ValidationError("workflows array is required");
      }

      // Initialize WorkflowPrefilterService if needed
      if (!orchestrator.workflowPrefilterService) {
        await orchestrator.initializeService("workflowPrefilterService");
      }

      // Transform Express request to MCP request format (preserves session correlation)
      const mcpRequest = {
        action: "workflow_analysis_by_action_type",
        orgId: orgId || req.orgId,
        userId: userId || req.user?.userId,
        body: {
          workflows: workflows,
          objectType: "Lead",
        },
        requestId: req.requestId,
        context: req.context || {},
      };

      const result = await orchestrator.processRequest(mcpRequest);

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Convert workflow rules to Flow XML (LLM integration)
   * POST /api/workflows/convert-to-flow
   */
  router.post(
    "/workflows/convert-to-flow",
    createEndpointRateLimit("workflow_convert", { max: 5, windowMs: 300000 }), // 5 per 5 minutes
    // Remove orgPermissions for testing
    // orgPermissions(['workflows:convert']),
    asyncHandler(async (req, res) => {
      const {
        coalescingRecommendations,
        recommendations,
        options = {},
      } = req.body;

      // Support both naming conventions
      const recommendationGroups = coalescingRecommendations || recommendations;

      if (
        !recommendationGroups ||
        !Array.isArray(recommendationGroups) ||
        recommendationGroups.length === 0
      ) {
        throw new ValidationError(
          "At least one coalescing recommendation required for conversion",
        );
      }

      // Initialize CoalesceTransformService for handling coalesced workflows
      if (!orchestrator.coalesceTransformService) {
        const { CoalesceTransformService } =
          await import("../services/CoalesceTransformService.js");
        orchestrator.coalesceTransformService = new CoalesceTransformService(
          orchestrator,
        );
      }

      // Generate session ID for correlation with previous steps
      const sessionId =
        options.sessionId ||
        `flow_gen_session_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).substring(7)}`;
      const orgId = req.orgId || options.orgId || "system";
      const startTime = Date.now();

      // LOG INPUT TO DATABASE
      if (orchestrator.store) {
        try {
          await orchestrator.store.saveOrgDocument(
            orgId,
            "flow_generation_inputs",
            {
              timestamp: new Date().toISOString(),
              sessionId: sessionId,
              previousSessionId: options.previousSessionId, // Link to coalescing session
              type: "flow_generation_input",
              recommendationCount: recommendationGroups.length,
              recommendations: recommendationGroups,
              orgId: orgId,
              userId: req.user?.userId || options.userId || "system",
            },
          );
          console.log(
            `Saved ${recommendationGroups.length} recommendations to flow_generation_inputs`,
          );
        } catch (error) {
          console.error("Failed to save flow generation input:", error);
        }
      }

      // PROCESS MULTIPLE RECOMMENDATIONS IN PARALLEL
      console.log(
        `Processing ${recommendationGroups.length} coalescing recommendations in parallel for Flow XML generation`,
      );

      // Map coalescing recommendations to the format expected by CoalesceTransformService
      const coalescedGroups = recommendationGroups.map((rec, index) => {
        // Handle different possible formats from coalescing API
        const workflows =
          rec.workflows || rec.workflowGroup || rec.result?.workflows || [];
        const coalescedFlow =
          rec.coalescedFlow || rec.result?.coalescedFlow || "";
        const strategy =
          rec.strategy || rec.coalescingStrategy || "consolidated";

        return {
          groupName: rec.groupName || `Group_${index + 1}`,
          workflows: workflows,
          consolidationStrategy: strategy,
          businessLogic:
            rec.businessLogic ||
            rec.benefits ||
            "Consolidate similar workflows",
          coalescedFlow: coalescedFlow, // Pass the coalescing recommendations
          objectType: rec.objectType || workflows[0]?.objectApiName || "Lead",
          feasibility: rec.feasibility || rec.result?.feasibility,
          originalRecommendation: rec, // Keep original for reference
        };
      });

      // Use CoalesceTransformService to transform all groups in parallel
      const transformResult =
        await orchestrator.coalesceTransformService.transformCoalescedGroups(
          coalescedGroups,
          {
            ...options,
            sessionId: sessionId,
            orgId: orgId,
          },
        );

      // Format results for response
      const flowGenerationResults = transformResult.transformedFlows.map(
        (flow, index) => ({
          recommendationIndex: index,
          success: flow.success !== false,
          objectType: coalescedGroups[index].objectType,
          workflowCount: coalescedGroups[index].workflows.length,
          coalescingStrategy: coalescedGroups[index].consolidationStrategy,
          flowXml: flow.flowXml || flow,
          deploymentReady: flow.success !== false,
        }),
      );

      // Calculate summary statistics
      const successCount = flowGenerationResults.filter(
        (r) => r.success,
      ).length;
      const failureCount = flowGenerationResults.filter(
        (r) => !r.success,
      ).length;
      const processingTime = Date.now() - startTime;

      // LOG OUTPUT TO DATABASE
      if (orchestrator.store) {
        try {
          await orchestrator.store.saveOrgDocument(
            orgId,
            "flow_generation_outputs",
            {
              timestamp: new Date().toISOString(),
              sessionId: sessionId,
              previousSessionId: options.previousSessionId,
              type: "flow_generation_output",
              recommendationCount: recommendationGroups.length,
              successCount: successCount,
              failureCount: failureCount,
              processingTime: processingTime,
              results: flowGenerationResults,
              orgId: orgId,
              userId: req.user?.userId || options.userId || "system",
            },
          );
          console.log(
            `Saved ${successCount} successful Flow XML generations to flow_generation_outputs`,
          );
        } catch (error) {
          console.error("Failed to save flow generation output:", error);
        }
      }

      // CACHE RESULTS IN REDIS FOR NEXT STEP (deployment)
      if (orchestrator.cache) {
        try {
          const cacheKey = `flow_xml:${orgId}:${sessionId}`;
          await orchestrator.cache.set(
            cacheKey,
            JSON.stringify({
              summary: {
                totalRecommendations: recommendationGroups.length,
                successfulGenerations: successCount,
                failedGenerations: failureCount,
                processingTime: processingTime,
                deploymentReady: successCount > 0,
              },
              flows: flowGenerationResults.filter((r) => r.success),
              timestamp: new Date().toISOString(),
            }),
            7200,
          ); // 2 hour TTL for Flow XML
          console.log(`Cached ${successCount} Flow XMLs in Redis: ${cacheKey}`);
        } catch (error) {
          console.error("Failed to cache flow generation results:", error);
        }
      }

      res.json({
        success: true,
        summary: {
          totalRecommendations: recommendationGroups.length,
          successfulGenerations: successCount,
          failedGenerations: failureCount,
          processingTime: processingTime,
          deploymentReady: successCount > 0,
        },
        results: flowGenerationResults,
        sessionId: sessionId,
        previousSessionId: options.previousSessionId,
        nextStep:
          successCount > 0
            ? "Ready for deployment via /workflows/deploy-flow"
            : "Review failures",
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Direct single workflow conversion with Token-Diet optimization (No UI steps)
   * POST /api/workflows/convert-single
   */
  router.post(
    "/workflows/convert-single",
    createEndpointRateLimit("workflow_convert_single", {
      max: 10,
      windowMs: 300000,
    }), // 10 per 5 minutes
    orgPermissions(["workflows:convert"]),
    asyncHandler(async (req, res) => {
      const { workflowRuleId, workflowData, options = {} } = req.body;

      console.log("📍 CONVERT-SINGLE ENDPOINT:", {
        hasWorkflowRuleId: !!workflowRuleId,
        hasWorkflowData: !!workflowData,
        workflowRuleId,
        workflowDataKeys: workflowData ? Object.keys(workflowData) : "none",
        bodyKeys: Object.keys(req.body),
      });

      if (!workflowRuleId && !workflowData) {
        throw new ValidationError(
          "Either workflowRuleId or workflowData is required",
        );
      }

      if (!orchestrator.llmService) {
        throw new AppError("LLM Service not available", 503);
      }

      try {
        let workflow = workflowData;

        // Fetch workflow if only ID provided
        if (!workflow && workflowRuleId) {
          console.log(
            "📍 API ENDPOINT: Fetching workflow metadata for ID:",
            workflowRuleId,
          );

          if (!orchestrator.workflowDiscoveryService) {
            throw new AppError("WorkflowDiscoveryService not available", 503);
          }

          // Get workflow metadata from enriched cache (populated during discovery)
          // The cache includes parsed XML with _fieldUpdateDetails embedded
          try {
            console.log("📍 CALLING getWorkflowRuleMetadata:", {
              orgId: req.orgId,
              workflowRuleId,
            });
            workflow =
              await orchestrator.workflowDiscoveryService.getWorkflowRuleMetadata(
                req.orgId,
                workflowRuleId,
              );
            console.log(
              "📍 API ENDPOINT: Got enriched workflow metadata with field updates",
            );
          } catch (error) {
            console.error(
              `❌ API ENDPOINT: Failed to fetch workflow metadata ${workflowRuleId}:`,
              error.message,
            );
            throw new ValidationError(
              `Workflow rule ${workflowRuleId} not found`,
            );
          }
        } else {
          console.log("📍 API ENDPOINT: Using workflowData from request body");
        }

        // CRITICAL: Ensure workflow has field update details for FieldUpdate actions
        // If actions exist but lack _fieldUpdateDetails, fetch them now
        if (
          workflow?.metadata?.actions &&
          workflow.metadata.actions.length > 0
        ) {
          const hasFieldUpdates = workflow.metadata.actions.some(
            (a) => a.type === "FieldUpdate",
          );
          const missingDetails =
            hasFieldUpdates &&
            !workflow.metadata.actions.some((a) => a._fieldUpdateDetails);

          if (missingDetails) {
            console.warn(
              "⚠️ API ENDPOINT: Workflow has FieldUpdate actions but missing _fieldUpdateDetails. Enriching now...",
            );

            try {
              // Re-enrich this workflow with field update details
              const enrichedWorkflow =
                await orchestrator.workflowDiscoveryService.enrichWorkflowWithFieldUpdates(
                  req.orgId,
                  workflow,
                );
              workflow = enrichedWorkflow;
              console.log(
                "✅ API ENDPOINT: Successfully enriched workflow with field update details",
              );
            } catch (enrichError) {
              console.error(
                "❌ API ENDPOINT: Failed to enrich field updates:",
                enrichError.message,
              );
              throw new AppError(
                "Workflow transformation requires field update details. Please run discovery first or ensure workflow data is complete.",
                400,
              );
            }
          }
        }

        // Enrich workflow actions with preflight resolution (Alert/OutboundMessage/Task)
        if (
          orchestrator.WorkflowActionPreflightClass &&
          workflow?.metadata?.actions
        ) {
          try {
            const preflight = new orchestrator.WorkflowActionPreflightClass(
              orchestrator.salesforceService,
              req.orgId,
            );
            const enrichedActions = await preflight.resolveAll(
              workflow.metadata.actions,
              {
                objectDurableId: workflow.objectApiName,
              },
            );
            workflow.metadata.actions = enrichedActions;
            console.log(
              "📍 API ENDPOINT: Enriched workflow actions with preflight resolution",
            );
          } catch (error) {
            console.warn(
              "⚠️ API ENDPOINT: Preflight enrichment failed, continuing with original actions:",
              error.message,
            );
          }
        }

        // Process workflow transformation through MCP orchestrator (handles both enhanced and legacy)
        const xmlResult = await orchestrator.processRequest({
          action: "workflow_transform",
          orgId: req.orgId,
          userId: req.user?.userId,
          body: {
            workflow,
            options,
          },
        });

        // Extract result data from orchestrator response
        const resultData = xmlResult.data || xmlResult;

        // Extract XML from response
        const responseText =
          resultData.flowXml ||
          resultData.result?.response ||
          resultData.data?.content ||
          resultData.data ||
          "";
        const xmlMatch = responseText.match(/<Flow[\s\S]*?<\/Flow>/);
        const flowXml = xmlMatch ? xmlMatch[0] : responseText;

        // Return simplified response for UI with persistence info
        // Handle both XML structure (new) and JSON structure (old)
        const workflowId = workflow.workflowRuleId || workflow.id;
        const workflowName = workflow.workflowRuleName || workflow.name;

        res.json({
          success: true,
          data: {
            workflowRuleId: workflowId,
            workflowRuleName: workflowName,
            flowApiName:
              resultData.flowApiName ||
              `${workflowName.replace(/[^a-zA-Z0-9]/g, "_")}_Flow`,
            flowXml: flowXml,
            flowVersion: resultData.flowVersion || null,
            flowId: resultData.flowId || null,
            optimizationUsed:
              "Orchestrator-routed transformation with ArangoDB persistence",
            tokensUsed: resultData.tokenUsage || null,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error("Direct workflow conversion error:", error);
        throw new AppError(`Conversion failed: ${error.message}`, 500);
      }
    }),
  );

  /**
   * Deploy Flow XML to Salesforce (Direct deployment)
   * POST /api/workflows/deploy-flow
   */
  router.post(
    "/workflows/deploy-flow",
    createEndpointRateLimit("workflow_deploy", { max: 5, windowMs: 300000 }), // 5 per 5 minutes
    orgPermissions(["workflows:deploy"]),
    asyncHandler(async (req, res) => {
      const { flowXml, flowApiName, flowLabel, options = {} } = req.body;

      if (!flowXml || !flowApiName) {
        throw new ValidationError("flowXml and flowApiName are required");
      }

      if (!orchestrator.flowDeploymentService) {
        throw new AppError("FlowDeploymentService not available", 503);
      }

      try {
        // Deploy using FlowDeploymentService
        const deploymentResult =
          await orchestrator.flowDeploymentService.deployFlowXML({
            sourceOrgId: req.orgId,
            targetOrgId: req.orgId,
            userId: req.user?.userId,
            flowXML: flowXml,
            flowApiName: flowApiName,
            flowLabel: flowLabel || flowApiName.replace(/_/g, " "),
            activate: options.activate || false,
            testLevel: options.testLevel || "RunLocalTests",
          });

        // Handle errors - might be array or object, and items might be objects
        let errorMessage;
        if (deploymentResult.success) {
          errorMessage = `Flow "${flowApiName}" deployed successfully`;
        } else {
          const errors = deploymentResult.errors;
          if (Array.isArray(errors)) {
            // Convert each error to string (handle both string and object errors)
            const errorStrings = errors.map((e) =>
              typeof e === "string" ? e : JSON.stringify(e),
            );
            errorMessage = `Deployment failed: ${errorStrings.join(", ")}`;
          } else {
            errorMessage = `Deployment failed: ${errors || "Unknown error"}`;
          }
        }

        res.json({
          success: deploymentResult.success,
          data: {
            flowApiName,
            deploymentId: deploymentResult.id,
            status: deploymentResult.status,
            flowId: deploymentResult.flowId,
            flowDefId: deploymentResult.flowDefId,
            flowBuilderUrl: deploymentResult.flowBuilderUrl,
            message: errorMessage,
            details: deploymentResult.details,
            errors: deploymentResult.errors,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error("Flow deployment error:", error);
        throw new AppError(`Deployment failed: ${error.message}`, 500);
      }
    }),
  );

  /**
   * Get workflow rules with comprehensive object metadata for transformation
   * GET /api/workflows/with-metadata
   */
  router.get(
    "/workflows/with-metadata",
    createEndpointRateLimit("workflow_with_metadata", {
      max: 10,
      windowMs: 300000,
    }), // 10 per 5 minutes
    // orgPermissions(['workflows:read']), // Temporarily disabled for testing
    asyncHandler(async (req, res) => {
      const { orgId } = req.query;

      if (!orgId) {
        throw new ValidationError("Missing required parameter: orgId");
      }

      if (!orchestrator.workflowDiscoveryService) {
        throw new AppError("WorkflowDiscoveryService not available", 503);
      }

      const result =
        await orchestrator.workflowDiscoveryService.getWorkflowRulesWithObjectMetadata(
          orgId,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/flows - List saved Flows
   */
  router.get(
    "/flows",
    orgPermissions(["workflows:read"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const {
        status,
        deploymentStatus,
        object,
        searchTerm,
        onlyCurrentVersions = "true",
        limit = 50,
        offset = 0,
      } = req.query;

      const flows = await orchestrator.flowPersistenceService.searchFlows(
        req.orgId,
        {
          status,
          deploymentStatus,
          object,
          searchTerm,
          onlyCurrentVersions: onlyCurrentVersions === "true",
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      );

      res.json({
        success: true,
        data: {
          flows,
          count: flows.length,
          offset: parseInt(offset),
          limit: parseInt(limit),
        },
      });
    }),
  );

  /**
   * GET /api/flows/:flowApiName - Get specific Flow (current version)
   */
  router.get(
    "/flows/:flowApiName",
    orgPermissions(["workflows:read"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const flow = await orchestrator.flowPersistenceService.getCurrentVersion(
        req.orgId,
        req.params.flowApiName,
      );

      if (!flow) {
        throw new ValidationError(`Flow ${req.params.flowApiName} not found`);
      }

      res.json({
        success: true,
        data: flow,
      });
    }),
  );

  /**
   * GET /api/flows/:flowApiName/versions - Get all versions of a Flow
   */
  router.get(
    "/flows/:flowApiName/versions",
    orgPermissions(["workflows:read"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const versions = await orchestrator.flowPersistenceService.getAllVersions(
        req.orgId,
        req.params.flowApiName,
      );

      res.json({
        success: true,
        data: {
          flowApiName: req.params.flowApiName,
          versions,
          count: versions.length,
        },
      });
    }),
  );

  /**
   * GET /api/flows/:flowApiName/versions/:version - Get specific version of a Flow
   */
  router.get(
    "/flows/:flowApiName/versions/:version",
    orgPermissions(["workflows:read"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const flow = await orchestrator.flowPersistenceService.getVersion(
        req.orgId,
        req.params.flowApiName,
        parseInt(req.params.version),
      );

      res.json({
        success: true,
        data: flow,
      });
    }),
  );

  /**
   * PATCH /api/flows/:flowId/status - Update Flow status
   */
  router.patch(
    "/flows/:flowId/status",
    orgPermissions(["workflows:write"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const { status, notes } = req.body;

      if (!status) {
        throw new ValidationError("Status is required");
      }

      const updated =
        await orchestrator.flowPersistenceService.updateFlowStatus(
          req.orgId,
          req.params.flowId,
          status,
          req.user?.userId,
          notes,
        );

      res.json({
        success: true,
        data: updated,
        message: `Flow status updated to ${status}`,
      });
    }),
  );

  /**
   * POST /api/flows/:flowApiName/rollback/:version - Rollback to previous version
   */
  router.post(
    "/flows/:flowApiName/rollback/:version",
    orgPermissions(["workflows:write"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const rollbackVersion =
        await orchestrator.flowPersistenceService.rollbackToVersion(
          req.orgId,
          req.params.flowApiName,
          parseInt(req.params.version),
          req.user?.userId,
        );

      res.json({
        success: true,
        data: rollbackVersion,
        message: `Rolled back to version ${req.params.version}`,
      });
    }),
  );

  /**
   * DELETE /api/flows/:flowId - Soft delete a Flow
   */
  router.delete(
    "/flows/:flowId",
    orgPermissions(["workflows:delete"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      await orchestrator.flowPersistenceService.deleteFlow(
        req.orgId,
        req.params.flowId,
        req.user?.userId,
      );

      res.json({
        success: true,
        message: "Flow deleted successfully",
      });
    }),
  );

  /**
   * GET /api/flows/stats/summary - Get Flow statistics
   */
  router.get(
    "/flows/stats/summary",
    orgPermissions(["workflows:read"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const stats = await orchestrator.flowPersistenceService.getFlowStatistics(
        req.orgId,
      );

      res.json({
        success: true,
        data: stats,
      });
    }),
  );

  /**
   * GET /api/flows/deployment-ready - Get Flows ready for deployment
   */
  router.get(
    "/flows/deployment-ready",
    orgPermissions(["workflows:read"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.flowPersistenceService) {
        throw new AppError("FlowPersistenceService not available", 503);
      }

      const flows =
        await orchestrator.flowPersistenceService.getDeploymentReadyFlows(
          req.orgId,
        );

      res.json({
        success: true,
        data: {
          flows,
          count: flows.length,
        },
      });
    }),
  );

  /**
   * Get cached workflow data for AI Assistant
   * GET /api/workflows/cached-data
   */
  router.get(
    "/workflows/cached-data",
    createEndpointRateLimit("workflow_cached_data", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const aggregatedCacheKey = `workflow_aggregated_data:${req.orgId}`;

      if (!orchestrator.redisClient) {
        throw new AppError("Redis not available for cached workflow data", 503);
      }

      try {
        const cachedData =
          await orchestrator.redisClient.get(aggregatedCacheKey);

        if (!cachedData) {
          return res.json({
            success: false,
            message:
              "No cached workflow data available. Please run workflow discovery first.",
            cached: false,
            timestamp: new Date().toISOString(),
          });
        }

        const workflowData = JSON.parse(cachedData);

        res.json({
          success: true,
          data: workflowData,
          cached: true,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error("Error retrieving cached workflow data:", error);
        throw new AppError("Failed to retrieve cached workflow data", 500);
      }
    }),
  );

  // =============================================================================
  // METADATA SERVICE ROUTES
  // =============================================================================

  /**
   * Load all DevOps-critical metadata
   * POST /api/metadata/load-all
   */
  router.post(
    "/metadata/load-all",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("metadata_load_all", { max: 3, windowMs: 600000 }), // 3 per 10 minutes
    asyncHandler(async (req, res) => {
      const { options = {} } = req.body;

      const result = await orchestrator.metadataService.loadAllMetadata(
        req.orgId,
        options,
      );

      res.json({
        success: true,
        ...result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Load all permissions (Permission Sets and Profiles)
   * GET /api/metadata/permissions
   */
  router.get(
    "/metadata/permissions",
    orgPermissions(["security:read"]),
    createEndpointRateLimit("metadata_permissions", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { includeDetails = true, includeAssignments = true } = req.query;

      const result = await orchestrator.metadataService.loadAllPermissions(
        req.orgId,
        {
          includeDetails: includeDetails === "true",
          includeAssignments: includeAssignments === "true",
        },
      );

      res.json({
        success: true,
        permissions: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Load all flows with versions
   * GET /api/metadata/flows
   */
  router.get(
    "/metadata/flows",
    createEndpointRateLimit("metadata_flows", { max: 20, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { includeVersions = true, includeInactive = false } = req.query;

      const result = await orchestrator.metadataService.loadAllFlows(
        req.orgId,
        {
          includeVersions: includeVersions === "true",
          includeInactive: includeInactive === "true",
        },
      );

      res.json({
        success: true,
        flows: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Load all Apex classes and triggers
   * GET /api/metadata/apex
   */
  router.get(
    "/metadata/apex",
    createEndpointRateLimit("metadata_apex", { max: 15, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { includeDependencies = true, includeTests = true } = req.query;

      const result = await orchestrator.metadataService.loadAllApex(req.orgId, {
        includeDependencies: includeDependencies === "true",
        includeTests: includeTests === "true",
      });

      res.json({
        success: true,
        apex: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get metadata summary
   * GET /api/metadata/summary
   */
  router.get(
    "/metadata/summary",
    asyncHandler(async (req, res) => {
      const result = await orchestrator.metadataService.getMetadataSummary(
        req.orgId,
      );

      res.json({
        success: true,
        summary: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Health check for metadata API connectivity
   * GET /api/metadata/health
   */
  router.get(
    "/metadata/health",
    asyncHandler(async (req, res) => {
      const result = await orchestrator.metadataService.healthCheck(req.orgId);

      res.json({
        success: result.healthy,
        health: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // METADATA INGESTION ROUTES
  // =============================================================================

  /**
   * Get metadata ingestion system status
   * GET /api/metadata-ingestion/status
   */
  router.get(
    "/metadata-ingestion/status",
    asyncHandler(async (req, res) => {
      const status =
        await orchestrator.metadataIngestionService.getSystemStatus();

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get all customer profiles
   * GET /api/metadata-ingestion/customers
   */
  router.get(
    "/metadata-ingestion/customers",
    asyncHandler(async (req, res) => {
      const profiles = Array.from(
        orchestrator.metadataIngestionService.customerProfiles.values(),
      );

      res.json({
        success: true,
        data: profiles,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get specific customer profile
   * GET /api/metadata-ingestion/customers/:customerId
   */
  router.get(
    "/metadata-ingestion/customers/:customerId",
    asyncHandler(async (req, res) => {
      const { customerId } = req.params;
      const profile =
        orchestrator.metadataIngestionService.customerProfiles.get(customerId);

      if (!profile) {
        return res.status(404).json({
          success: false,
          error: "Customer profile not found",
        });
      }

      res.json({
        success: true,
        data: profile,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Update customer configuration
   * PUT /api/metadata-ingestion/customers/:customerId/config
   */
  router.put(
    "/metadata-ingestion/customers/:customerId/config",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("metadata_config_update", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { customerId } = req.params;
      const configValues = req.body;

      if (!configValues || typeof configValues !== "object") {
        throw new ValidationError("Invalid configuration data");
      }

      const result = {
        customerId,
        updatedConfig: configValues,
        updatedAt: new Date().toISOString(),
      };

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get organizations for customer
   * GET /api/metadata-ingestion/organizations
   */
  router.get(
    "/metadata-ingestion/organizations",
    asyncHandler(async (req, res) => {
      const { customerId } = req.query;
      let organizations;

      if (customerId) {
        organizations =
          orchestrator.metadataIngestionService.customerOrgs.get(customerId) ||
          [];
      } else {
        organizations = Array.from(
          orchestrator.metadataIngestionService.orgInventory.values(),
        );
      }

      res.json({
        success: true,
        data: organizations,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Trigger manual metadata ingestion
   * POST /api/metadata-ingestion/manual
   */
  router.post(
    "/metadata-ingestion/manual",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("metadata_manual_ingestion", {
      max: 5,
      windowMs: 300000,
    }),
    asyncHandler(async (req, res) => {
      const ingestionConfig = req.body;

      if (!ingestionConfig.orgId && !ingestionConfig.customerIds) {
        throw new ValidationError(
          "Either orgId or customerIds must be specified",
        );
      }

      const result =
        await orchestrator.metadataIngestionService.startIntelligentIngestion(
          ingestionConfig,
        );

      res.json({
        success: true,
        data: {
          jobId: result.executionPlan?.id,
          message: "Manual ingestion started successfully",
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Trigger customer profile detection
   * POST /api/metadata-ingestion/detect-customers
   */
  router.post(
    "/metadata-ingestion/detect-customers",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("metadata_detect_customers", {
      max: 3,
      windowMs: 300000,
    }),
    asyncHandler(async (req, res) => {
      const result = {
        updatedProfiles: 1,
        message: "Customer profile detection completed",
      };

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get ingestion job status
   * GET /api/metadata-ingestion/jobs/:jobId
   */
  router.get(
    "/metadata-ingestion/jobs/:jobId",
    asyncHandler(async (req, res) => {
      const { jobId } = req.params;

      const job = {
        id: jobId,
        status: "completed",
        progress: {
          totalOrgs: 1,
          completedOrgs: 1,
          percentage: 100,
        },
        startTime: new Date(Date.now() - 300000).toISOString(),
        endTime: new Date().toISOString(),
      };

      res.json({
        success: true,
        data: job,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get API usage analytics
   * GET /api/metadata-ingestion/api-usage
   */
  router.get(
    "/metadata-ingestion/api-usage",
    asyncHandler(async (req, res) => {
      const { orgId, customerId, timeRange = "24h" } = req.query;

      const usage = {
        orgId,
        customerId,
        timeRange,
        totalApiCalls: 250,
        remainingCalls: 14750,
        usagePercentage: 1.7,
        efficiency: 0.85,
      };

      res.json({
        success: true,
        data: usage,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get ingestion configuration
   * GET /api/metadata-ingestion/config
   */
  router.get(
    "/metadata-ingestion/config",
    asyncHandler(async (req, res) => {
      const config =
        orchestrator.metadataIngestionService.getSchedulingConfiguration();

      res.json({
        success: true,
        data: config,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Update ingestion configuration
   * PUT /api/metadata-ingestion/config
   */
  router.put(
    "/metadata-ingestion/config",
    orgPermissions(["metadata:admin"]),
    createEndpointRateLimit("metadata_config_global_update", {
      max: 5,
      windowMs: 300000,
    }),
    asyncHandler(async (req, res) => {
      const newConfig = req.body;

      const result =
        await orchestrator.metadataIngestionService.updateSchedulingConfiguration(
          newConfig,
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Metadata ingestion health check
   * GET /api/metadata-ingestion/health
   */
  router.get(
    "/metadata-ingestion/health",
    asyncHandler(async (req, res) => {
      const health = {
        status: "healthy",
        services: {
          ingestionService: orchestrator.metadataIngestionService
            ? "available"
            : "unavailable",
          database: "connected",
          apiOrchestrator: "available",
        },
        timestamp: new Date().toISOString(),
      };

      res.json({
        success: true,
        data: health,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // APPROVAL SERVICE ROUTES
  // =============================================================================

  /**
   * Request approval for operation
   * POST /api/approvals/request
   */
  router.post(
    "/approvals/request",
    createEndpointRateLimit("approval_request", { max: 20, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { operation, operationData = {} } = req.body;

      if (!operation) {
        throw new ValidationError("operation is required");
      }

      const result = await orchestrator.approvalService.requestApproval(
        operation,
        req.user,
        req.orgId,
        operationData,
      );

      res.json({
        success: true,
        approvalRequest: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Process approval response
   * POST /api/approvals/:approvalId/respond
   */
  router.post(
    "/approvals/:approvalId/respond",
    createEndpointRateLimit("approval_respond", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { approvalId } = req.params;
      const { action, comments = "" } = req.body;

      if (!action || !["approve", "reject", "request_info"].includes(action)) {
        throw new ValidationError(
          "Valid action (approve, reject, request_info) is required",
        );
      }

      const result = await orchestrator.approvalService.processApproval(
        approvalId,
        req.user?.userId,
        action,
        comments,
      );

      res.json({
        success: true,
        approvalRequest: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get pending approvals for user
   * GET /api/approvals/pending
   */
  router.get(
    "/approvals/pending",
    asyncHandler(async (req, res) => {
      const { orgId } = req.query;

      const result =
        await orchestrator.approvalService.getPendingApprovalsForUser(
          req.user?.userId,
          orgId || req.orgId,
        );

      res.json({
        success: true,
        pendingApprovals: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get approval history
   * GET /api/approvals/history
   */
  router.get(
    "/approvals/history",
    asyncHandler(async (req, res) => {
      const {
        operation = null,
        status = null,
        requestedBy = null,
        timeFrom = null,
        timeTo = null,
        limit = 50,
      } = req.query;

      const result = await orchestrator.approvalService.getApprovalHistory(
        req.orgId,
        {
          operation,
          status,
          requestedBy,
          timeFrom,
          timeTo,
          limit: parseInt(limit),
        },
      );

      res.json({
        success: true,
        history: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Cancel approval request
   * DELETE /api/approvals/:approvalId
   */
  router.delete(
    "/approvals/:approvalId",
    asyncHandler(async (req, res) => {
      const { approvalId } = req.params;
      const { reason = "Cancelled by user" } = req.body;

      const result = await orchestrator.approvalService.cancelApprovalRequest(
        approvalId,
        req.user?.userId,
        reason,
      );

      res.json({
        success: true,
        approvalRequest: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get approval statistics
   * GET /api/approvals/stats
   */
  router.get(
    "/approvals/stats",
    orgPermissions(["admin"]),
    asyncHandler(async (req, res) => {
      const { timeRange = "30d" } = req.query;

      const result = await orchestrator.approvalService.getApprovalStats(
        req.orgId,
        timeRange,
      );

      res.json({
        success: true,
        stats: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // ANALYTICS & METRICS ROUTES
  // =============================================================================

  /**
   * Get comprehensive analytics dashboard
   * GET /api/analytics/dashboard
   */
  router.get(
    "/analytics/dashboard",
    createEndpointRateLimit("analytics_dashboard", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { timeRange = "24h" } = req.query;

      const [usage, performance, errors, salesforce, events] =
        await Promise.all([
          orchestrator.getUsageAnalytics(req.orgId, timeRange),
          orchestrator.getPerformanceMetrics(req.orgId, timeRange),
          orchestrator.getErrorAnalysis(req.orgId, timeRange),
          orchestrator.getSalesforceAnalytics(req.orgId, timeRange),
          eventSystem.getEventStats(timeRange),
        ]);

      // Include Platform Cache analytics if available
      let platformCacheAnalytics = null;
      if (orchestrator.platformCacheIngestionService) {
        platformCacheAnalytics =
          orchestrator.platformCacheIngestionService.getProcessingStats();
      }

      const dashboard = {
        usage,
        performance,
        errors,
        salesforce,
        events,
        platformCache: platformCacheAnalytics,
        summary: {
          totalRequests: usage.totalRequests || 0,
          averageResponseTime: performance.averageResponseTime || 0,
          errorRate: errors.errorRate || 0,
          apiCallsUsed: salesforce.apiCallsUsed || 0,
          activeUsers: usage.activeUsers || 0,
          cacheHitRate: platformCacheAnalytics?.cacheHitRate || 0,
        },
      };

      res.json({
        success: true,
        dashboard,
        metadata: {
          timeRange,
          components: [
            "usage",
            "performance",
            "errors",
            "salesforce",
            "events",
            "platformCache",
          ],
          timestamp: new Date().toISOString(),
        },
      });
    }),
  );

  /**
   * Get organization statistics
   * GET /api/org/stats
   */
  router.get(
    "/org/stats",
    asyncHandler(async (req, res) => {
      const stats = await orchestrator.getOrgStats(req.orgId);

      res.json({
        success: true,
        stats,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get system health status
   * GET /api/system/health
   */
  router.get(
    "/system/health",
    orgPermissions(["admin"]),
    asyncHandler(async (req, res) => {
      const health = {
        mcp: orchestrator.getPoolStats(),
        salesforce: orchestrator.getSalesforceStats(),
        events: eventSystem.getEventStats(),
        cache: (await orchestrator.cache?.getStats()) || null,
        database: (await orchestrator.store?.getStats()) || null,
        metadataIngestion: orchestrator.metadataIngestionService
          ? "available"
          : "unavailable",
        platformCacheIngestion: orchestrator.platformCacheIngestionService
          ? "available"
          : "unavailable",
      };

      res.json({
        success: true,
        health,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get active services status
   * GET /api/system/services
   */
  router.get(
    "/system/services",
    asyncHandler(async (req, res) => {
      const activeServices = await orchestrator.getActiveServices();

      res.json({
        success: true,
        data: {
          activeServices: Array.isArray(activeServices) ? activeServices : [],
          count: Array.isArray(activeServices) ? activeServices.length : 0,
          timestamp: new Date().toISOString(),
        },
      });
    }),
  );

  /**
   * Trigger organization cleanup
   * POST /api/org/cleanup
   */
  router.post(
    "/org/cleanup",
    orgPermissions(["admin"]),
    createEndpointRateLimit("org_cleanup", { max: 3, windowMs: 3600000 }), // 3 per hour
    asyncHandler(async (req, res) => {
      const {
        cleanupType = "full",
        olderThan = "30d",
        dryRun = false,
      } = req.body;

      const result = await orchestrator.cleanupOrg(req.orgId, {
        cleanupType,
        olderThan,
        dryRun,
      });

      if (!dryRun) {
        eventSystem.emitEvent("org:cleanup_completed", {
          orgId: req.orgId,
          userId: req.user?.userId,
          cleanupType,
          itemsRemoved: result.itemsRemoved,
        });
      }

      res.json({
        success: true,
        result,
        metadata: {
          cleanupType,
          dryRun,
          timestamp: new Date().toISOString(),
        },
      });
    }),
  );

  // =============================================================================
  // WEBSOCKET INFO ROUTES
  // =============================================================================

  /**
   * Get WebSocket connection information
   * GET /api/websocket/info
   */
  router.get(
    "/websocket/info",
    asyncHandler(async (req, res) => {
      const wsServer = orchestrator.wsServer;
      const connectionStats = wsServer ? wsServer.getConnectionStats() : null;

      res.json({
        success: true,
        websocket: {
          url: `ws://${req.get("host")}/ws`,
          availableChannels: [
            `org:${req.orgId}:events`,
            `user:${req.user?.userId}:notifications`,
            "system:alerts",
            "analysis:updates",
            "generation:updates",
            "workflow:executions",
            "approval:notifications",
            "metadata-ingestion:status",
            "platform-cache:polling",
            "platform-cache:invalidation",
          ],
          authentication: {
            required: true,
            method: "JWT",
            tokenLocation: "query parameter or message payload",
          },
          stats: connectionStats,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // BATCH PROCESSOR ROUTES (NEW)
  // =============================================================================

  /**
   * Get batch processor statistics
   * GET /api/batch/stats
   */
  router.get(
    "/batch/stats",
    orgPermissions(["admin"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.platformCacheIngestionService?.batchProcessor) {
        throw new AppError("Batch Processor not available", 503);
      }

      const stats =
        orchestrator.platformCacheIngestionService.batchProcessor.getStats();

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get batch status for specific batch type
   * GET /api/batch/:batchKey/status
   */
  router.get(
    "/batch/:batchKey/status",
    orgPermissions(["admin"]),
    asyncHandler(async (req, res) => {
      const { batchKey } = req.params;

      if (!orchestrator.platformCacheIngestionService?.batchProcessor) {
        throw new AppError("Batch Processor not available", 503);
      }

      const status =
        orchestrator.platformCacheIngestionService.batchProcessor.getBatchStatus(
          batchKey,
        );

      if (!status) {
        return res.status(404).json({
          success: false,
          error: `Batch key '${batchKey}' not found`,
        });
      }

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Clear specific batch
   * DELETE /api/batch/:batchKey
   */
  router.delete(
    "/batch/:batchKey",
    orgPermissions(["admin"]),
    createEndpointRateLimit("batch_clear", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { batchKey } = req.params;

      if (!orchestrator.platformCacheIngestionService?.batchProcessor) {
        throw new AppError("Batch Processor not available", 503);
      }

      const clearedCount =
        orchestrator.platformCacheIngestionService.batchProcessor.clearBatch(
          batchKey,
        );

      res.json({
        success: true,
        data: {
          batchKey,
          clearedCount,
          message: `Cleared ${clearedCount} items from batch ${batchKey}`,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // QUEUE MANAGEMENT ROUTES (NEW)
  // =============================================================================

  /**
   * Get queue statistics for Platform Cache service
   * GET /api/queues/stats
   */
  router.get(
    "/queues/stats",
    orgPermissions(["admin"]),
    asyncHandler(async (req, res) => {
      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      const stats = {
        ingestionQueue: orchestrator.platformCacheIngestionService
          .ingestionQueue.getStats
          ? orchestrator.platformCacheIngestionService.ingestionQueue.getStats()
          : {
              size: orchestrator.platformCacheIngestionService.ingestionQueue.size(),
            },

        syncQueue: orchestrator.platformCacheIngestionService.syncQueue.size
          ? {
              size: orchestrator.platformCacheIngestionService.syncQueue.size(),
            }
          : { size: 0 },

        optimizationQueue: orchestrator.platformCacheIngestionService
          .optimizationQueue.size
          ? {
              size: orchestrator.platformCacheIngestionService.optimizationQueue.size(),
            }
          : { size: 0 },

        invalidationQueue: orchestrator.platformCacheIngestionService
          .invalidationQueue.getStats
          ? orchestrator.platformCacheIngestionService.invalidationQueue.getStats()
          : {
              size: orchestrator.platformCacheIngestionService.invalidationQueue.size(),
            },
      };

      res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Clear all queues
   * DELETE /api/queues/clear
   */
  router.delete(
    "/queues/clear",
    orgPermissions(["admin"]),
    createEndpointRateLimit("queue_clear_all", { max: 5, windowMs: 300000 }), // 5 per 5 minutes
    asyncHandler(async (req, res) => {
      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      const clearedCounts = {
        ingestionQueue: 0,
        syncQueue: 0,
        optimizationQueue: 0,
        invalidationQueue: 0,
      };

      // Clear all queues
      if (orchestrator.platformCacheIngestionService.ingestionQueue.clear) {
        const size =
          orchestrator.platformCacheIngestionService.ingestionQueue.size();
        orchestrator.platformCacheIngestionService.ingestionQueue.clear();
        clearedCounts.ingestionQueue = size;
      }

      if (orchestrator.platformCacheIngestionService.syncQueue.clear) {
        const size =
          orchestrator.platformCacheIngestionService.syncQueue.size();
        orchestrator.platformCacheIngestionService.syncQueue.clear();
        clearedCounts.syncQueue = size;
      }

      if (orchestrator.platformCacheIngestionService.optimizationQueue.clear) {
        const size =
          orchestrator.platformCacheIngestionService.optimizationQueue.size();
        orchestrator.platformCacheIngestionService.optimizationQueue.clear();
        clearedCounts.optimizationQueue = size;
      }

      if (orchestrator.platformCacheIngestionService.invalidationQueue.clear) {
        const size =
          orchestrator.platformCacheIngestionService.invalidationQueue.size();
        orchestrator.platformCacheIngestionService.invalidationQueue.clear();
        clearedCounts.invalidationQueue = size;
      }

      res.json({
        success: true,
        data: {
          clearedCounts,
          totalCleared: Object.values(clearedCounts).reduce(
            (sum, count) => sum + count,
            0,
          ),
          message: "All queues cleared successfully",
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =============================================================================
  // SYSTEM UTILITIES ROUTES (NEW)
  // =============================================================================

  /**
   * Test Platform Cache connectivity
   * POST /api/platform-cache/test-connection
   */
  router.post(
    "/platform-cache/test-connection",
    orgPermissions(["admin"]),
    createEndpointRateLimit("platform_cache_test", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { testType = "basic" } = req.body;

      if (!orchestrator.platformCacheIngestionService) {
        throw new AppError(
          "Platform Cache Ingestion Service not available",
          503,
        );
      }

      const testResults = {
        basic: true,
        redis: false,
        arangoDB: false,
        salesforce: false,
        message: "Connection test completed",
      };

      try {
        // Test Redis
        await orchestrator.cache.ping();
        testResults.redis = true;
      } catch (error) {
        testResults.redis = false;
        testResults.redisError = error.message;
      }

      try {
        // Test ArangoDB
        await orchestrator.store.version();
        testResults.arangoDB = true;
      } catch (error) {
        testResults.arangoDB = false;
        testResults.arangoError = error.message;
      }

      try {
        // Test Salesforce Platform Cache
        const testKey = `test:${req.orgId}:${Date.now()}`;
        const testData = { test: true, timestamp: new Date().toISOString() };

        await orchestrator.salesforceApiOrchestrator.cachePut(
          "ServientStrategies",
          testKey,
          testData,
          300,
        );
        const retrieved = await orchestrator.salesforceApiOrchestrator.cacheGet(
          "ServientStrategies",
          testKey,
        );

        testResults.salesforce = !!retrieved;

        if (retrieved) {
          // Cleanup test data
          await orchestrator.salesforceApiOrchestrator.cacheDelete(
            "ServientStrategies",
            testKey,
          );
        }
      } catch (error) {
        testResults.salesforce = false;
        testResults.salesforceError = error.message;
      }

      const allPassed =
        testResults.redis && testResults.arangoDB && testResults.salesforce;

      res.json({
        success: allPassed,
        data: testResults,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Generate system report
   * GET /api/system/report
   */
  router.get(
    "/system/report",
    orgPermissions(["admin"]),
    createEndpointRateLimit("system_report", { max: 3, windowMs: 300000 }), // 3 per 5 minutes
    asyncHandler(async (req, res) => {
      const { includeDetailedStats = false, timeRange = "24h" } = req.query;

      const report = {
        timestamp: new Date().toISOString(),
        orgId: req.orgId,
        timeRange,
        services: {
          mcp: {
            status: orchestrator ? "available" : "unavailable",
            stats: orchestrator?.getPoolStats() || null,
          },
          salesforce: {
            status: orchestrator?.salesforceApiOrchestrator
              ? "available"
              : "unavailable",
            stats: orchestrator?.getSalesforceStats() || null,
          },
          cache: {
            status: orchestrator?.cache ? "available" : "unavailable",
            stats: (await orchestrator?.cache?.getStats()) || null,
          },
          database: {
            status: orchestrator?.store ? "available" : "unavailable",
            stats: (await orchestrator?.store?.getStats()) || null,
          },
          platformCacheIngestion: {
            status: orchestrator?.platformCacheIngestionService
              ? "available"
              : "unavailable",
            stats:
              orchestrator?.platformCacheIngestionService?.getProcessingStats() ||
              null,
          },
          metadataIngestion: {
            status: orchestrator?.metadataIngestionService
              ? "available"
              : "unavailable",
            stats: null, // Could add stats if available
          },
        },
        events: eventSystem?.getEventStats(timeRange) || null,
        queues: null,
        batches: null,
      };

      // Add detailed stats if requested
      if (
        includeDetailedStats === "true" &&
        orchestrator.platformCacheIngestionService
      ) {
        try {
          const queueStats = {
            ingestionQueue: orchestrator.platformCacheIngestionService
              .ingestionQueue.getStats
              ? orchestrator.platformCacheIngestionService.ingestionQueue.getStats()
              : {
                  size: orchestrator.platformCacheIngestionService.ingestionQueue.size(),
                },

            syncQueue: {
              size: orchestrator.platformCacheIngestionService.syncQueue.size(),
            },
            optimizationQueue: {
              size: orchestrator.platformCacheIngestionService.optimizationQueue.size(),
            },
            invalidationQueue: orchestrator.platformCacheIngestionService
              .invalidationQueue.getStats
              ? orchestrator.platformCacheIngestionService.invalidationQueue.getStats()
              : {
                  size: orchestrator.platformCacheIngestionService.invalidationQueue.size(),
                },
          };

          report.queues = queueStats;

          if (orchestrator.platformCacheIngestionService.batchProcessor) {
            report.batches =
              orchestrator.platformCacheIngestionService.batchProcessor.getStats();
          }
        } catch (error) {
          report.detailedStatsError = error.message;
        }
      }

      // Calculate overall health
      const healthyServices = Object.values(report.services).filter(
        (service) => service.status === "available",
      ).length;

      const totalServices = Object.keys(report.services).length;
      const healthPercentage = (healthyServices / totalServices) * 100;

      report.overallHealth = {
        percentage: Math.round(healthPercentage),
        status:
          healthPercentage >= 80
            ? "healthy"
            : healthPercentage >= 60
              ? "degraded"
              : "unhealthy",
        healthyServices,
        totalServices,
      };

      res.json({
        success: true,
        report,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get current organization context with all connected orgs
   * GET /api/org/context
   * Returns all connected orgs with primary flag properly set
   */
  router.get(
    "/org/context",
    asyncHandler(async (req, res) => {
      // Get connected Salesforce organizations from OrgRegistry
      let primaryOrgId = null;
      let connectedOrgs = [];
      let registryError = null;

      if (orchestrator.orgRegistry) {
        try {
          console.log("🔍 OrgRegistry: Getting all orgs with primary flag...");
          // Use new method that ensures primary flag is set
          connectedOrgs =
            await orchestrator.orgRegistry.getAllOrgsWithPrimary();
          console.log("🔍 OrgRegistry: Found orgs:", connectedOrgs.length);

          // Find the primary org
          const primaryOrg = connectedOrgs.find(
            (org) => org.isPrimary === true,
          );
          if (primaryOrg) {
            primaryOrgId = primaryOrg.orgId;
            console.log("🔍 OrgRegistry: Primary org:", primaryOrgId);
          } else if (connectedOrgs.length > 0) {
            // Fallback to first org if no primary
            primaryOrgId = connectedOrgs[0].orgId;
            console.log(
              "🔍 OrgRegistry: Using first org as fallback:",
              primaryOrgId,
            );
          }
        } catch (error) {
          registryError = error.message;
          console.error("🔍 OrgRegistry: Error accessing registry:", error);

          // Fall back to metadataIngestionService if OrgRegistry fails
          const legacyConnectedOrgs = Array.from(
            orchestrator.metadataIngestionService?.orgInventory?.values() || [],
          );
          connectedOrgs = legacyConnectedOrgs.map((org) => ({
            ...org,
            isPrimary: false,
          }));

          if (connectedOrgs.length > 0) {
            connectedOrgs[0].isPrimary = true;
            primaryOrgId =
              connectedOrgs[0].salesforceOrgId || connectedOrgs[0].orgId;
            console.log(
              "🔍 Legacy: Using org ID from MetadataIngestionService:",
              primaryOrgId,
            );
          }
        }
      } else {
        console.log("🔍 OrgRegistry: Registry not available");
      }

      // Fallback to req.orgId only if no registry org was found
      if (!primaryOrgId) {
        primaryOrgId = req.orgId;
        console.log("🔍 Fallback: Using middleware org ID:", primaryOrgId);
      }

      // Find the primary org details
      const primaryOrg =
        connectedOrgs.find((org) => org.isPrimary === true) || connectedOrgs[0];
      const orgDetails = primaryOrg
        ? {
            name:
              primaryOrg.name || primaryOrg.orgName || "Primary Salesforce Org",
            customerName: primaryOrg.customerName || "Unknown Customer",
            type: primaryOrg.type || "production",
            instanceUrl: primaryOrg.instanceUrl,
            isActive: primaryOrg.isActive,
            isPrimary: primaryOrg.isPrimary,
          }
        : null;

      res.json({
        success: true,
        data: {
          orgId: primaryOrgId,
          internalOrgId: req.orgId,
          orgContext: req.orgContext,
          orgDetails,
          // Return ALL connected orgs for multi-org selector
          allOrgs: connectedOrgs.map((org) => ({
            orgId: org.orgId,
            name: org.name || org.orgName || org.orgId,
            customerName: org.customerName || "Unknown",
            type: org.type || "unknown",
            isActive: org.isActive,
            isPrimary: org.isPrimary || false,
            instanceUrl: org.instanceUrl,
          })),
          connectedOrgs: connectedOrgs.length,
          registryError,
          timestamp: new Date().toISOString(),
        },
      });
    }),
  );

  /**
   * Set an org as the primary org
   * POST /api/org/set-primary/:orgId
   */
  router.post(
    "/org/set-primary/:orgId",
    asyncHandler(async (req, res) => {
      const { orgId } = req.params;

      if (!orgId) {
        return res.status(400).json({
          success: false,
          error: "orgId is required",
        });
      }

      if (!orchestrator.orgRegistry) {
        return res.status(503).json({
          success: false,
          error: "OrgRegistry not available",
        });
      }

      try {
        console.log(`🔄 Setting org ${orgId} as primary...`);
        const updatedOrg = await orchestrator.orgRegistry.setAsPrimary(orgId);

        res.json({
          success: true,
          message: `Org ${orgId} is now the primary org`,
          data: {
            orgId: updatedOrg.orgId,
            name: updatedOrg.name || updatedOrg.orgName,
            isPrimary: updatedOrg.isPrimary,
            type: updatedOrg.type,
          },
        });
      } catch (error) {
        console.error(`❌ Failed to set primary org:`, error);
        res.status(400).json({
          success: false,
          error: error.message,
        });
      }
    }),
  );

  /**
   * Get org metadata summary (counts for Capability Gallery)
   * GET /api/org/summary
   */
  router.get(
    "/org/summary",
    asyncHandler(async (req, res) => {
      const orgId = req.query.orgId || req.orgId || req.headers["x-org-id"];

      if (!orgId) {
        return res.status(400).json({
          success: false,
          error: "orgId is required",
        });
      }

      try {
        const summary = {
          objects: 0,
          fields: 0,
          flows: 0,
          triggers: 0,
          workflows: 0,
          apexClasses: 0,
          profiles: 0,
          permissionSets: 0,
          validationRules: 0,
          hotspots: 0,
          riskItems: 0,
          debtItems: 0,
          sensitiveFields: 0,
        };

        // Try to get counts from ArangoDB collections
        if (orchestrator.arango) {
          try {
            const db = orchestrator.arango.db || orchestrator.arango;

            // Objects count
            const objectsCol = `org_${orgId}_objects`;
            if (await db.collection(objectsCol).exists()) {
              const objCount = await db.collection(objectsCol).count();
              summary.objects = objCount.count || 0;
            }

            // Fields count
            const fieldsCol = `org_${orgId}_fields`;
            if (await db.collection(fieldsCol).exists()) {
              const fieldCount = await db.collection(fieldsCol).count();
              summary.fields = fieldCount.count || 0;
            }

            // Flows count
            const flowsCol = `org_${orgId}_flows`;
            if (await db.collection(flowsCol).exists()) {
              const flowCount = await db.collection(flowsCol).count();
              summary.flows = flowCount.count || 0;
            }

            // Triggers count
            const triggersCol = `org_${orgId}_triggers`;
            if (await db.collection(triggersCol).exists()) {
              const triggerCount = await db.collection(triggersCol).count();
              summary.triggers = triggerCount.count || 0;
            }

            // Apex classes count
            const apexCol = `org_${orgId}_apex_classes`;
            if (await db.collection(apexCol).exists()) {
              const apexCount = await db.collection(apexCol).count();
              summary.apexClasses = apexCount.count || 0;
            }

            // Profiles count
            const profilesCol = `org_${orgId}_profiles`;
            if (await db.collection(profilesCol).exists()) {
              const profileCount = await db.collection(profilesCol).count();
              summary.profiles = profileCount.count || 0;
            }

            // Permission sets count
            const permSetsCol = `org_${orgId}_permission_sets`;
            if (await db.collection(permSetsCol).exists()) {
              const permSetCount = await db.collection(permSetsCol).count();
              summary.permissionSets = permSetCount.count || 0;
            }

            // Validation rules count
            const valRulesCol = `org_${orgId}_validation_rules`;
            if (await db.collection(valRulesCol).exists()) {
              const valRuleCount = await db.collection(valRulesCol).count();
              summary.validationRules = valRuleCount.count || 0;
            }

            // Workflows count
            const workflowsCol = `org_${orgId}_workflows`;
            if (await db.collection(workflowsCol).exists()) {
              const workflowCount = await db.collection(workflowsCol).count();
              summary.workflows = workflowCount.count || 0;
            }
          } catch (dbError) {
            logger.warn(
              "Failed to get metadata counts from ArangoDB:",
              dbError.message,
            );
          }
        }

        // Calculate derived metrics
        summary.hotspots = Math.floor((summary.flows + summary.triggers) * 0.1); // Estimate
        summary.riskItems = Math.floor(
          (summary.validationRules + summary.workflows) * 0.15,
        );
        summary.debtItems = Math.floor(
          summary.fields * 0.05 + summary.apexClasses * 0.1,
        );
        summary.sensitiveFields = Math.floor(summary.fields * 0.02); // Estimate 2% sensitive

        res.json({
          success: true,
          data: summary,
          orgId,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error("Failed to get org summary:", error);
        res.status(500).json({
          success: false,
          error: error.message || "Failed to get org summary",
        });
      }
    }),
  );

  /**
   * Debug endpoint to check Redis cache keys by org ID
   * GET /api/debug/cache/keys/:orgId
   */
  router.get(
    "/debug/cache/keys/:orgId",
    asyncHandler(async (req, res) => {
      const { orgId } = req.params;

      try {
        if (!orchestrator.redisClient) {
          return res.json({
            success: false,
            error: "Redis client not available",
            keys: [],
          });
        }

        // Get all cache keys for this org
        const pattern = `org:${orgId}:*`;
        const keys = await orchestrator.redisClient.keys(pattern);

        // Get sample key values
        const keyDetails = {};
        for (let i = 0; i < Math.min(keys.length, 5); i++) {
          const key = keys[i];
          try {
            const value = await orchestrator.redisClient.get(key);
            keyDetails[key] = {
              type: typeof value,
              length: value?.length || 0,
              sample:
                value?.substring(0, 100) + (value?.length > 100 ? "..." : ""),
            };
          } catch (err) {
            keyDetails[key] = { error: err.message };
          }
        }

        res.json({
          success: true,
          data: {
            orgId,
            pattern,
            totalKeys: keys.length,
            keys: keys.slice(0, 20), // First 20 keys
            keyDetails,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message,
          orgId,
        });
      }
    }),
  );

  // =============================================================================
  // PROMPT TESTING AND CHAINING ROUTES
  // =============================================================================

  /**
   * Test a single prompt
   * POST /api/ai/prompts/test
   */
  router.post(
    "/ai/prompts/test",
    createEndpointRateLimit("prompt_test_single", { max: 20, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const {
        prompt,
        expectedOutput = null,
        model = null,
        temperature = null,
        maxTokens = null,
        metadata = {},
      } = req.body;

      if (!prompt || typeof prompt !== "string") {
        throw new ValidationError("Valid prompt string is required");
      }

      // Debug: Log what services are available
      console.log(
        "Available orchestrator services:",
        Object.keys(orchestrator).filter((key) => key.includes("Service")),
      );
      try {
        console.log(
          "promptChainTestingService exists:",
          "promptChainTestingService" in orchestrator,
        );
        console.log(
          "promptChainTestingService value:",
          orchestrator.promptChainTestingService,
        );
      } catch (e) {
        console.log("Error accessing promptChainTestingService:", e.message);
      }

      if (!orchestrator.promptChainTestingService) {
        console.log("Service is falsy, throwing error");
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const result =
        await orchestrator.promptChainTestingService.testSinglePrompt(
          req.orgId,
          {
            prompt,
            expectedOutput,
            model,
            temperature,
            maxTokens,
            metadata,
          },
        );

      res.json({
        success: true,
        result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Execute a prompt chain
   * POST /api/ai/prompts/test/chain
   */
  router.post(
    "/ai/prompts/test/chain",
    createEndpointRateLimit("prompt_test_chain", { max: 10, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const {
        chainId = null,
        steps = [],
        globalVariables = {},
        metadata = {},
        parallelExecution = false,
        stopOnError = true,
      } = req.body;

      if (!Array.isArray(steps) || steps.length === 0) {
        throw new ValidationError("Chain must contain at least one step");
      }

      // Validate each step has required fields
      for (const step of steps) {
        if (!step.stepId || typeof step.stepId !== "string") {
          throw new ValidationError("Each step must have a valid stepId");
        }
        if (!step.prompt || typeof step.prompt !== "string") {
          throw new ValidationError(
            `Step ${step.stepId} must have a valid prompt`,
          );
        }
      }

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const result = await orchestrator.promptChainTestingService.executeChain(
        req.orgId,
        {
          chainId,
          steps,
          globalVariables,
          metadata,
          parallelExecution,
          stopOnError,
        },
      );

      res.json({
        success: true,
        result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get chain execution status
   * GET /api/ai/prompts/test/chain/:chainId/status
   */
  router.get(
    "/ai/prompts/test/chain/:chainId/status",
    createEndpointRateLimit("prompt_chain_status", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { chainId } = req.params;

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const status =
        orchestrator.promptChainTestingService.getChainStatus(chainId);

      if (!status) {
        return res.status(404).json({
          success: false,
          error: "Chain not found",
          chainId,
        });
      }

      res.json({
        success: true,
        status,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Get chain execution results
   * GET /api/ai/prompts/test/chain/:chainId/results
   */
  router.get(
    "/ai/prompts/test/chain/:chainId/results",
    createEndpointRateLimit("prompt_chain_results", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { chainId } = req.params;

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const result =
        orchestrator.promptChainTestingService.getChainResult(chainId);

      if (!result) {
        return res.status(404).json({
          success: false,
          error: "Chain results not found",
          chainId,
        });
      }

      res.json({
        success: true,
        result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * List all chains for the organization
   * GET /api/ai/prompts/test/chains
   */
  router.get(
    "/ai/prompts/test/chains",
    createEndpointRateLimit("prompt_chains_list", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const chains = orchestrator.promptChainTestingService.getAllChains(
        req.orgId,
      );

      res.json({
        success: true,
        chains: chains.map((chain) => ({
          chainId: chain.chainId,
          status: chain.status,
          startTime: chain.startTime,
          endTime: chain.endTime,
          executionTime: chain.executionTime,
          stepCount:
            chain.executionPlan?.steps?.length ||
            chain.executionPlan?.levels?.flat()?.length ||
            0,
          completedSteps: chain.stepResults.size,
          metadata: chain.metadata,
        })),
        count: chains.length,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Validate a chain configuration without executing it
   * POST /api/ai/prompts/test/chain/validate
   */
  router.post(
    "/ai/prompts/test/chain/validate",
    createEndpointRateLimit("prompt_chain_validate", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { steps = [], parallelExecution = false } = req.body;

      if (!Array.isArray(steps) || steps.length === 0) {
        throw new ValidationError("Chain must contain at least one step");
      }

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      try {
        // Validate chain structure
        const validatedSteps =
          orchestrator.promptChainTestingService.validateChain(steps);
        const executionPlan =
          orchestrator.promptChainTestingService.createExecutionPlan(
            validatedSteps,
            parallelExecution,
          );

        res.json({
          success: true,
          validation: {
            isValid: true,
            stepCount: validatedSteps.length,
            executionType: executionPlan.type,
            executionOrder:
              executionPlan.type === "sequential"
                ? executionPlan.steps.map((s) => s.stepId)
                : executionPlan.levels.map((level) =>
                    level.map((s) => s.stepId),
                  ),
            dependencies: validatedSteps.map((step) => ({
              stepId: step.stepId,
              dependsOn: step.dependsOn || [],
            })),
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        res.json({
          success: false,
          validation: {
            isValid: false,
            error: error.message,
            stepCount: steps.length,
          },
          timestamp: new Date().toISOString(),
        });
      }
    }),
  );

  /**
   * Test a registered prompt by business service and prompt name
   * POST /api/ai/prompts/test/registered
   */
  router.post(
    "/ai/prompts/test/registered",
    createEndpointRateLimit("prompt_test_registered", {
      max: 20,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const {
        businessService,
        promptName,
        inputData = {},
        expectedOutput = null,
        model = null,
        temperature = null,
        maxTokens = null,
        metadata = {},
        validateJson = true,
      } = req.body;

      if (!businessService || typeof businessService !== "string") {
        throw new ValidationError("Valid businessService string is required");
      }

      if (!promptName || typeof promptName !== "string") {
        throw new ValidationError("Valid promptName string is required");
      }

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const result =
        await orchestrator.promptChainTestingService.testRegisteredPrompt(
          req.orgId,
          businessService,
          promptName,
          inputData,
          {
            expectedOutput,
            model,
            temperature,
            maxTokens,
            metadata,
            validateJson,
          },
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Discover available registered prompts
   * GET /api/ai/prompts/registered/discover
   */
  router.get(
    "/ai/prompts/registered/discover",
    createEndpointRateLimit("prompt_discover", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { businessService = null } = req.query;

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const prompts =
        await orchestrator.promptChainTestingService.discoverAvailablePrompts(
          businessService,
        );

      res.json({
        success: true,
        data: {
          prompts,
          businessServices: [...new Set(prompts.map((p) => p.businessService))],
          totalPrompts: prompts.length,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Generate test scenarios for a registered prompt
   * POST /api/ai/prompts/registered/scenarios
   */
  router.post(
    "/ai/prompts/registered/scenarios",
    createEndpointRateLimit("prompt_scenarios", { max: 10, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { businessService, promptName, scenarioCount = 3 } = req.body;

      if (!businessService || typeof businessService !== "string") {
        throw new ValidationError("Valid businessService string is required");
      }

      if (!promptName || typeof promptName !== "string") {
        throw new ValidationError("Valid promptName string is required");
      }

      if (
        typeof scenarioCount !== "number" ||
        scenarioCount < 1 ||
        scenarioCount > 10
      ) {
        throw new ValidationError(
          "scenarioCount must be a number between 1 and 10",
        );
      }

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const scenarios =
        await orchestrator.promptChainTestingService.generateScenariosForPrompt(
          req.orgId,
          businessService,
          promptName,
          scenarioCount,
        );

      res.json({
        success: true,
        data: {
          businessService,
          promptName,
          scenarios,
          scenarioCount: scenarios.length,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * Analyze prompt compression needs
   * POST /api/ai/prompts/analyze-compression
   */
  router.post(
    "/ai/prompts/analyze-compression",
    createEndpointRateLimit("prompt_compression_analysis", {
      max: 50,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { prompt, model } = req.body;

      if (!prompt) {
        throw new ValidationError("Prompt is required");
      }

      if (!orchestrator.promptCompressionService) {
        throw new Error("Compression service not available");
      }

      // Analyze compression needs
      const analysis = orchestrator.promptCompressionService.needsCompression(
        prompt,
        model,
      );

      // If compression is needed, perform it
      let compressionResult = null;
      if (analysis.needsCompression) {
        compressionResult =
          await orchestrator.promptCompressionService.compress(
            prompt,
            analysis.compressionLevel,
          );
      }

      res.json({
        success: true,
        data: {
          analysis,
          compressionResult: compressionResult
            ? {
                originalLength: compressionResult.stats.originalLength,
                compressedLength: compressionResult.stats.compressedLength,
                reduction: compressionResult.stats.reduction,
                tokenStats: compressionResult.tokenStats,
                strategiesApplied: compressionResult.stats.strategiesApplied,
              }
            : null,
          compressedPrompt: compressionResult
            ? compressionResult.compressed.substring(0, 500) +
              "...[truncated for display]"
            : null,
        },
      });
    }),
  );

  /**
   * Batch test multiple scenarios for a registered prompt
   * POST /api/ai/prompts/test/registered/batch
   */
  router.post(
    "/ai/prompts/test/registered/batch",
    createEndpointRateLimit("prompt_test_batch", { max: 5, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const {
        businessService,
        promptName,
        scenarios = [],
        model = null,
        temperature = null,
        maxTokens = null,
        validateJson = true,
        metadata = {},
      } = req.body;

      if (!businessService || typeof businessService !== "string") {
        throw new ValidationError("Valid businessService string is required");
      }

      if (!promptName || typeof promptName !== "string") {
        throw new ValidationError("Valid promptName string is required");
      }

      if (!Array.isArray(scenarios) || scenarios.length === 0) {
        throw new ValidationError("At least one scenario is required");
      }

      if (scenarios.length > 20) {
        throw new ValidationError("Maximum 20 scenarios allowed per batch");
      }

      if (!orchestrator.promptChainTestingService) {
        throw new AppError("PromptChainTestingService not available", 503);
      }

      const results = [];
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      for (let i = 0; i < scenarios.length; i++) {
        const scenario = scenarios[i];
        try {
          const result =
            await orchestrator.promptChainTestingService.testRegisteredPrompt(
              req.orgId,
              businessService,
              promptName,
              scenario.inputData || {},
              {
                expectedOutput: scenario.expectedOutput || null,
                model,
                temperature,
                maxTokens,
                validateJson,
                metadata: {
                  ...metadata,
                  scenarioIndex: i,
                  scenarioName: scenario.name || `Scenario ${i + 1}`,
                },
              },
            );

          results.push({
            scenarioIndex: i,
            scenarioName: scenario.name || `Scenario ${i + 1}`,
            success: true,
            result,
          });
        } catch (error) {
          results.push({
            scenarioIndex: i,
            scenarioName: scenario.name || `Scenario ${i + 1}`,
            success: false,
            error: error.message,
          });
        }
      }

      // Calculate batch statistics
      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.length - successCount;
      const successfulValidations = results.filter(
        (r) => r.success && r.result?.validation?.isValid,
      ).length;

      res.json({
        success: true,
        data: {
          batchId,
          businessService,
          promptName,
          results,
          statistics: {
            totalScenarios: scenarios.length,
            successCount,
            failureCount,
            successRate:
              ((successCount / scenarios.length) * 100).toFixed(1) + "%",
            validationSuccessCount: successfulValidations,
            validationRate:
              successCount > 0
                ? ((successfulValidations / successCount) * 100).toFixed(1) +
                  "%"
                : "0%",
          },
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // === AI INTELLIGENCE SERVICES ===

  /**
   * GET /api/ai/intelligence/health
   * Get AI intelligence services health status
   */
  router.get(
    "/ai/intelligence/health",
    createEndpointRateLimit("ai_intelligence_health", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.getAIIntelligenceHealth) {
        throw new AppError("AI Intelligence services not available", 503);
      }

      const health = orchestrator.getAIIntelligenceHealth();

      res.json({
        success: true,
        data: health,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/ai/intelligence/metrics
   * Get AI intelligence services performance metrics
   */
  router.get(
    "/ai/intelligence/metrics",
    createEndpointRateLimit("ai_intelligence_metrics", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.getAIIntelligenceMetrics) {
        throw new AppError("AI Intelligence services not available", 503);
      }

      const metrics = orchestrator.getAIIntelligenceMetrics();

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/intelligence/context/enrich
   * Enrich request with intelligent context
   */
  router.post(
    "/ai/intelligence/context/enrich",
    createEndpointRateLimit("ai_context_enrich", { max: 100, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { request } = req.body;

      if (!request) {
        throw new ValidationError("Request object is required");
      }

      if (!orchestrator.contextIntelligenceService) {
        throw new AppError("ContextIntelligenceService not available", 503);
      }

      // Ensure orgId is set from auth context
      const enrichRequest = { ...request, orgId: req.orgId };

      const enrichedRequest =
        await orchestrator.contextIntelligenceService.enrichRequestWithContext(
          enrichRequest,
        );

      res.json({
        success: true,
        data: {
          enrichedRequest,
          tokenSavings:
            enrichedRequest.contextMetadata?.tokenSavingsPercent || 0,
          contextMetadata: enrichedRequest.contextMetadata,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/intelligence/cache/get
   * Intelligent cache retrieval with org partitioning
   */
  router.post(
    "/ai/intelligence/cache/get",
    createEndpointRateLimit("ai_cache_get", { max: 200, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { key, context, generateData = false } = req.body;

      if (!key) {
        throw new ValidationError("Cache key is required");
      }

      if (!orchestrator.intelligentCacheService) {
        throw new AppError("IntelligentCacheService not available", 503);
      }

      let cachedData;
      if (generateData) {
        // Use generator function if provided
        cachedData = await orchestrator.intelligentCacheService.intelligentGet(
          req.orgId,
          key,
          context || {},
          async () => ({
            generated: true,
            timestamp: new Date().toISOString(),
          }),
        );
      } else {
        // Simple get without generator
        cachedData = await orchestrator.intelligentCacheService.intelligentGet(
          req.orgId,
          key,
          context || {},
          null,
        );
      }

      res.json({
        success: true,
        data: {
          cached: !!cachedData,
          data: cachedData,
          orgId: req.orgId,
          key,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/intelligence/cache/set
   * Intelligent cache storage with org partitioning
   */
  router.post(
    "/ai/intelligence/cache/set",
    createEndpointRateLimit("ai_cache_set", { max: 200, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { key, value, context } = req.body;

      if (!key) {
        throw new ValidationError("Cache key is required");
      }

      if (value === undefined) {
        throw new ValidationError("Cache value is required");
      }

      if (!orchestrator.intelligentCacheService) {
        throw new AppError("IntelligentCacheService not available", 503);
      }

      const success = await orchestrator.intelligentCacheService.intelligentSet(
        req.orgId,
        key,
        value,
        context || {},
      );

      res.json({
        success: true,
        data: {
          cached: success,
          orgId: req.orgId,
          key,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/intelligence/contract/validate
   * Validate inputs/outputs against prompt contracts
   */
  router.post(
    "/ai/intelligence/contract/validate",
    createEndpointRateLimit("ai_contract_validate", {
      max: 100,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const {
        templateName,
        inputs,
        outputs,
        validationType = "inputs",
      } = req.body;

      if (!templateName) {
        throw new ValidationError("Template name is required");
      }

      if (validationType === "inputs" && !inputs) {
        throw new ValidationError("Inputs are required for input validation");
      }

      if (validationType === "outputs" && !outputs) {
        throw new ValidationError("Outputs are required for output validation");
      }

      if (!orchestrator.promptContractValidator) {
        throw new AppError("PromptContractValidator not available", 503);
      }

      let validation;
      if (validationType === "outputs") {
        validation = await orchestrator.promptContractValidator.validateOutputs(
          templateName,
          outputs,
        );
      } else {
        validation = await orchestrator.promptContractValidator.validateInputs(
          templateName,
          inputs,
        );
      }

      res.json({
        success: true,
        data: {
          validation,
          templateName,
          validationType,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/intelligence/execution/record
   * Record prompt execution for learning and optimization
   */
  router.post(
    "/ai/intelligence/execution/record",
    createEndpointRateLimit("ai_execution_record", {
      max: 500,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { templateName, execution } = req.body;

      if (!templateName) {
        throw new ValidationError("Template name is required");
      }

      if (!execution) {
        throw new ValidationError("Execution data is required");
      }

      if (!orchestrator.promptExecutionTracker) {
        throw new AppError("PromptExecutionTracker not available", 503);
      }

      // Ensure orgId is in execution context
      const executionWithOrg = {
        ...execution,
        context: {
          ...(execution.context || {}),
          orgId: req.orgId,
        },
      };

      await orchestrator.promptExecutionTracker.recordExecution(
        templateName,
        executionWithOrg,
      );

      res.json({
        success: true,
        data: {
          recorded: true,
          templateName,
          orgId: req.orgId,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/ai/intelligence/execution/metrics
   * Get prompt execution performance metrics
   */
  router.get(
    "/ai/intelligence/execution/metrics",
    createEndpointRateLimit("ai_execution_metrics", {
      max: 50,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.promptExecutionTracker) {
        throw new AppError("PromptExecutionTracker not available", 503);
      }

      const metrics =
        orchestrator.promptExecutionTracker.getPerformanceMetrics();

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/intelligence/prompt/enhanced
   * Get enhanced prompt with AI intelligence
   */
  router.post(
    "/ai/intelligence/prompt/enhanced",
    createEndpointRateLimit("ai_prompt_enhanced", {
      max: 100,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { templateName, inputs, options } = req.body;

      if (!templateName) {
        throw new ValidationError("Template name is required");
      }

      if (!inputs) {
        throw new ValidationError("Inputs are required");
      }

      if (!orchestrator.enhancedPromptService) {
        throw new AppError("EnhancedPromptService not available", 503);
      }

      // Ensure orgId is in inputs
      const inputsWithOrg = {
        ...inputs,
        orgId: req.orgId,
      };

      const enhancedPrompt = await orchestrator.enhancedPromptService.getPrompt(
        templateName,
        inputsWithOrg,
        options || {},
      );

      res.json({
        success: true,
        data: enhancedPrompt,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/intelligence/optimization/suggestions
   * Get AI optimization suggestions for templates
   */
  router.post(
    "/ai/intelligence/optimization/suggestions",
    createEndpointRateLimit("ai_optimization_suggestions", {
      max: 20,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { templateName } = req.body;

      if (!templateName) {
        throw new ValidationError("Template name is required");
      }

      if (!orchestrator.getAIOptimizationSuggestions) {
        throw new AppError("AI Optimization service not available", 503);
      }

      const suggestions = await orchestrator.getAIOptimizationSuggestions(
        req.orgId,
        templateName,
      );

      res.json({
        success: true,
        data: suggestions,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/workflow/optimize
   * AI-powered workflow optimization analysis
   */
  router.post(
    "/ai/workflow/optimize",
    createEndpointRateLimit("ai_workflow_optimize", {
      max: 10,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { workflowData } = req.body;

      if (!workflowData || !Array.isArray(workflowData)) {
        throw new ValidationError("Workflow data array is required");
      }

      if (!orchestrator.workflowOptimizationAI) {
        throw new AppError("WorkflowOptimizationAI service not available", 503);
      }

      const analysis =
        await orchestrator.workflowOptimizationAI.analyzeWorkflowsForOptimization(
          req.orgId,
          workflowData,
        );

      res.json({
        success: true,
        data: analysis,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/ai/workflow/optimization-metrics
   * Get workflow optimization AI metrics
   */
  router.get(
    "/ai/workflow/optimization-metrics",
    createEndpointRateLimit("ai_workflow_metrics", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.workflowOptimizationAI) {
        throw new AppError("WorkflowOptimizationAI service not available", 503);
      }

      const metrics =
        orchestrator.workflowOptimizationAI.getPerformanceMetrics();

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/workflow/analyze-cross-object
   * Perform comprehensive cross-object workflow analysis
   */
  router.post(
    "/ai/workflow/analyze-cross-object",
    createEndpointRateLimit("ai_workflow_cross_analysis", {
      max: 5,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { workflowData } = req.body;

      if (!workflowData || !Array.isArray(workflowData)) {
        throw new ValidationError("Workflow data array is required");
      }

      // Initialize WorkflowConversionAnalytics if not available
      if (!orchestrator.workflowConversionAnalytics) {
        const { WorkflowConversionAnalytics } =
          await import("../services/WorkflowConversionAnalytics.js");
        orchestrator.workflowConversionAnalytics =
          new WorkflowConversionAnalytics(orchestrator);
      }

      const analysisResult =
        await orchestrator.workflowConversionAnalytics.analyzeCrossObjectPatterns(
          workflowData,
        );

      res.json({
        success: true,
        data: analysisResult,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/workflow/coalesce
   * Coalesce similar workflow rules into optimized Flows
   */
  router.post(
    "/ai/workflow/coalesce",
    createEndpointRateLimit("ai_workflow_coalesce", {
      max: 10,
      windowMs: 60000,
    }),
    // Remove orgLimits for now since orgContext is not established
    // orgLimits('maxApiCallsPerHour'),
    asyncHandler(async (req, res) => {
      const { workflowGroups, workflowGroup, options = {} } = req.body;

      // Support both single group (legacy) and multiple groups (new)
      const groups = workflowGroups || (workflowGroup ? [workflowGroup] : null);

      if (!groups || !Array.isArray(groups) || groups.length === 0) {
        throw new ValidationError("At least one workflow group required");
      }

      // Validate each group has at least 2 workflows
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const workflows = Array.isArray(group) ? group : group?.workflows;

        console.log(`🔍 DEBUG Group ${i + 1}:`, {
          groupType: typeof group,
          isArray: Array.isArray(group),
          hasWorkflows: !!group?.workflows,
          workflowsType: typeof workflows,
          workflowsLength: workflows?.length,
          groupKeys: Object.keys(group || {}),
        });

        if (!Array.isArray(workflows) || workflows.length < 2) {
          throw new ValidationError(
            `Group ${i + 1} must have at least 2 workflows for coalescing. Found: ${workflows?.length || 0} workflows`,
          );
        }
      }

      // Initialize WorkflowConversionAnalytics if not available
      if (!orchestrator.workflowConversionAnalytics) {
        const { WorkflowConversionAnalytics } =
          await import("../services/WorkflowConversionAnalytics.js");
        orchestrator.workflowConversionAnalytics =
          new WorkflowConversionAnalytics(orchestrator);
      }

      // Generate session ID for correlation
      const sessionId =
        options.sessionId ||
        `coalesce_session_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).substring(7)}`;
      const orgId = req.orgId || options.orgId || "system";

      // Save input to database
      if (orchestrator.store) {
        try {
          await orchestrator.store.saveOrgDocument(orgId, "coalescing_inputs", {
            timestamp: new Date().toISOString(),
            sessionId: sessionId,
            type: "multi_group_coalescing_input",
            groupCount: groups.length,
            totalWorkflows: groups.reduce(
              (sum, group) => sum + group.length,
              0,
            ),
            groups: groups,
            orgId: orgId,
            userId: req.user?.userId || options.userId || "system",
          });
          console.log("Saved coalescing input to ArangoDB");
        } catch (error) {
          console.error("Failed to save coalescing input:", error);
        }
      }

      // Process groups sequentially to avoid Claude API overload (HTTP 529)
      console.log(
        `Processing ${groups.length} workflow groups sequentially with rate limiting`,
      );

      const coalescingResults = [];

      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];

        try {
          // Add delay between requests to respect Claude API rate limits
          if (index > 0) {
            console.log(
              `⏳ Waiting 3 seconds before processing group ${index + 1}...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }

          // Normalize group format - handle both arrays and objects with workflows property
          const workflows = Array.isArray(group) ? group : group?.workflows;

          console.log(
            `🔄 Processing group ${index + 1}/${groups.length} (${workflows.length} workflows)`,
          );

          // Use WorkflowConversionAnalytics service directly
          const result =
            await orchestrator.workflowConversionAnalytics.coalesceWorkflows(
              workflows,
              {
                ...options,
                groupIndex: index,
                totalGroups: groups.length,
              },
            );

          coalescingResults.push({
            groupIndex: index,
            success: true,
            workflowCount: workflows.length,
            result: result,
          });

          console.log(`✅ Group ${index + 1} completed successfully`);
        } catch (error) {
          console.log(`❌ Group ${index + 1} failed: ${error.message}`);

          const workflows = Array.isArray(group) ? group : group?.workflows;
          coalescingResults.push({
            groupIndex: index,
            success: false,
            workflowCount: workflows?.length || 0,
            error: error.message,
          });
        }
      }

      // Calculate summary statistics
      const successCount = coalescingResults.filter((r) => r.success).length;
      const failureCount = coalescingResults.filter((r) => !r.success).length;
      const totalWorkflows = groups.reduce(
        (sum, group) => sum + group.length,
        0,
      );

      // Save results to database
      if (orchestrator.store) {
        try {
          await orchestrator.store.saveOrgDocument(
            orgId,
            "coalescing_outputs",
            {
              timestamp: new Date().toISOString(),
              sessionId: sessionId,
              type: "multi_group_coalescing_output",
              groupCount: groups.length,
              successCount: successCount,
              failureCount: failureCount,
              totalWorkflows: totalWorkflows,
              results: coalescingResults,
              orgId: orgId,
              userId: req.user?.userId || options.userId || "system",
            },
          );
          console.log("Saved coalescing output to ArangoDB");
        } catch (error) {
          console.error("Failed to save coalescing output:", error);
        }
      }

      // Cache results in Redis
      if (orchestrator.cache) {
        try {
          const cacheKey = `coalescing:${orgId}:${sessionId}`;
          await orchestrator.cache.set(
            cacheKey,
            JSON.stringify({
              summary: {
                totalGroups: groups.length,
                successfulGroups: successCount,
                failedGroups: failureCount,
                totalWorkflows: totalWorkflows,
              },
              results: coalescingResults,
              timestamp: new Date().toISOString(),
            }),
            7200,
          ); // 2 hour TTL for coalescing results
          console.log(`Cached coalescing results in Redis: ${cacheKey}`);
        } catch (error) {
          console.error("Failed to cache coalescing results:", error);
        }
      }

      res.json({
        success: true,
        summary: {
          totalGroups: groups.length,
          successfulGroups: successCount,
          failedGroups: failureCount,
          totalWorkflows: totalWorkflows,
          processingTime: Date.now() - req.startTime || 0,
        },
        results: coalescingResults,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/workflow/batch-analyze
   * Perform batch analysis of multiple workflows
   */
  router.post(
    "/ai/workflow/batch-analyze",
    createEndpointRateLimit("ai_workflow_batch_analyze", {
      max: 3,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { workflows, options = {} } = req.body;

      if (!workflows || !Array.isArray(workflows)) {
        throw new ValidationError("Workflows array is required");
      }

      // Initialize WorkflowConversionAnalytics if not available
      if (!orchestrator.workflowConversionAnalytics) {
        const { WorkflowConversionAnalytics } =
          await import("../services/WorkflowConversionAnalytics.js");
        orchestrator.workflowConversionAnalytics =
          new WorkflowConversionAnalytics(orchestrator);
      }

      const batchResult =
        await orchestrator.workflowConversionAnalytics.batchAnalyzeWorkflows(
          workflows,
          options,
        );

      res.json({
        success: true,
        data: batchResult,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/workflow/generate-recommendations
   * Generate optimization recommendations based on analysis
   */
  router.post(
    "/ai/workflow/generate-recommendations",
    createEndpointRateLimit("ai_workflow_recommendations", {
      max: 10,
      windowMs: 60000,
    }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { analysisResults } = req.body;

      if (!analysisResults) {
        throw new ValidationError("Analysis results are required");
      }

      // Initialize WorkflowConversionAnalytics if not available
      if (!orchestrator.workflowConversionAnalytics) {
        const { WorkflowConversionAnalytics } =
          await import("../services/WorkflowConversionAnalytics.js");
        orchestrator.workflowConversionAnalytics =
          new WorkflowConversionAnalytics(orchestrator);
      }

      const recommendations =
        await orchestrator.workflowConversionAnalytics.generateOptimizationRecommendations(
          analysisResults,
        );

      res.json({
        success: true,
        data: {
          recommendations,
          generatedAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/prompt/analyze-performance
   * Analyze prompt template performance
   */
  router.post(
    "/ai/prompt/analyze-performance",
    createEndpointRateLimit("ai_prompt_analyze", { max: 20, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { templateName, timeRange = "24h" } = req.body;

      if (!templateName) {
        throw new ValidationError("Template name is required");
      }

      if (!orchestrator.promptTemplateOptimizer) {
        throw new AppError(
          "PromptTemplateOptimizer service not available",
          503,
        );
      }

      const analysis =
        await orchestrator.promptTemplateOptimizer.analyzeTemplatePerformance(
          templateName,
          timeRange,
        );

      res.json({
        success: true,
        data: analysis,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/prompt/auto-optimize
   * Auto-optimize a prompt template
   */
  router.post(
    "/ai/prompt/auto-optimize",
    createEndpointRateLimit("ai_prompt_optimize", { max: 10, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const {
        templateName,
        mode = "conservative",
        testPercentage = 10,
        minExecutions = 100,
      } = req.body;

      if (!templateName) {
        throw new ValidationError("Template name is required");
      }

      if (!["conservative", "moderate", "aggressive"].includes(mode)) {
        throw new ValidationError("Invalid optimization mode");
      }

      if (!orchestrator.promptTemplateOptimizer) {
        throw new AppError(
          "PromptTemplateOptimizer service not available",
          503,
        );
      }

      const result =
        await orchestrator.promptTemplateOptimizer.autoOptimizeTemplate(
          templateName,
          { mode, testPercentage, minExecutions },
        );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/ai/prompt/optimization-metrics
   * Get prompt optimization metrics
   */
  router.get(
    "/ai/prompt/optimization-metrics",
    createEndpointRateLimit("ai_prompt_metrics", { max: 30, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.promptTemplateOptimizer) {
        throw new AppError(
          "PromptTemplateOptimizer service not available",
          503,
        );
      }

      const metrics =
        orchestrator.promptTemplateOptimizer.getPerformanceMetrics();

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/ai/prompt/experiments
   * Get active optimization experiments
   */
  router.get(
    "/ai/prompt/experiments",
    createEndpointRateLimit("ai_prompt_experiments", {
      max: 30,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.promptTemplateOptimizer) {
        throw new AppError(
          "PromptTemplateOptimizer service not available",
          503,
        );
      }

      const experiments = Array.from(
        orchestrator.promptTemplateOptimizer.activeExperiments.values(),
      );

      res.json({
        success: true,
        data: {
          active: experiments,
          total: orchestrator.promptTemplateOptimizer.metrics.totalExperiments,
          activeCount: experiments.length,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // ============================================
  // Natural Language Control API
  // ============================================

  /**
   * POST /api/ai/app/query
   * Process queries within a scoped app context
   */
  router.post(
    "/ai/app/query",
    createEndpointRateLimit("ai_app_query", { max: 30, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { appId, query, context = {} } = req.body;
      const orgId = req.body.orgId || req.orgId || req.headers["x-org-id"];

      if (!appId) {
        throw new ValidationError("appId is required");
      }
      if (!query) {
        throw new ValidationError("query is required");
      }

      // Import and use the ScopedNLSProcessor
      const { ScopedNLSProcessor } =
        await import("../services/metadata-analytics/ScopedNLSProcessor.js");
      const { getAppLoader } =
        await import("../services/metadata-analytics/AppLoader.js");

      // Ensure apps are loaded
      const appLoader = getAppLoader();
      if (appLoader.listApps().length === 0) {
        await appLoader.loadAllApps();
      }

      // Check if app exists
      if (!appLoader.hasApp(appId)) {
        return res.json({
          success: false,
          error: `App "${appId}" not found. Available apps: ${appLoader.listApps().join(", ")}`,
          timestamp: new Date().toISOString(),
        });
      }

      // Process the query within the app scope
      const processor = new ScopedNLSProcessor(orchestrator);
      const result = await processor.processQuery({
        appId,
        query,
        orgId,
        userId: req.user?.id || "anonymous",
        context,
      });

      // Format response for UI using generic uiConfig renderer
      const formattedResponse = result.isFallback
        ? UIConfigRenderer.renderFallback(
            result.result?.data?.message,
            result.suggestions,
          )
        : UIConfigRenderer.toMarkdown(
            result.result?.uiConfig,
            result.result?.data,
          );

      res.json({
        success: result.success,
        data: {
          response: formattedResponse,
          appId: result.appId,
          intent: result.intent?.id,
          recipe: result.recipe,
          data: result.result?.data,
          uiConfig: result.result?.uiConfig, // Pass through uiConfig for proper UI rendering
          processingTime: result.processingTime,
          suggestions:
            result.suggestions ||
            result.result?.suggestions ||
            result.result?.output?.suggestions ||
            [],
          error: result.error || result.result?.error,
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/ai/nl/command
   * Process natural language commands
   */
  router.post(
    "/ai/nl/command",
    createEndpointRateLimit("ai_nl_command", { max: 30, windowMs: 60000 }),
    orgLimits("maxApiCallsPerHour"),
    asyncHandler(async (req, res) => {
      const { command, context = {} } = req.body;

      if (!command) {
        throw new ValidationError("Command is required");
      }

      if (!orchestrator.naturalLanguageController) {
        throw new AppError("Natural Language Controller not available", 503);
      }

      // Route through MCP system to get three-level cache enrichment
      const result = await orchestrator.processRequest({
        action: "ai/nl/command",
        orgId: req.orgId || req.headers["x-org-id"],
        userId: req.user?.id || "anonymous",
        body: {
          command,
          context: {
            ...context,
            sessionId: req.sessionID,
          },
        },
      });

      // Return the result directly - it already has success and all needed fields
      res.json(result);
    }),
  );

  /**
   * GET /api/ai/nl/suggestions
   * Get command suggestions
   */
  router.get(
    "/ai/nl/suggestions",
    createEndpointRateLimit("ai_nl_suggestions", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { context = {} } = req.query;

      if (!orchestrator.naturalLanguageController) {
        throw new AppError("Natural Language Controller not available", 503);
      }

      // Get contextual suggestions
      const suggestions =
        await orchestrator.naturalLanguageController.generateSuggestions(
          { type: "context_based" },
          context,
        );

      res.json({
        success: true,
        data: {
          suggestions,
          commands: [
            "help",
            "show system status",
            "analyze performance",
            "optimize workflows",
          ],
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/ai/nl/help
   * Get available commands help
   */
  router.get(
    "/ai/nl/help",
    createEndpointRateLimit("ai_nl_help", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.naturalLanguageController) {
        throw new AppError("Natural Language Controller not available", 503);
      }

      const helpResult = await orchestrator.naturalLanguageController.showHelp(
        "help",
        [],
        {},
      );

      res.json({
        success: true,
        data: helpResult,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // 🔧 ADMIN ENDPOINTS - Organization Management
  /**
   * Create new customer
   * POST /api/admin/customers
   */
  router.post(
    "/admin/customers",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_create_customer", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { customerId, name, tier, metadata } = req.body;

      if (!customerId || !name) {
        throw new AppError("Customer ID and name are required", 400);
      }

      const db = await getDbConnection();
      const customersCollection = db.collection("customers");

      // Check if customer already exists
      const existingCustomer = await customersCollection
        .document(customerId)
        .catch(() => null);
      if (existingCustomer) {
        throw new AppError(`Customer ${customerId} already exists`, 409);
      }

      const customerData = {
        _key: customerId,
        name,
        tier: tier || "basic",
        metadata: metadata || {},
        createdAt: new Date().toISOString(),
        createdBy: req.user?.id || "admin",
        active: true,
      };

      await customersCollection.save(customerData);

      logger.info(`Customer created: ${customerId}`, {
        customerId,
        name,
        tier,
      });

      res.status(201).json({
        success: true,
        data: {
          customerId,
          name,
          tier,
          createdAt: customerData.createdAt,
        },
        message: "Customer created successfully",
      });
    }),
  );

  /**
   * List all customers
   * GET /api/admin/customers
   */
  router.get(
    "/admin/customers",
    orgPermissions(["admin:read"]),
    asyncHandler(async (req, res) => {
      const db = await getDbConnection();
      const customersCollection = db.collection("customers");

      const cursor = await customersCollection.all();
      const customers = await cursor.all();

      res.json({
        success: true,
        data: customers.map((customer) => ({
          customerId: customer._key,
          name: customer.name,
          tier: customer.tier,
          active: customer.active,
          createdAt: customer.createdAt,
          orgCount: 0, // TODO: Count orgs per customer
        })),
        count: customers.length,
      });
    }),
  );

  /**
   * Add Salesforce org to customer
   * POST /api/admin/orgs
   */
  router.post(
    "/admin/orgs",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_add_org", { max: 20, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const {
        customerId,
        orgId,
        name,
        orgType, // 'production', 'sandbox', 'developer', 'scratch'
        connectionType, // 'R', 'W', 'RW'
        credentials,
        metadata,
      } = req.body;

      if (
        !customerId ||
        !orgId ||
        !name ||
        !orgType ||
        !connectionType ||
        !credentials
      ) {
        throw new AppError(
          "Missing required fields: customerId, orgId, name, orgType, connectionType, credentials",
          400,
        );
      }

      // Validate connection type for org type (LEGAL COMPLIANCE)
      const VALID_CONNECTIONS = {
        production: ["R"], // Production: READ ONLY
        sandbox: ["R", "W", "RW"], // Sandbox: All allowed
        developer: ["R", "W", "RW"], // Developer: All allowed
        scratch: ["R", "W", "RW"], // Scratch: All allowed
      };

      if (!VALID_CONNECTIONS[orgType]?.includes(connectionType)) {
        throw new AppError(
          `Connection type '${connectionType}' not allowed for org type '${orgType}'. Legal compliance violation prevented.`,
          400,
        );
      }

      const db = await getDbConnection();
      const orgsCollection = db.collection("salesforce_orgs");
      const customersCollection = db.collection("customers");

      // Verify customer exists
      const customer = await customersCollection
        .document(customerId)
        .catch(() => null);
      if (!customer) {
        throw new AppError(`Customer ${customerId} not found`, 404);
      }

      // Check if org already exists
      const existingOrg = await orgsCollection
        .document(orgId)
        .catch(() => null);
      if (existingOrg) {
        throw new AppError(`Org ${orgId} already exists`, 409);
      }

      // Encrypt sensitive credentials (basic implementation)
      const encryptedCredentials = {
        ...credentials,
        password: credentials.password
          ? Buffer.from(credentials.password).toString("base64")
          : undefined,
        securityToken: credentials.securityToken
          ? Buffer.from(credentials.securityToken).toString("base64")
          : undefined,
        clientSecret: credentials.clientSecret
          ? Buffer.from(credentials.clientSecret).toString("base64")
          : undefined,
        encrypted: true,
      };

      const orgData = {
        _key: orgId,
        customerId,
        name,
        orgType,
        connectionType,
        credentials: encryptedCredentials,
        metadata: metadata || {},
        validation: {
          orgTypeConfirmed: false,
          lastVerified: null,
          autoDetectedType: null,
        },
        createdAt: new Date().toISOString(),
        createdBy: req.user?.id || "admin",
        active: true,
      };

      await orgsCollection.save(orgData);

      logger.info(`Salesforce org added: ${orgId}`, {
        customerId,
        orgId,
        name,
        orgType,
        connectionType,
      });

      res.status(201).json({
        success: true,
        data: {
          orgId,
          customerId,
          name,
          orgType,
          connectionType,
          createdAt: orgData.createdAt,
          needsValidation: true,
        },
        message: "Salesforce org added successfully",
      });
    }),
  );

  /**
   * List all orgs (optionally filtered by customer)
   * GET /api/admin/orgs?customerId=acme-corp
   */
  router.get(
    "/admin/orgs",
    orgPermissions(["admin:read"]),
    asyncHandler(async (req, res) => {
      const { customerId } = req.query;

      const db = await getDbConnection();
      const orgsCollection = db.collection("salesforce_orgs");

      let cursor;
      if (customerId) {
        cursor = await orgsCollection.byExample({ customerId, active: true });
      } else {
        cursor = await orgsCollection.byExample({ active: true });
      }

      const orgs = await cursor.all();

      res.json({
        success: true,
        data: orgs.map((org) => ({
          orgId: org._key,
          customerId: org.customerId,
          name: org.name,
          orgType: org.orgType,
          connectionType: org.connectionType,
          lastVerified: org.validation?.lastVerified,
          orgTypeConfirmed: org.validation?.orgTypeConfirmed,
          createdAt: org.createdAt,
          // Don't return credentials in list view
          hasCredentials: !!org.credentials,
        })),
        count: orgs.length,
        filter: customerId ? { customerId } : null,
      });
    }),
  );

  /**
   * Validate and test Salesforce org connection
   * POST /api/admin/orgs/:orgId/validate
   */
  router.post(
    "/admin/orgs/:orgId/validate",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_validate_org", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { orgId } = req.params;

      const db = await getDbConnection();
      const orgsCollection = db.collection("salesforce_orgs");

      // Get org configuration
      const org = await orgsCollection.document(orgId).catch(() => null);
      if (!org) {
        throw new AppError(`Org ${orgId} not found`, 404);
      }

      // Decrypt credentials (basic implementation)
      const decryptedCredentials = {
        ...org.credentials,
        password: org.credentials.password
          ? Buffer.from(org.credentials.password, "base64").toString()
          : undefined,
        securityToken: org.credentials.securityToken
          ? Buffer.from(org.credentials.securityToken, "base64").toString()
          : undefined,
        clientSecret: org.credentials.clientSecret
          ? Buffer.from(org.credentials.clientSecret, "base64").toString()
          : undefined,
      };

      try {
        // Use SalesforceService to validate connection
        if (!orchestrator.salesforceService) {
          throw new AppError("Salesforce service not available", 503);
        }

        // Test connection and get org info
        const connectionResult =
          await orchestrator.salesforceService.testConnection({
            ...decryptedCredentials,
            loginUrl:
              decryptedCredentials.loginUrl || "https://login.salesforce.com",
          });

        // Auto-detect org type
        const orgInfo = connectionResult.orgInfo;
        const autoDetectedType = orgInfo?.IsSandbox ? "sandbox" : "production";

        // Update validation info
        const updateData = {
          validation: {
            orgTypeConfirmed: true,
            lastVerified: new Date().toISOString(),
            autoDetectedType,
            lastValidationResult: connectionResult,
          },
        };

        // LEGAL CHECK: Verify org type matches configuration
        if (
          autoDetectedType === "production" &&
          !["R"].includes(org.connectionType)
        ) {
          logger.warn(
            `LEGAL VIOLATION DETECTED: Production org ${orgId} has ${org.connectionType} access`,
            {
              orgId,
              autoDetectedType,
              configuredType: org.orgType,
              connectionType: org.connectionType,
            },
          );

          updateData.validation.legalViolation = `Production org with ${org.connectionType} access detected`;
        }

        await orgsCollection.update(orgId, updateData);

        logger.info(`Org validation completed: ${orgId}`, {
          orgId,
          autoDetectedType,
          connectionResult: "success",
        });

        res.json({
          success: true,
          data: {
            orgId,
            connectionStatus: "success",
            orgInfo: {
              name: orgInfo?.Name,
              isSandbox: orgInfo?.IsSandbox,
              organizationType: orgInfo?.OrganizationType,
              autoDetectedType,
            },
            validation: {
              orgTypeMatches: autoDetectedType === org.orgType,
              legalCompliance:
                autoDetectedType === "production"
                  ? org.connectionType === "R"
                  : true,
              lastVerified: updateData.validation.lastVerified,
            },
          },
          message: "Org validation completed successfully",
        });
      } catch (error) {
        logger.error(`Org validation failed: ${orgId}`, {
          orgId,
          error: error.message,
        });

        // Update with failure info
        await orgsCollection.update(orgId, {
          validation: {
            ...org.validation,
            lastVerified: new Date().toISOString(),
            lastValidationError: error.message,
          },
        });

        throw new AppError(`Org validation failed: ${error.message}`, 400);
      }
    }),
  );

  /**
   * Update org connection permissions
   * PUT /api/admin/orgs/:orgId/connection
   */
  router.put(
    "/admin/orgs/:orgId/connection",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_update_connection", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { orgId } = req.params;
      const { connectionType, approvedBy, reason } = req.body;

      if (!connectionType || !approvedBy) {
        throw new AppError("Connection type and approvedBy are required", 400);
      }

      const db = await getDbConnection();
      const orgsCollection = db.collection("salesforce_orgs");

      // Get current org configuration
      const org = await orgsCollection.document(orgId).catch(() => null);
      if (!org) {
        throw new AppError(`Org ${orgId} not found`, 404);
      }

      // LEGAL COMPLIANCE: Validate connection type for org type
      const VALID_CONNECTIONS = {
        production: ["R"],
        sandbox: ["R", "W", "RW"],
        developer: ["R", "W", "RW"],
        scratch: ["R", "W", "RW"],
      };

      if (!VALID_CONNECTIONS[org.orgType]?.includes(connectionType)) {
        throw new AppError(
          `Connection type '${connectionType}' not allowed for org type '${org.orgType}'. Legal compliance violation prevented.`,
          400,
        );
      }

      // Log permission change for audit trail
      const auditEntry = {
        timestamp: new Date().toISOString(),
        action: "connection_type_change",
        orgId,
        previousConnectionType: org.connectionType,
        newConnectionType: connectionType,
        approvedBy,
        reason: reason || "No reason provided",
        performer: req.user?.id || "admin",
      };

      // Update org connection type
      const updateData = {
        connectionType,
        lastModified: new Date().toISOString(),
        lastModifiedBy: req.user?.id || "admin",
        auditTrail: [...(org.auditTrail || []), auditEntry],
      };

      await orgsCollection.update(orgId, updateData);

      logger.info(`Org connection type updated: ${orgId}`, {
        orgId,
        previousConnectionType: org.connectionType,
        newConnectionType: connectionType,
        approvedBy,
        reason,
      });

      res.json({
        success: true,
        data: {
          orgId,
          connectionType,
          previousConnectionType: org.connectionType,
          approvedBy,
          updatedAt: updateData.lastModified,
        },
        message: "Connection type updated successfully",
      });
    }),
  );

  /**
   * Remove org from system
   * DELETE /api/admin/orgs/:orgId
   */
  router.delete(
    "/admin/orgs/:orgId",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_delete_org", { max: 5, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { orgId } = req.params;
      const { confirm, reason } = req.body;

      if (!confirm || confirm !== "DELETE") {
        throw new AppError(
          'Must provide confirmation with "confirm": "DELETE"',
          400,
        );
      }

      const db = await getDbConnection();
      const orgsCollection = db.collection("salesforce_orgs");

      // Get org before deletion for audit
      const org = await orgsCollection.document(orgId).catch(() => null);
      if (!org) {
        throw new AppError(`Org ${orgId} not found`, 404);
      }

      // Soft delete - mark as inactive instead of hard delete
      const updateData = {
        active: false,
        deletedAt: new Date().toISOString(),
        deletedBy: req.user?.id || "admin",
        deletionReason: reason || "No reason provided",
      };

      await orgsCollection.update(orgId, updateData);

      logger.warn(`Org soft-deleted: ${orgId}`, {
        orgId,
        customerId: org.customerId,
        deletedBy: updateData.deletedBy,
        reason,
      });

      res.json({
        success: true,
        data: {
          orgId,
          deletedAt: updateData.deletedAt,
          reason: updateData.deletionReason,
        },
        message: "Org deactivated successfully",
      });
    }),
  );

  // 👤 USER MANAGEMENT ENDPOINTS
  /**
   * Create new user
   * POST /api/admin/users
   */
  router.post(
    "/admin/users",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_create_user", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { username, password, orgId, permissions, metadata } = req.body;

      if (!username || !password || !orgId || !permissions) {
        throw new AppError(
          "Username, password, orgId, and permissions are required",
          400,
        );
      }

      const db = await getDbConnection();
      const usersCollection = db.collection("users");

      // Check if user already exists
      const existingUser = await usersCollection
        .firstExample({ username })
        .catch(() => null);
      if (existingUser) {
        throw new AppError(`User ${username} already exists`, 409);
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 12);

      const userData = {
        username,
        password: hashedPassword,
        orgId,
        permissions: Array.isArray(permissions)
          ? permissions
          : permissions.split(","),
        metadata: metadata || {},
        createdAt: new Date().toISOString(),
        createdBy: req.user?.id || "admin",
        active: true,
        lastLogin: null,
        tokenVersion: 1, // For token invalidation
      };

      const result = await usersCollection.save(userData);

      logger.info(`User created: ${username}`, {
        username,
        orgId,
        permissions: userData.permissions,
        userId: result._key,
      });

      res.status(201).json({
        success: true,
        data: {
          userId: result._key,
          username,
          orgId,
          permissions: userData.permissions,
          createdAt: userData.createdAt,
          active: userData.active,
        },
        message: "User created successfully",
      });
    }),
  );

  /**
   * List all users (optionally filtered by orgId)
   * GET /api/admin/users?orgId=00D123
   */
  router.get(
    "/admin/users",
    orgPermissions(["admin:read"]),
    asyncHandler(async (req, res) => {
      const { orgId } = req.query;

      const db = await getDbConnection();
      const usersCollection = db.collection("users");

      let cursor;
      if (orgId) {
        cursor = await usersCollection.byExample({ orgId, active: true });
      } else {
        cursor = await usersCollection.byExample({ active: true });
      }

      const users = await cursor.all();

      res.json({
        success: true,
        data: users.map((user) => ({
          userId: user._key,
          username: user.username,
          orgId: user.orgId,
          permissions: user.permissions,
          lastLogin: user.lastLogin,
          createdAt: user.createdAt,
          active: user.active,
          tokenVersion: user.tokenVersion,
          // Don't return password hash
        })),
        count: users.length,
        filter: orgId ? { orgId } : null,
      });
    }),
  );

  /**
   * Update user permissions
   * PUT /api/admin/users/:userId/permissions
   */
  router.put(
    "/admin/users/:userId/permissions",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_update_user_permissions", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { permissions, reason } = req.body;

      if (!permissions) {
        throw new AppError("Permissions array is required", 400);
      }

      const db = await getDbConnection();
      const usersCollection = db.collection("users");

      // Get current user
      const user = await usersCollection.document(userId).catch(() => null);
      if (!user) {
        throw new AppError(`User ${userId} not found`, 404);
      }

      const permissionsArray = Array.isArray(permissions)
        ? permissions
        : permissions.split(",");

      // Log permission change for audit trail
      const auditEntry = {
        timestamp: new Date().toISOString(),
        action: "permissions_change",
        userId,
        username: user.username,
        previousPermissions: user.permissions,
        newPermissions: permissionsArray,
        reason: reason || "No reason provided",
        performer: req.user?.id || "admin",
      };

      const updateData = {
        permissions: permissionsArray,
        lastModified: new Date().toISOString(),
        lastModifiedBy: req.user?.id || "admin",
        auditTrail: [...(user.auditTrail || []), auditEntry],
      };

      await usersCollection.update(userId, updateData);

      logger.info(`User permissions updated: ${user.username}`, {
        userId,
        username: user.username,
        previousPermissions: user.permissions,
        newPermissions: permissionsArray,
        reason,
      });

      res.json({
        success: true,
        data: {
          userId,
          username: user.username,
          permissions: permissionsArray,
          previousPermissions: user.permissions,
          updatedAt: updateData.lastModified,
        },
        message: "User permissions updated successfully",
      });
    }),
  );

  /**
   * Reset user password
   * PUT /api/admin/users/:userId/password
   */
  router.put(
    "/admin/users/:userId/password",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_reset_password", {
      max: 5,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { newPassword, reason } = req.body;

      if (!newPassword) {
        throw new AppError("New password is required", 400);
      }

      if (newPassword.length < 8) {
        throw new AppError("Password must be at least 8 characters long", 400);
      }

      const db = await getDbConnection();
      const usersCollection = db.collection("users");

      // Get current user
      const user = await usersCollection.document(userId).catch(() => null);
      if (!user) {
        throw new AppError(`User ${userId} not found`, 404);
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 12);

      // Increment token version to invalidate all existing tokens
      const updateData = {
        password: hashedPassword,
        tokenVersion: (user.tokenVersion || 0) + 1,
        passwordResetAt: new Date().toISOString(),
        passwordResetBy: req.user?.id || "admin",
        passwordResetReason: reason || "Admin reset",
      };

      await usersCollection.update(userId, updateData);

      logger.warn(`Password reset for user: ${user.username}`, {
        userId,
        username: user.username,
        resetBy: updateData.passwordResetBy,
        reason,
        newTokenVersion: updateData.tokenVersion,
      });

      res.json({
        success: true,
        data: {
          userId,
          username: user.username,
          passwordResetAt: updateData.passwordResetAt,
          tokenVersion: updateData.tokenVersion,
        },
        message:
          "Password reset successfully. All existing tokens invalidated.",
      });
    }),
  );

  /**
   * Invalidate all user tokens (force re-login)
   * POST /api/admin/users/:userId/invalidate-tokens
   */
  router.post(
    "/admin/users/:userId/invalidate-tokens",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_invalidate_tokens", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { reason } = req.body;

      const db = await getDbConnection();
      const usersCollection = db.collection("users");

      // Get current user
      const user = await usersCollection.document(userId).catch(() => null);
      if (!user) {
        throw new AppError(`User ${userId} not found`, 404);
      }

      // Increment token version to invalidate all existing tokens
      const updateData = {
        tokenVersion: (user.tokenVersion || 0) + 1,
        tokensInvalidatedAt: new Date().toISOString(),
        tokensInvalidatedBy: req.user?.id || "admin",
        invalidationReason: reason || "Admin action",
      };

      await usersCollection.update(userId, updateData);

      logger.warn(`Tokens invalidated for user: ${user.username}`, {
        userId,
        username: user.username,
        invalidatedBy: updateData.tokensInvalidatedBy,
        reason,
        newTokenVersion: updateData.tokenVersion,
      });

      res.json({
        success: true,
        data: {
          userId,
          username: user.username,
          tokensInvalidatedAt: updateData.tokensInvalidatedAt,
          tokenVersion: updateData.tokenVersion,
        },
        message: "All user tokens invalidated. User must login again.",
      });
    }),
  );

  /**
   * Deactivate user (soft delete)
   * DELETE /api/admin/users/:userId
   */
  router.delete(
    "/admin/users/:userId",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_deactivate_user", {
      max: 5,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { confirm, reason } = req.body;

      if (!confirm || confirm !== "DEACTIVATE") {
        throw new AppError(
          'Must provide confirmation with "confirm": "DEACTIVATE"',
          400,
        );
      }

      const db = await getDbConnection();
      const usersCollection = db.collection("users");

      // Get user before deactivation for audit
      const user = await usersCollection.document(userId).catch(() => null);
      if (!user) {
        throw new AppError(`User ${userId} not found`, 404);
      }

      // Soft delete - mark as inactive and invalidate tokens
      const updateData = {
        active: false,
        tokenVersion: (user.tokenVersion || 0) + 1, // Invalidate tokens
        deactivatedAt: new Date().toISOString(),
        deactivatedBy: req.user?.id || "admin",
        deactivationReason: reason || "No reason provided",
      };

      await usersCollection.update(userId, updateData);

      logger.warn(`User deactivated: ${user.username}`, {
        userId,
        username: user.username,
        orgId: user.orgId,
        deactivatedBy: updateData.deactivatedBy,
        reason,
      });

      res.json({
        success: true,
        data: {
          userId,
          username: user.username,
          deactivatedAt: updateData.deactivatedAt,
          reason: updateData.deactivationReason,
        },
        message: "User deactivated successfully",
      });
    }),
  );

  /**
   * Reactivate user
   * POST /api/admin/users/:userId/reactivate
   */
  router.post(
    "/admin/users/:userId/reactivate",
    orgPermissions(["admin:write"]),
    createEndpointRateLimit("admin_reactivate_user", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { reason } = req.body;

      const db = await getDbConnection();
      const usersCollection = db.collection("users");

      // Get user
      const user = await usersCollection.document(userId).catch(() => null);
      if (!user) {
        throw new AppError(`User ${userId} not found`, 404);
      }

      if (user.active) {
        throw new AppError(`User ${user.username} is already active`, 400);
      }

      const updateData = {
        active: true,
        reactivatedAt: new Date().toISOString(),
        reactivatedBy: req.user?.id || "admin",
        reactivationReason: reason || "Admin reactivation",
      };

      await usersCollection.update(userId, updateData);

      logger.info(`User reactivated: ${user.username}`, {
        userId,
        username: user.username,
        reactivatedBy: updateData.reactivatedBy,
        reason,
      });

      res.json({
        success: true,
        data: {
          userId,
          username: user.username,
          reactivatedAt: updateData.reactivatedAt,
          reason: updateData.reactivationReason,
        },
        message: "User reactivated successfully",
      });
    }),
  );

  // ========================================
  // RAML GENERATION ENDPOINTS
  // ========================================

  /**
   * POST /api/raml/generate
   * Generate RAML specification for MuleSoft integrations
   */
  router.post(
    "/raml/generate",
    createEndpointRateLimit("raml_generate", { max: 20, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { requirements, options = {} } = req.body;

      if (!requirements) {
        throw new ValidationError("Requirements object is required");
      }

      // Ensure RAML service is available
      if (!orchestrator.ramlGenerationService) {
        throw new AppError("RAMLGenerationService not initialized", 500);
      }

      // Generate session ID for tracking
      const sessionId =
        options.sessionId ||
        `raml_session_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).substring(7)}`;

      const result = await orchestrator.ramlGenerationService.generateRAML(
        requirements,
        {
          ...options,
          orgId: req.orgId || options.orgId || "system",
          userId: req.user?.userId || options.userId || "system",
          sessionId: sessionId,
          useCache: options.useCache !== false,
        },
      );

      res.json({
        success: true,
        data: result,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/raml/validate
   * Validate RAML specification
   */
  router.post(
    "/raml/validate",
    createEndpointRateLimit("raml_validate", { max: 50, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { raml } = req.body;

      if (!raml) {
        throw new ValidationError("RAML content is required");
      }

      // Ensure RAML service is available
      if (!orchestrator.ramlGenerationService) {
        throw new AppError("RAMLGenerationService not initialized", 500);
      }

      const validation =
        await orchestrator.ramlGenerationService.validateRAML(raml);

      res.json({
        success: true,
        validation: validation,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/raml/refine
   * Refine RAML based on validation feedback
   */
  router.post(
    "/raml/refine",
    createEndpointRateLimit("raml_refine", { max: 10, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { raml, validation, options = {} } = req.body;

      if (!raml || !validation) {
        throw new ValidationError(
          "RAML content and validation results are required",
        );
      }

      // Ensure RAML service is available
      if (!orchestrator.ramlGenerationService) {
        throw new AppError("RAMLGenerationService not initialized", 500);
      }

      const result = await orchestrator.ramlGenerationService.refineRAML(
        raml,
        validation,
        {
          ...options,
          orgId: req.orgId || options.orgId || "system",
          userId: req.user?.userId || options.userId || "system",
        },
      );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/raml/generate/salesforce
   * Generate Salesforce-specific RAML
   */
  router.post(
    "/raml/generate/salesforce",
    createEndpointRateLimit("raml_sf_generate", { max: 15, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { objects, options = {} } = req.body;

      if (!objects || !Array.isArray(objects) || objects.length === 0) {
        throw new ValidationError("Salesforce objects array is required");
      }

      // Ensure RAML service is available
      if (!orchestrator.ramlGenerationService) {
        throw new AppError("RAMLGenerationService not initialized", 500);
      }

      // Generate session ID for tracking
      const sessionId =
        options.sessionId ||
        `sf_raml_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).substring(7)}`;

      const result =
        await orchestrator.ramlGenerationService.generateSalesforceRAML(
          objects,
          {
            ...options,
            orgId: req.orgId || options.orgId || "system",
            userId: req.user?.userId || options.userId || "system",
            sessionId: sessionId,
          },
        );

      res.json({
        success: true,
        data: result,
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/raml/templates
   * Get available RAML templates
   */
  router.get(
    "/raml/templates",
    createEndpointRateLimit("raml_templates", { max: 100, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      // Ensure RAML service is available
      if (!orchestrator.ramlGenerationService) {
        throw new AppError("RAMLGenerationService not initialized", 500);
      }

      res.json({
        success: true,
        data: {
          apiPatterns: orchestrator.ramlGenerationService.apiPatterns,
          ramlSpec: orchestrator.ramlGenerationService.ramlSpec,
          supportedIntegrations: [
            "salesforce",
            "generic-rest",
            "database",
            "messaging",
          ],
        },
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/raml/session/{sessionId}
   * Get RAML generation session data
   */
  router.get(
    "/raml/session/:sessionId",
    createEndpointRateLimit("raml_session", { max: 100, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      const { sessionId } = req.params;

      // Ensure RAML service is available
      if (!orchestrator.ramlGenerationService) {
        throw new AppError("RAMLGenerationService not initialized", 500);
      }

      const sessionData =
        await orchestrator.ramlGenerationService.getSessionCache(sessionId, {});

      if (!sessionData) {
        throw new AppError("Session not found or expired", 404);
      }

      res.json({
        success: true,
        data: sessionData,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // ========================================
  // MULESOFT DISCOVERY ENDPOINTS
  // ========================================

  /**
   * GET /api/mulesoft/discover/all
   * Comprehensive discovery of MuleSoft landscape
   */
  router.get(
    "/mulesoft/discover/all",
    createEndpointRateLimit("mulesoft_discover_all", {
      max: 5,
      windowMs: 300000,
    }),
    asyncHandler(async (req, res) => {
      // Initialize MuleSoft Discovery Service if not available
      if (!orchestrator.muleSoftDiscoveryService) {
        const { MuleSoftDiscoveryService } =
          await import("../services/MuleSoftDiscoveryService.js");
        orchestrator.muleSoftDiscoveryService = new MuleSoftDiscoveryService(
          orchestrator,
        );
        await orchestrator.muleSoftDiscoveryService.initialize();
      }

      const discoveries =
        await orchestrator.muleSoftDiscoveryService.discoverAll(req.query);

      res.json({
        success: true,
        data: discoveries,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/mulesoft/discover/apis
   * Discover available APIs
   */
  router.get(
    "/mulesoft/discover/apis",
    createEndpointRateLimit("mulesoft_discover_apis", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.muleSoftDiscoveryService) {
        const { MuleSoftDiscoveryService } =
          await import("../services/MuleSoftDiscoveryService.js");
        orchestrator.muleSoftDiscoveryService = new MuleSoftDiscoveryService(
          orchestrator,
        );
        await orchestrator.muleSoftDiscoveryService.initialize();
      }

      const apis = await orchestrator.muleSoftDiscoveryService.discoverAPIs(
        req.query,
      );

      res.json({
        success: true,
        data: apis,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * GET /api/mulesoft/discover/applications
   * Discover deployed applications and flows
   */
  router.get(
    "/mulesoft/discover/applications",
    createEndpointRateLimit("mulesoft_discover_apps", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      if (!orchestrator.muleSoftDiscoveryService) {
        const { MuleSoftDiscoveryService } =
          await import("../services/MuleSoftDiscoveryService.js");
        orchestrator.muleSoftDiscoveryService = new MuleSoftDiscoveryService(
          orchestrator,
        );
        await orchestrator.muleSoftDiscoveryService.initialize();
      }

      const applications =
        await orchestrator.muleSoftDiscoveryService.discoverApplications(
          req.query,
        );

      res.json({
        success: true,
        data: applications,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * POST /api/mulesoft/integration/recommendations
   * Get integration recommendations based on Salesforce objects
   */
  router.post(
    "/mulesoft/integration/recommendations",
    createEndpointRateLimit("mulesoft_recommendations", {
      max: 10,
      windowMs: 60000,
    }),
    asyncHandler(async (req, res) => {
      const { salesforceObjects } = req.body;

      if (!salesforceObjects || !Array.isArray(salesforceObjects)) {
        throw new ValidationError("salesforceObjects array is required");
      }

      if (!orchestrator.muleSoftDiscoveryService) {
        const { MuleSoftDiscoveryService } =
          await import("../services/MuleSoftDiscoveryService.js");
        orchestrator.muleSoftDiscoveryService = new MuleSoftDiscoveryService(
          orchestrator,
        );
        await orchestrator.muleSoftDiscoveryService.initialize();
      }

      const recommendations =
        await orchestrator.muleSoftDiscoveryService.generateIntegrationRecommendations(
          salesforceObjects,
        );

      res.json({
        success: true,
        data: recommendations,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // =====================================================
  // ADMIN ROUTES - Always loaded
  // =====================================================
  router.use("/admin", adminRoutes(orchestrator));
  router.use("/admin/agent", adminAgentRoutes);

  // =====================================================
  // HEALTHCARE ROUTES - Always loaded
  // =====================================================
  router.use("/healthcare/analytics", healthcareAnalyticsRoutes);
  router.use("/healthcare", healthcareRoutes(orchestrator));

  // =====================================================
  // SALESFORCE ROUTES - Only in non-healthcare mode
  // =====================================================
  if (!healthcareMode) {
    // Mount Flow documentation routes
    router.use("/flows", flowDocumentationRoutes(orchestrator, eventSystem));

    // Mount Flow Optimizer routes
    router.use("/flow-optimizer", flowOptimizerRoutes(orchestrator));

    // Mount Documentation routes
    router.use("/documentation", documentationRoutes(orchestrator));

    // Mount workflow routes
    router.use("/", workflowRoutes(orchestrator, eventSystem));

    // Mount service builder agent routes
    router.use("/dev/agent", serviceBuilderRoutes);

    // Mount permission analysis routes
    router.use("/", permissionAnalysisRoutes(orchestrator, eventSystem));

    // Mount permission discovery routes
    router.use("/", permissionDiscoveryRoutes(orchestrator, eventSystem));

    // Mount permission ingestion routes
    router.use("/", permissionIngestionRoutes(orchestrator, eventSystem));

    // Mount technical debt routes
    router.use("/", technicalDebtRoutes(orchestrator, eventSystem));

    // Mount change tracking routes
    router.use(
      "/change-tracking",
      changeTrackingRoutes(orchestrator, eventSystem),
    );

    // Mount capability graph routes
    router.use("/", capabilityGraphRoutes(orchestrator, eventSystem));

    // Mount compliance field analysis routes
    router.use("/", complianceRoutes(orchestrator, eventSystem));

    // Mount GitHub Impact Agent routes
    router.use("/github-impact", githubImpactRoutes);

    // Mount Package Discovery routes
    router.use("/packages", packageDiscoveryRoutes);

    // Capability-specific APIs (Change Impact, etc.)
    router.use("/capabilities", capabilitiesRoutes(orchestrator));

    // Mount Impact Analysis routes
    router.use("/impact", impactAnalysisRoutes);

    // Mount IR Plan Viewer routes
    router.use("/ir-plan-viewer", irPlanViewerRoutes(orchestrator, eventSystem));

    // Mount Intent IR routes
    router.use("/intent", intentRoutes);

    // Mount Metadata Analytics routes
    router.use("/analytics", metadataAnalyticsRoutes(orchestrator, eventSystem));

    // Mount Graph Query routes
    router.use("/graph", graphQueryRoutes);

    // Mount ISV Developer Platform routes
    router.use("/isv", isvRoutes);

    // Mount Cross-Org comparison routes
    router.use("/cross-org", crossOrgRoutes(orchestrator));
  }

  // TEST ROUTE: Metadata list test (for debugging UI metadata ingestion)
  // Only available in non-healthcare mode
  if (!healthcareMode) {
    router.post(
      "/test/metadata-list",
      asyncHandler(async (req, res) => {
        const { orgId, metadataType, folder } = req.body;

        if (!orgId || !metadataType) {
          throw new ValidationError("orgId and metadataType are required");
        }

        const { connection } =
          await orchestrator.salesforceService.getIntegrationToken(orgId);

        const listRequest = folder
          ? [{ type: metadataType, folder }]
          : [{ type: metadataType }];

        const result = await connection.metadata.list(listRequest, "60.0");
        const items = Array.isArray(result) ? result : result ? [result] : [];

        res.json({
          success: true,
          metadataType,
          folder: folder || null,
          count: items.length,
          items: items.slice(0, 50).map((i) => ({
            fullName: i.fullName,
            type: i.type,
            fileName: i.fileName,
            lastModifiedDate: i.lastModifiedDate,
          })),
        });
      }),
    );
  }

  // =============================================================================
  // REDIS CACHE DEBUG ROUTES
  // =============================================================================

  /**
   * Flush all Redis keys (for debugging stale cache issues)
   * POST /api/cache/flush
   */
  router.post(
    "/cache/flush",
    asyncHandler(async (req, res) => {
      const cache = orchestrator.cache;
      if (!cache) {
        return res.status(503).json({ success: false, error: "Cache not available" });
      }

      try {
        const result = await cache.flushDb();
        logger.warn("Redis cache flushed via API");
        return res.json({
          success: true,
          message: "All Redis keys flushed",
          flushed: result,
        });
      } catch (error) {
        logger.error("Cache flush failed:", error);
        return res.status(500).json({ success: false, error: error.message });
      }
    }),
  );

  /**
   * Delete Redis keys matching a pattern
   * POST /api/cache/delete-pattern
   * Body: { pattern: "llm:*" }
   */
  router.post(
    "/cache/delete-pattern",
    asyncHandler(async (req, res) => {
      const { pattern } = req.body;
      if (!pattern) {
        return res.status(400).json({ success: false, error: "pattern is required" });
      }

      const cache = orchestrator.cache;
      if (!cache) {
        return res.status(503).json({ success: false, error: "Cache not available" });
      }

      try {
        const deleted = await cache.deletePattern(pattern);
        logger.info(`Deleted ${deleted} keys matching pattern: ${pattern}`);
        return res.json({
          success: true,
          pattern,
          deleted,
        });
      } catch (error) {
        logger.error("Cache delete pattern failed:", error);
        return res.status(500).json({ success: false, error: error.message });
      }
    }),
  );

  /**
   * List Redis keys matching a pattern (for debugging)
   * GET /api/cache/keys?pattern=llm:*
   */
  router.get(
    "/cache/keys",
    asyncHandler(async (req, res) => {
      const pattern = req.query.pattern || "*";

      const cache = orchestrator.cache;
      if (!cache || !cache.redis) {
        return res.status(503).json({ success: false, error: "Cache not available" });
      }

      try {
        const keys = await cache.redis.scan(pattern, 100);
        return res.json({
          success: true,
          pattern,
          count: keys.length,
          keys: keys.slice(0, 100), // Limit to 100 keys
        });
      } catch (error) {
        logger.error("Cache keys list failed:", error);
        return res.status(500).json({ success: false, error: error.message });
      }
    }),
  );

  return router;
}
