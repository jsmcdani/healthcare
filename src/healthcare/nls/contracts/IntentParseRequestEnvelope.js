/**
 * IntentParseRequestEnvelope - Input contract for NLS intent parsing
 */

import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const RequestContextSchema = Joi.object({
  userId: Joi.string().optional(),
  orgId: Joi.string().optional(),
  sessionId: Joi.string().optional(),
  previousIntentId: Joi.string().optional(),
  timezone: Joi.string().optional(),
  locale: Joi.string().default('en-US')
});

const RequestHeaderSchema = Joi.object({
  requestId: Joi.string().uuid().required(),
  requestType: Joi.string().valid('IntentParseRequest').required(),
  version: Joi.string().default('1.0.0'),
  timestamp: Joi.string().isoDate().required()
});

const RequestPayloadSchema = Joi.object({
  rawText: Joi.string().min(1).max(2000).required(),
  context: RequestContextSchema.default({})
});

export const IntentParseRequestEnvelopeSchema = Joi.object({
  header: RequestHeaderSchema.required(),
  payload: RequestPayloadSchema.required()
});

export function createIntentParseRequest(params) {
  const envelope = {
    header: {
      requestId: uuidv4(),
      requestType: 'IntentParseRequest',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    },
    payload: {
      rawText: params.rawText,
      context: params.context || {}
    }
  };

  const { error, value } = IntentParseRequestEnvelopeSchema.validate(envelope, { stripUnknown: true });
  if (error) throw new Error(`Invalid IntentParseRequestEnvelope: ${error.message}`);
  return value;
}

export function createSimpleRequest(rawText, context = {}) {
  return createIntentParseRequest({ rawText, context });
}

export function validateRequest(request) {
  const { error, value } = IntentParseRequestEnvelopeSchema.validate(request, { stripUnknown: true });
  return { isValid: !error, error: error?.message, value };
}

export default {
  IntentParseRequestEnvelopeSchema,
  createIntentParseRequest,
  createSimpleRequest,
  validateRequest
};
