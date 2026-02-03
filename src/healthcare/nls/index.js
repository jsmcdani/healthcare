/**
 * NLS Module - Natural Language Service for Healthcare
 */

export { NaturalLanguageService, getNaturalLanguageService } from './NaturalLanguageService.js';
export { IntentRegistry, getIntentRegistry } from './IntentRegistry.js';
export { IntentParseEnvelopeSchema, createIntentParseEnvelope, createClarificationEnvelope, createSuccessEnvelope, ParameterSource, ClarificationReason, IntentFamily } from './contracts/IntentParseEnvelope.js';
export { IntentParseRequestEnvelopeSchema, createIntentParseRequest, createSimpleRequest, validateRequest } from './contracts/IntentParseRequestEnvelope.js';
export { IntentConfirmEnvelopeSchema, ConfirmResponseSchema, createIntentConfirm, createConfirmResponse, validateConfirmation } from './contracts/IntentConfirmEnvelope.js';
export { RuleBasedParser, getRuleBasedParser } from './parsers/RuleBasedParser.js';
export { LLMParser, createLLMParser } from './parsers/LLMParser.js';
export { EntityExtractor, getEntityExtractor } from './extractors/EntityExtractor.js';
export { getNaturalLanguageService as default } from './NaturalLanguageService.js';
