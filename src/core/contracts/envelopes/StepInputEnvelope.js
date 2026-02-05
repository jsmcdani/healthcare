/**
 * StepInputEnvelope - Contract for recipe step inputs
 *
 * Every step in a recipe receives its input through this envelope.
 * The executor validates this before step execution.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../EnvelopeHeader.js';
import { SchemaIds } from '../schema-ids.js';

/**
 * Step input parameters - the actual data for the step
 */
export const StepInputParamsSchema = z.record(z.string(), z.any()).describe('Step parameters as key-value pairs');

/**
 * Step context passed to execution
 */
export const StepContextSchema = z.object({
  orgId: z.string().describe('Organization identifier'),
  userId: z.string().optional().describe('User executing the recipe'),
  sessionId: z.string().optional().describe('Session identifier'),
  recipeId: z.string().describe('Recipe being executed'),
  stepId: z.string().describe('Current step identifier'),
  cache: z.any().optional().describe('Cache instance'),
  orchestrator: z.any().optional().describe('Orchestrator instance')
});

/**
 * Prior step results available to this step
 */
export const PriorResultsSchema = z.record(z.string(), z.any()).describe('Results from prior steps');

/**
 * Step Input Envelope payload
 */
export const StepInputPayloadSchema = z.object({
  stepType: z.string().describe('Step type (e.g., "haven/query", "compute/merge")'),
  params: StepInputParamsSchema,
  context: StepContextSchema,
  priorResults: PriorResultsSchema.optional(),
  dependsOn: z.array(z.string()).optional().describe('Step IDs this step depends on')
});

/**
 * Full Step Input Envelope
 */
export const StepInputEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: StepInputPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});

/**
 * Create a step input envelope
 */
export function createStepInputEnvelope(options) {
  const {
    stepType,
    params,
    context,
    priorResults,
    dependsOn,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.STEP_INPUT,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'execute_step',
    source: 'RecipeExecutor',
    traceId
  });

  return {
    header,
    payload: {
      stepType,
      params,
      context,
      priorResults,
      dependsOn
    },
    _meta: {
      validated: true,
      validatedAt: new Date().toISOString()
    }
  };
}

/**
 * Validate a step input envelope
 */
export function validateStepInput(envelope) {
  return StepInputEnvelopeSchema.safeParse(envelope);
}

export default StepInputEnvelopeSchema;
