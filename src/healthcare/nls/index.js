/**
 * NLS Module - Natural Language Service for Healthcare
 *
 * P1: Closed-world intent universe (allowlist only)
 * P2: Deterministic-first (explicit → rules → optional LLM)
 * P3: Clarify, don't guess
 * P4: Dual confidence (parseConfidence vs decisionConfidence)
 * P5: Auditability + version pinning
 *
 * Uses Zod for deterministic, type-safe validation.
 */

// Core service
export { NaturalLanguageService, getNaturalLanguageService } from './NaturalLanguageService.js';

// Intent registry (with rule table loading)
export { IntentRegistry, getIntentRegistry, getIntentRegistryAsync } from './IntentRegistry.js';

// === ZOD-BASED CONTRACTS (Primary - use these) ===

// Intent parse request envelope (input with constraints)
export {
  IntentParseRequestEnvelopeSchema,
  RequestContextSchema,
  RequestConstraintsSchema,
  ClinicalModeSchema,
  ClinicalMode,
  createIntentParseRequest,
  createSimpleRequest,
  createDeterministicRequest,
  createConfirmationRequest,
  validateRequest
} from './contracts/zod/IntentParseRequestEnvelope.js';

// Intent parse envelope (output with dual confidence)
export {
  IntentParseEnvelopeSchema,
  IntentParsePayloadSchema,
  ParseTraceSchema,
  ParameterSchema,
  ClarificationSchema,
  ParameterSource,
  ParameterSourceSchema,
  ClarificationReason,
  ClarificationReasonSchema,
  IntentFamily,
  IntentFamilySchema,
  ParseTier,
  ParseTierSchema,
  createIntentParseEnvelope,
  createClarificationEnvelope,
  createSuccessEnvelope,
  createOutsideAllowlistEnvelope,
  validateParseEnvelope
} from './contracts/zod/IntentParseEnvelope.js';

// Intent confirm envelope (user acknowledgment)
export {
  IntentConfirmEnvelopeSchema,
  IntentConfirmPayloadSchema,
  ConfirmedParameterSchema,
  ConfirmResponseSchema,
  ConfirmationSource,
  ConfirmationSourceSchema,
  createIntentConfirm,
  createUserConfirm,
  createAutoConfirm,
  createConfirmResponse,
  validateConfirmation,
  validateConfirmResponse
} from './contracts/zod/IntentConfirmEnvelope.js';

// Rule tables (P1: closed-world, P5: version pinning)
export {
  loadRuleTables,
  clearRuleCache,
  getCurrentVersion,
  getCachedRules
} from './rules/index.js';

// Rule schema validation
export {
  RuleTableSchema,
  ClinicalIntentRuleSchema,
  validateRuleTable,
  validateIntentRule
} from './rules/rule-schema.js';

// Parsers
export { RuleBasedParser, getRuleBasedParser } from './parsers/RuleBasedParser.js';
export { LLMParser, createLLMParser } from './parsers/LLMParser.js';

// Entity extraction
export { EntityExtractor, getEntityExtractor } from './extractors/EntityExtractor.js';

// Confidence integration (P4: dual confidence with calibrated scoring)
export {
  initializeNLSConfidence,
  calculateNLSConfidence,
  explainNLSConfidence,
  getNLSConfidenceModelInfo
} from './NLSConfidenceIntegration.js';

// Default export
export { getNaturalLanguageService as default } from './NaturalLanguageService.js';
