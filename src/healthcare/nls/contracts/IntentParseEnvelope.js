/**
 * IntentParseEnvelope - Output contract for NLS intent parsing
 */

import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

export const ParameterSource = {
  EXPLICIT: 'explicit',
  INFERRED: 'inferred',
  DEFAULT: 'default'
};

export const ClarificationReason = {
  AMBIGUOUS_INTENT: 'ambiguous_intent',
  MISSING_REQUIRED_PARAMETER: 'missing_required_parameter',
  MULTIPLE_INTENT_MATCHES: 'multiple_intent_matches',
  LOW_CONFIDENCE: 'low_confidence',
  UNKNOWN_ENTITY: 'unknown_entity'
};

export const IntentFamily = {
  CLINICAL: 'clinical',
  ADMINISTRATIVE: 'administrative',
  SYSTEM: 'system'
};

const EnvelopeHeaderSchema = Joi.object({
  envelopeId: Joi.string().uuid().required(),
  envelopeType: Joi.string().valid('IntentParseEnvelope').required(),
  version: Joi.string().default('1.0.0'),
  timestamp: Joi.string().isoDate().required(),
  correlationId: Joi.string().allow(null).optional(),
  source: Joi.string().default('nls')
});

const ParameterSchema = Joi.object({
  name: Joi.string().required(),
  value: Joi.any().required(),
  source: Joi.string().valid(...Object.values(ParameterSource)).required(),
  confidence: Joi.number().min(0).max(1).required()
});

const ClarificationOptionSchema = Joi.object({
  label: Joi.string().required(),
  value: Joi.string().required(),
  intentId: Joi.string().required()
});

const ClarificationSchema = Joi.object({
  reason: Joi.string().valid(...Object.values(ClarificationReason)).required(),
  message: Joi.string().required(),
  options: Joi.array().items(ClarificationOptionSchema).optional(),
  missingParameters: Joi.array().items(Joi.string()).optional()
});

const ParseTraceSchema = Joi.object({
  parserUsed: Joi.string().valid('rule-based', 'llm', 'hybrid').required(),
  ruleMatches: Joi.array().items(Joi.object({
    pattern: Joi.string(),
    confidence: Joi.number()
  })).default([]),
  llmInvoked: Joi.boolean().default(false),
  parseTimeMs: Joi.number().required()
});

const PayloadSchema = Joi.object({
  intentId: Joi.string().allow(null).required(),
  intentFamily: Joi.string().valid(...Object.values(IntentFamily)).required(),
  parameters: Joi.array().items(ParameterSchema).default([]),
  parseConfidence: Joi.number().min(0).max(1).required(),
  requiresClarification: Joi.boolean().required(),
  clarification: ClarificationSchema.optional(),
  originalText: Joi.string().required(),
  trace: ParseTraceSchema.required()
});

export const IntentParseEnvelopeSchema = Joi.object({
  header: EnvelopeHeaderSchema.required(),
  payload: PayloadSchema.required()
});

export function createIntentParseEnvelope(params) {
  const envelope = {
    header: {
      envelopeId: uuidv4(),
      envelopeType: 'IntentParseEnvelope',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      correlationId: params.correlationId || null,
      source: 'nls'
    },
    payload: {
      intentId: params.intentId,
      intentFamily: params.intentFamily || IntentFamily.SYSTEM,
      parameters: params.parameters || [],
      parseConfidence: params.parseConfidence,
      requiresClarification: params.requiresClarification,
      clarification: params.clarification || undefined,
      originalText: params.originalText,
      trace: params.trace
    }
  };

  const { error, value } = IntentParseEnvelopeSchema.validate(envelope, { stripUnknown: true });
  if (error) throw new Error(`Invalid IntentParseEnvelope: ${error.message}`);
  return value;
}

export function createClarificationEnvelope(params) {
  return createIntentParseEnvelope({
    intentId: null,
    intentFamily: params.intentFamily || IntentFamily.SYSTEM,
    parameters: params.parameters || [],
    parseConfidence: params.parseConfidence || 0,
    requiresClarification: true,
    clarification: params.clarification,
    originalText: params.originalText,
    trace: params.trace,
    correlationId: params.correlationId
  });
}

export function createSuccessEnvelope(params) {
  return createIntentParseEnvelope({
    intentId: params.intentId,
    intentFamily: params.intentFamily,
    parameters: params.parameters,
    parseConfidence: params.parseConfidence,
    requiresClarification: false,
    originalText: params.originalText,
    trace: params.trace,
    correlationId: params.correlationId
  });
}

export default {
  IntentParseEnvelopeSchema,
  createIntentParseEnvelope,
  createClarificationEnvelope,
  createSuccessEnvelope,
  ParameterSource,
  ClarificationReason,
  IntentFamily
};
