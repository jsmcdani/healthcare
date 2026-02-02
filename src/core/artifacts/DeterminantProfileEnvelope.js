/**
 * DeterminantProfileEnvelope - Profile artifact with version pinning
 *
 * Determinant profiles define the rules and configurations that
 * determine system behavior. They require approval for changes.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../contracts/EnvelopeHeader.js';
import { registerSchema, SchemaIds } from '../contracts/registry.js';
import {
  BaseArtifactPayloadSchema,
  RiskClassificationSchema,
  EvidenceRefSchema,
  ArtifactStatusSchema
} from './BaseArtifact.js';

/**
 * Profile scope - what the profile applies to
 */
export const ProfileScopeSchema = z.object({
  domain: z.string().describe('Domain this profile applies to (e.g., "healthcare", "compliance")'),
  subDomain: z.string().optional().describe('Sub-domain (e.g., "phi", "hipaa")'),
  entityTypes: z.array(z.string()).optional().describe('Entity types this profile covers'),
  actions: z.array(z.string()).optional().describe('Actions this profile governs')
});

/**
 * Determinant rule - a single rule in the profile
 */
export const DeterminantRuleSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  condition: z.string().describe('Condition expression'),
  action: z.enum(['allow', 'deny', 'require_approval', 'flag', 'transform']),
  priority: z.number().default(0).describe('Higher priority rules evaluated first'),
  enabled: z.boolean().default(true),
  metadata: z.record(z.any()).optional()
});

/**
 * Version pin - explicit version reference
 */
export const VersionPinSchema = z.object({
  dependencyId: z.string().describe('ID of the dependent artifact/schema'),
  pinnedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  pinnedAt: z.string().datetime(),
  pinnedBy: z.string().optional(),
  reason: z.string().optional()
});

/**
 * Determinant Profile payload
 */
export const DeterminantProfilePayloadSchema = BaseArtifactPayloadSchema.extend({
  artifactType: z.literal('determinant_profile'),
  scope: ProfileScopeSchema,
  rules: z.array(DeterminantRuleSchema).describe('Profile rules'),
  versionPins: z.array(VersionPinSchema).optional().describe('Explicit version pins'),
  inheritsFrom: z.string().optional().describe('Parent profile ID if inheritance'),
  overrides: z.array(z.object({
    ruleId: z.string(),
    originalValue: z.any(),
    overrideValue: z.any(),
    reason: z.string()
  })).optional().describe('Overrides from inherited profile'),
  effectiveFrom: z.string().datetime().optional().describe('When this profile becomes effective'),
  effectiveUntil: z.string().datetime().optional().describe('When this profile expires'),
  approvalHistory: z.array(z.object({
    action: z.enum(['submitted', 'approved', 'rejected', 'revoked']),
    timestamp: z.string().datetime(),
    userId: z.string(),
    comment: z.string().optional()
  })).optional()
});

/**
 * Full Determinant Profile Envelope
 */
export const DeterminantProfileEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: DeterminantProfilePayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a determinant profile
 */
export function createDeterminantProfile(options) {
  const {
    name,
    description,
    version = '1.0.0',
    orgId,
    createdBy,
    scope,
    rules = [],
    versionPins,
    inheritsFrom,
    effectiveFrom,
    effectiveUntil,
    tags,
    traceId
  } = options;

  const now = new Date().toISOString();

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.ARTIFACT_PROFILE,
    schemaVersion: '1.0.0',
    userId: createdBy,
    action: 'create_profile',
    source: 'ProfileFactory',
    traceId
  });

  return {
    header,
    payload: {
      artifactId: crypto.randomUUID(),
      artifactType: 'determinant_profile',
      name,
      description,
      version,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      createdBy,
      orgId,
      tags,
      riskClassification: 'HIGH', // Profiles always require approval
      scope,
      rules,
      versionPins,
      inheritsFrom,
      effectiveFrom: effectiveFrom || now,
      effectiveUntil,
      approvalHistory: []
    },
    _meta: {
      validated: true,
      validatedAt: now
    }
  };
}

/**
 * Add a rule to a profile
 */
export function addProfileRule(profile, rule) {
  const newRule = {
    ruleId: crypto.randomUUID(),
    enabled: true,
    priority: 0,
    ...rule
  };

  profile.payload.rules.push(newRule);
  profile.payload.updatedAt = new Date().toISOString();

  return newRule;
}

/**
 * Pin a version in the profile
 */
export function pinVersion(profile, dependencyId, pinnedVersion, options = {}) {
  const pin = {
    dependencyId,
    pinnedVersion,
    pinnedAt: new Date().toISOString(),
    pinnedBy: options.pinnedBy,
    reason: options.reason
  };

  if (!profile.payload.versionPins) {
    profile.payload.versionPins = [];
  }

  // Remove existing pin for this dependency
  profile.payload.versionPins = profile.payload.versionPins.filter(
    p => p.dependencyId !== dependencyId
  );

  profile.payload.versionPins.push(pin);
  profile.payload.updatedAt = new Date().toISOString();

  return pin;
}

/**
 * Validate a determinant profile
 */
export function validateDeterminantProfile(profile) {
  return DeterminantProfileEnvelopeSchema.safeParse(profile);
}

// Register schema on load
try {
  registerSchema(SchemaIds.ARTIFACT_PROFILE, '1.0.0', DeterminantProfileEnvelopeSchema);
} catch (e) {
  // Already registered
}

export default DeterminantProfileEnvelopeSchema;
