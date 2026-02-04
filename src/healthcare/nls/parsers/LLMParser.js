/**
 * LLMParser - Bounded LLM fallback for intent parsing
 * Uses cachedLLMCall with outputSchema - Claude Structured Outputs
 */

import { Logger } from '../../../utils/logger.js';
import { cachedLLMCall } from '../../../utils/cachedLLM.js';
import { getIntentRegistry } from '../IntentRegistry.js';
import { createSuccessEnvelope, createClarificationEnvelope, ClarificationReason, ParameterSource } from '../contracts/IntentParseEnvelope.js';
import { NLSIntentClassificationSchema } from '../schemas/NLSIntentClassificationSchema.js';

const logger = new Logger('LLMParser');

const SYSTEM_PROMPT = `You are a healthcare intent classifier. Classify user input into one of the allowed intents.

ALLOWED INTENTS:
{{INTENT_LIST}}

RULES:
1. Select intentId from the allowed list only - DO NOT invent new intents
2. If unsure or intent unclear, set requiresClarification: true and intentId: null
3. Extract parameters (patientId, condition, timeRange, urgency) only if clearly present in input
4. Set confidence based on how clear the user's intent is`;

export class LLMParser {
  constructor() {
    this.registry = getIntentRegistry();
    this.orchestrator = null;
    this.systemPrompt = null;
  }

  initialize(orchestrator) {
    this.orchestrator = orchestrator;
    this._buildSystemPrompt();
    logger.info('LLMParser initialized');
  }

  _buildSystemPrompt() {
    const intentList = this.registry.getIntentSummary()
      .map(i => `- ${i.intentId}: ${i.description} (required: ${i.requiredParameters.join(', ') || 'none'})`)
      .join('\n');
    this.systemPrompt = SYSTEM_PROMPT.replace('{{INTENT_LIST}}', intentList);
  }

  async parse(text, context = {}) {
    const startTime = Date.now();

    if (!this.orchestrator) {
      return this._createFallback(text, Date.now() - startTime);
    }

    try {
      if (!this.systemPrompt) this._buildSystemPrompt();

      const userPrompt = `Classify this healthcare input:\n\n"${text}"`;
      const cache = this.orchestrator?.cache;

      const result = await cachedLLMCall(
        this.orchestrator,
        cache,
        context.orgId || 'nls',
        this.systemPrompt,
        userPrompt,
        {
          temperature: 0,
          maxTokens: 500,
          outputSchema: NLSIntentClassificationSchema, // Claude Structured Outputs - guaranteed valid JSON
          cachePrefix: 'nls:intent-parse',
          cacheTTL: 1800
        }
      );

      const parseTimeMs = Date.now() - startTime;
      // With outputSchema, result.data is already parsed and validated
      const parsed = result?.data || result;

      if (!parsed || typeof parsed !== 'object') {
        return this._createFallback(text, parseTimeMs);
      }

      // Validate intentId is from registry (schema enforces enum, but double-check)
      if (parsed.intentId && !this.registry.isKnown(parsed.intentId)) {
        logger.warn(`LLM returned unknown intent: ${parsed.intentId}`);
        return this._createFallback(text, parseTimeMs);
      }

      if (parsed.requiresClarification || !parsed.intentId) {
        return this._createClarificationFromLLM(parsed, text, parseTimeMs, context);
      }

      return this._createSuccessFromLLM(parsed, text, parseTimeMs, context);
    } catch (error) {
      logger.error('LLM parse error:', error.message);
      return this._createFallback(text, Date.now() - startTime);
    }
  }

  _createSuccessFromLLM(parsed, originalText, parseTimeMs, context) {
    const intent = this.registry.getIntent(parsed.intentId);
    const parameters = parsed.parameters.map(p => ({
      name: p.name,
      value: p.value,
      source: ParameterSource.INFERRED,
      confidence: p.confidence || parsed.confidence
    }));

    const missingRequired = this.registry.getMissingRequired(parsed.intentId, parameters);
    if (missingRequired.length > 0) {
      return createClarificationEnvelope({
        intentFamily: intent.intentFamily,
        parameters,
        parseConfidence: parsed.confidence * 0.8,
        clarification: {
          reason: ClarificationReason.MISSING_REQUIRED_PARAMETER,
          message: `Missing required: ${missingRequired.join(', ')}`,
          missingParameters: missingRequired
        },
        originalText,
        trace: { parserUsed: 'llm', ruleMatches: [], llmInvoked: true, parseTimeMs },
        correlationId: context.correlationId
      });
    }

    return createSuccessEnvelope({
      intentId: parsed.intentId,
      intentFamily: intent.intentFamily,
      parameters,
      parseConfidence: parsed.confidence,
      originalText,
      trace: { parserUsed: 'llm', ruleMatches: [], llmInvoked: true, parseTimeMs },
      correlationId: context.correlationId
    });
  }

  _createClarificationFromLLM(parsed, originalText, parseTimeMs, context) {
    return createClarificationEnvelope({
      intentFamily: 'system',
      parameters: parsed.parameters?.map(p => ({
        name: p.name,
        value: p.value,
        source: ParameterSource.INFERRED,
        confidence: p.confidence || parsed.confidence
      })) || [],
      parseConfidence: parsed.confidence || 0,
      clarification: {
        reason: ClarificationReason.LOW_CONFIDENCE,
        message: parsed.reasoning || 'Could not determine intent. Try /help for commands.'
      },
      originalText,
      trace: { parserUsed: 'llm', ruleMatches: [], llmInvoked: true, parseTimeMs },
      correlationId: context.correlationId
    });
  }

  _createFallback(originalText, parseTimeMs) {
    return createClarificationEnvelope({
      intentFamily: 'system',
      parameters: [],
      parseConfidence: 0,
      clarification: {
        reason: ClarificationReason.AMBIGUOUS_INTENT,
        message: 'Could not understand request. Try /help for available commands.',
        options: [{ label: 'Show Help', value: 'hc:help', intentId: 'hc:help' }]
      },
      originalText,
      trace: { parserUsed: 'llm', ruleMatches: [], llmInvoked: true, parseTimeMs }
    });
  }
}

export function createLLMParser(orchestrator) {
  const parser = new LLMParser();
  if (orchestrator) parser.initialize(orchestrator);
  return parser;
}

export default LLMParser;
