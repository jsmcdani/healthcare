/**
 * IntentConfirmEnvelope - Confirmation contract for NLS intent parsing
 */

import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

const ConfirmedParameterSchema = Joi.object({
  name: Joi.string().required(),
  value: Joi.any().required()
});

const ConfirmHeaderSchema = Joi.object({
  confirmId: Joi.string().uuid().required(),
  confirmType: Joi.string().valid('IntentConfirm').required(),
  version: Joi.string().default('1.0.0'),
  timestamp: Joi.string().isoDate().required()
});

const ConfirmPayloadSchema = Joi.object({
  parseEnvelopeId: Joi.string().uuid().required(),
  confirmedIntentId: Joi.string().required(),
  confirmedParameters: Joi.array().items(ConfirmedParameterSchema).default([]),
  additionalContext: Joi.string().optional()
});

export const IntentConfirmEnvelopeSchema = Joi.object({
  header: ConfirmHeaderSchema.required(),
  payload: ConfirmPayloadSchema.required()
});

export const ConfirmResponseSchema = Joi.object({
  confirmed: Joi.boolean().required(),
  parseEnvelope: Joi.object().optional(),
  routing: Joi.object({
    intentId: Joi.string().required(),
    recipeId: Joi.string().optional(),
    parameters: Joi.object().optional()
  }).optional(),
  readyForExecution: Joi.boolean().required(),
  error: Joi.string().optional()
});

export function createIntentConfirm(params) {
  const envelope = {
    header: {
      confirmId: uuidv4(),
      confirmType: 'IntentConfirm',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    },
    payload: {
      parseEnvelopeId: params.parseEnvelopeId,
      confirmedIntentId: params.confirmedIntentId,
      confirmedParameters: params.confirmedParameters || [],
      additionalContext: params.additionalContext
    }
  };

  const { error, value } = IntentConfirmEnvelopeSchema.validate(envelope, { stripUnknown: true });
  if (error) throw new Error(`Invalid IntentConfirmEnvelope: ${error.message}`);
  return value;
}

export function createConfirmResponse(params) {
  const response = {
    confirmed: params.confirmed,
    parseEnvelope: params.parseEnvelope,
    routing: params.routing,
    readyForExecution: params.readyForExecution,
    error: params.error
  };

  const { error, value } = ConfirmResponseSchema.validate(response, { stripUnknown: true });
  if (error) throw new Error(`Invalid ConfirmResponse: ${error.message}`);
  return value;
}

export function validateConfirmation(confirm) {
  const { error, value } = IntentConfirmEnvelopeSchema.validate(confirm, { stripUnknown: true });
  return { isValid: !error, error: error?.message, value };
}

export default {
  IntentConfirmEnvelopeSchema,
  ConfirmResponseSchema,
  createIntentConfirm,
  createConfirmResponse,
  validateConfirmation
};
