/**
 * LLMParser - Bounded LLM fallback for intent parsing
 *
 * Uses cachedLLMCall with outputSchema - Claude Structured Outputs.
 * Outputs raw parse signals. Confidence is computed centrally by the
 * control plane (NLSConfidenceIntegration), NEVER self-reported by the LLM.
 *
 * Per the spec: "Confidence never computed inside the LLM."
 */

import { Logger } from '../../../utils/logger.js';
import { cachedLLMCall } from '../../../utils/cachedLLM.js';
import { getIntentRegistry } from '../IntentRegistry.js';
import { NLSIntentClassificationSchema } from '../schemas/NLSIntentClassificationSchema.js';

const logger = new Logger('LLMParser');

const SYSTEM_PROMPT = `You are a healthcare intent classifier. Classify user input into one of the allowed intents.

ALLOWED INTENTS:
{{INTENT_LIST}}

RULES:
1. Select intentId from the allowed list only - DO NOT invent new intents
2. If unsure or intent unclear, set requiresClarification: true and intentId: null
3. Extract parameters (patientId, condition, timeRange, urgency) only if clearly present in input
4. DO NOT output a confidence score - confidence is computed by the platform`;

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

  /**
   * Parse text and return raw signals for central confidence computation
   * @returns {Object} Raw parse result with signals (confidence computed by control plane)
   */
  async parse(text, context = {}) {
    const startTime = Date.now();

    if (!this.orchestrator) {
      return this._createFallbackSignals(text, Date.now() - startTime);
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
          outputSchema: NLSIntentClassificationSchema,
          cachePrefix: 'nls:intent-parse',
          cacheTTL: 1800
        }
      );

      const parseTimeMs = Date.now() - startTime;
      const parsed = result?.data || result;

      if (!parsed || typeof parsed !== 'object') {
        return this._createFallbackSignals(text, parseTimeMs);
      }

      // Validate intentId is from registry
      if (parsed.intentId && !this.registry.isKnown(parsed.intentId)) {
        logger.warn(`LLM returned unknown intent: ${parsed.intentId}`);
        return this._createFallbackSignals(text, parseTimeMs);
      }

      if (parsed.requiresClarification || !parsed.intentId) {
        return this._createClarificationSignals(parsed, text, parseTimeMs, context);
      }

      return this._createSuccessSignals(parsed, text, parseTimeMs, context);
    } catch (error) {
      logger.error('LLM parse error:', error.message);
      return this._createFallbackSignals(text, Date.now() - startTime);
    }
  }

  _createSuccessSignals(parsed, originalText, parseTimeMs, context) {
    const intent = this.registry.getIntent(parsed.intentId);
    // Only include parameters that have confidence - no made-up values
    const parameters = (parsed.parameters || [])
      .filter(p => p.confidence !== undefined && p.confidence !== null)
      .map(p => ({
        name: p.name,
        value: p.value,
        source: 'inferred',
        confidence: p.confidence
      }));

    const missingRequired = this.registry.getMissingRequired(parsed.intentId, parameters);
    const totalRequired = intent.requiredParameters?.length || 0;

    // Return raw signals - confidence computed by control plane
    return {
      intentId: parsed.intentId,
      intentFamily: intent.intentFamily,
      parameters,
      originalText,

      // Raw signals for confidence computation (control plane)
      signals: {
        matchType: 'llm',
        tier: 3,
        // LLM's raw output - NOT used as confidence, just as a signal
        llmRawConfidence: parsed.confidence || 0.5,
        queryLength: originalText.length,
        hasAmbiguity: false,
        closeMatchCount: 0,
        totalRequired,
        missingRequired: missingRequired.length,
        entityCompleteness: totalRequired > 0
          ? (totalRequired - missingRequired.length) / totalRequired
          : 1.0,
        llmReasoning: parsed.reasoning
      },

      requiresClarification: missingRequired.length > 0,
      clarificationReason: missingRequired.length > 0 ? 'missing_required' : null,
      missingParameters: missingRequired,

      trace: {
        parserUsed: 'llm',
        tier: 3,
        ruleMatches: [],
        llmInvoked: true,
        parseTimeMs
      },

      correlationId: context.correlationId
    };
  }

  _createClarificationSignals(parsed, originalText, parseTimeMs, context) {
    return {
      intentId: null,
      intentFamily: 'system',
      parameters: (parsed.parameters || []).map(p => ({
        name: p.name,
        value: p.value,
        source: 'inferred'
      })),
      originalText,

      signals: {
        matchType: 'llm',
        tier: 3,
        llmRawConfidence: parsed.confidence || 0,
        queryLength: originalText.length,
        hasAmbiguity: true,
        closeMatchCount: 0,
        totalRequired: 0,
        missingRequired: 0,
        entityCompleteness: 0.5,
        llmReasoning: parsed.reasoning
      },

      requiresClarification: true,
      clarificationReason: 'low_confidence',
      clarificationMessage: parsed.reasoning || 'Could not determine intent. Try /help for commands.',

      trace: {
        parserUsed: 'llm',
        tier: 3,
        ruleMatches: [],
        llmInvoked: true,
        parseTimeMs
      },

      correlationId: context.correlationId
    };
  }

  _createFallbackSignals(originalText, parseTimeMs) {
    return {
      intentId: null,
      intentFamily: 'system',
      parameters: [],
      originalText,

      signals: {
        matchType: 'llm',
        tier: 3,
        llmRawConfidence: 0,
        queryLength: originalText.length,
        hasAmbiguity: true,
        closeMatchCount: 0,
        totalRequired: 0,
        missingRequired: 0,
        entityCompleteness: 0,
        llmFailed: true
      },

      requiresClarification: true,
      clarificationReason: 'ambiguous',
      clarificationMessage: 'Could not understand request. Try /help for available commands.',
      ambiguousOptions: [{ label: 'Show Help', value: 'hc:help', intentId: 'hc:help' }],

      trace: {
        parserUsed: 'llm',
        tier: 3,
        ruleMatches: [],
        llmInvoked: true,
        parseTimeMs
      }
    };
  }
}

export function createLLMParser(orchestrator) {
  const parser = new LLMParser();
  if (orchestrator) parser.initialize(orchestrator);
  return parser;
}

export default LLMParser;
