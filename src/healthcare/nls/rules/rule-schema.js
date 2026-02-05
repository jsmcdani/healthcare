/**
 * Rule Schema - Zod validation for intent rule tables
 *
 * P1: Closed-world intent universe (allowlist only)
 * P2: Deterministic-first (tier 1 triggers, tier 2 patterns)
 * P5: Auditability + version pinning
 */

import { z } from 'zod';
import { IntentFamilySchema, ParseTier } from '../contracts/zod/IntentParseEnvelope.js';

/**
 * Pattern rule schema (tier 2)
 */
export const PatternRuleSchema = z.object({
  regex: z.string().describe('Regular expression with named capture groups'),
  weight: z.number().min(0).max(1).describe('Confidence weight when matched'),
  tier: z.number().int().default(ParseTier.TIER_2_PATTERN)
});

/**
 * Required parameter definition
 */
export const ParameterDefSchema = z.object({
  name: z.string().describe('Parameter name'),
  type: z.enum(['string', 'number', 'boolean', 'date', 'patientId', 'medication', 'condition'])
    .default('string'),
  description: z.string().optional(),
  defaultValue: z.unknown().optional()
});

/**
 * Clinical safety levels
 */
export const ClinicalSafetyLevelSchema = z.enum([
  'informational',   // Read-only, no action
  'advisory',        // Recommendations
  'action_required', // Clinical action
  'critical'         // High-risk action
]).default('informational');

/**
 * Single clinical intent rule
 */
export const ClinicalIntentRuleSchema = z.object({
  intentId: z.string()
    .regex(/^(hc:|clinical\.)/)
    .describe('Unique intent ID (must start with hc: or clinical.)'),

  domain: z.enum([
    'staging',
    'medication_safety',
    'triage',
    'care_gaps',
    'patient_summary',
    'treatment',
    'administrative',
    'system'
  ]).describe('Clinical domain'),

  name: z.string().describe('Human-readable intent name'),
  description: z.string().describe('Detailed description'),
  intentFamily: IntentFamilySchema,

  // Tier 1: Explicit slash command triggers
  triggers: z.array(z.string().startsWith('/'))
    .min(1)
    .describe('Tier 1: Slash command triggers'),

  // Tier 2: Regex patterns with confidence weights
  patterns: z.array(PatternRuleSchema).default([])
    .describe('Tier 2: Regex patterns'),

  // Synonyms for fuzzy matching
  synonyms: z.array(z.string()).default([]),

  // Parameters
  requiredParameters: z.array(ParameterDefSchema).default([]),
  optionalParameters: z.array(ParameterDefSchema).default([]),

  // Execution
  recipe: z.string().describe('Recipe ID to execute'),

  // Clinical safety
  requiresConfirmation: z.boolean().default(false),
  clinicalSafetyLevel: ClinicalSafetyLevelSchema,

  // Documentation
  examples: z.array(z.string()).default([])
});

/**
 * Full rule table file schema
 */
export const RuleTableSchema = z.object({
  version: z.string()
    .regex(/^\d+\.\d+\.\d+$/)
    .describe('Semantic version of this rule table'),

  lastUpdated: z.string().datetime()
    .describe('ISO timestamp of last update'),

  description: z.string().optional(),

  intents: z.array(ClinicalIntentRuleSchema)
    .min(1)
    .describe('Array of intent definitions')
});

/**
 * Validate a rule table (deterministic - throws on error)
 */
export function parseRuleTable(ruleTable) {
  return RuleTableSchema.parse(ruleTable);
}

/**
 * Validate a rule table (safe - returns result object)
 */
export function validateRuleTable(ruleTable) {
  return RuleTableSchema.safeParse(ruleTable);
}

/**
 * Validate a single intent rule (deterministic)
 */
export function parseIntentRule(intent) {
  return ClinicalIntentRuleSchema.parse(intent);
}

/**
 * Validate a single intent rule (safe)
 */
export function validateIntentRule(intent) {
  return ClinicalIntentRuleSchema.safeParse(intent);
}

export default {
  PatternRuleSchema,
  ParameterDefSchema,
  ClinicalSafetyLevelSchema,
  ClinicalIntentRuleSchema,
  RuleTableSchema,
  parseRuleTable,
  validateRuleTable,
  parseIntentRule,
  validateIntentRule
};
