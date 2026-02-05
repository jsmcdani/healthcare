/**
 * NaturalLanguageService - Main NLS orchestrator
 *
 * Coordinates parsing and CENTRAL CONFIDENCE COMPUTATION.
 * Per the Metalligent architecture:
 * - Parsers output raw signals
 * - Confidence is computed centrally by the control plane (Confidence Registry)
 * - Confidence is NEVER self-reported by the LLM
 */

import { Logger } from '../../utils/logger.js';
import { getIntentRegistry } from './IntentRegistry.js';
import { getRuleBasedParser } from './parsers/RuleBasedParser.js';
import { createLLMParser } from './parsers/LLMParser.js';
import { createClarificationEnvelope, createSuccessEnvelope, ClarificationReason } from './contracts/IntentParseEnvelope.js';
import { createConfirmResponse, validateConfirmation } from './contracts/IntentConfirmEnvelope.js';
import { calculateNLSConfidence, initializeNLSConfidence, getNLSConfidenceModelInfo } from './NLSConfidenceIntegration.js';

const logger = new Logger('NaturalLanguageService');

const DEFAULT_CONFIG = { ruleConfidenceThreshold: 0.7, enableLLMFallback: true, cacheEnabled: true, cacheTTLSeconds: 300 };

export class NaturalLanguageService {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = getIntentRegistry();
    this.ruleParser = getRuleBasedParser();
    this.llmParser = null;
    this.initialized = false;
    this.parseCache = new Map();
    this.pendingClarifications = new Map();
  }

  async initialize(deps = {}) {
    if (this.initialized) return;
    try {
      // Initialize central confidence computation (control plane)
      initializeNLSConfidence();

      if (deps.cache) this.externalCache = deps.cache;
      if (deps.orchestrator && this.config.enableLLMFallback) {
        this.llmParser = createLLMParser(deps.orchestrator);
        logger.info('LLM fallback enabled via cachedLLMCall');
      }
      this.initialized = true;
      logger.info('NaturalLanguageService initialized with central confidence computation');
    } catch (error) {
      logger.error('Failed to initialize NaturalLanguageService:', error);
      throw error;
    }
  }

  async parseIntent(params) {
    const { rawText, context = {} } = params;
    if (!rawText || typeof rawText !== 'string') {
      return createClarificationEnvelope({
        intentFamily: 'system', parameters: [], parseConfidence: 0,
        clarification: { reason: ClarificationReason.LOW_CONFIDENCE, message: 'No input provided.' },
        originalText: rawText || '', trace: { parserUsed: 'rule-based', ruleMatches: [], llmInvoked: false, parseTimeMs: 0 }
      });
    }

    const trimmedText = rawText.trim();
    const cacheKey = this._getCacheKey(trimmedText, context);
    const cached = await this._getFromCache(cacheKey);
    if (cached) return cached;

    try {
      // Get raw signals from rule-based parser
      const ruleResult = this.ruleParser.parse(trimmedText, context);

      if (ruleResult) {
        // Compute confidence centrally (control plane) - intentId is at top level, not in signals
        const confidence = this._computeCentralConfidence(ruleResult.signals, ruleResult.intentId);

        if (confidence.value >= this.config.ruleConfidenceThreshold && !ruleResult.requiresClarification) {
          const envelope = this._buildEnvelope(ruleResult, confidence);
          await this._setCache(cacheKey, envelope);
          return envelope;
        }

        // Try LLM if rule confidence is below threshold
        if (this.llmParser && this.config.enableLLMFallback) {
          const llmResult = await this.llmParser.parse(trimmedText, context);
          const llmConfidence = this._computeCentralConfidence(llmResult.signals, llmResult.intentId);

          if (llmConfidence.value > confidence.value) {
            const envelope = this._buildEnvelope(llmResult, llmConfidence, 'hybrid');
            await this._setCache(cacheKey, envelope);
            if (envelope.payload.requiresClarification) this._storePending(envelope);
            return envelope;
          }
        }

        // Return rule result with computed confidence
        const envelope = this._buildEnvelope(ruleResult, confidence);
        await this._setCache(cacheKey, envelope);
        if (envelope.payload.requiresClarification) this._storePending(envelope);
        return envelope;
      }

      // No rule match - try LLM fallback
      if (this.llmParser && this.config.enableLLMFallback) {
        const llmResult = await this.llmParser.parse(trimmedText, context);
        const llmConfidence = this._computeCentralConfidence(llmResult.signals, llmResult.intentId);
        const envelope = this._buildEnvelope(llmResult, llmConfidence);
        await this._setCache(cacheKey, envelope);
        if (envelope.payload.requiresClarification) this._storePending(envelope);
        return envelope;
      }

      // No match and no LLM - return unknown
      const unknownConfidence = this._computeCentralConfidence({
        matchType: 'none',
        tier: 0,
        rawWeight: 0,
        queryLength: trimmedText.length,
        hasAmbiguity: true,
        entityCompleteness: 0
      });

      const unknownResult = createClarificationEnvelope({
        intentFamily: 'system', parameters: [], parseConfidence: unknownConfidence.value,
        clarification: { reason: ClarificationReason.AMBIGUOUS_INTENT, message: 'Unable to understand. Try /help.', options: [{ label: 'Show Help', value: 'hc:help', intentId: 'hc:help' }] },
        originalText: trimmedText,
        trace: {
          parserUsed: 'rule-based',
          ruleMatches: [],
          llmInvoked: !!this.llmParser,
          parseTimeMs: 0,
          confidenceModel: unknownConfidence.modelId,
          confidenceLevel: unknownConfidence.level,
          safetyFlag: unknownConfidence.safetyFlag
        },
        correlationId: context.correlationId
      });
      await this._setCache(cacheKey, unknownResult);
      this._storePending(unknownResult);
      return unknownResult;
    } catch (error) {
      logger.error('Parse error:', error);
      return createClarificationEnvelope({
        intentFamily: 'system', parameters: [], parseConfidence: 0,
        clarification: { reason: ClarificationReason.LOW_CONFIDENCE, message: `Parse error: ${error.message}` },
        originalText: rawText.trim(), trace: { parserUsed: 'rule-based', ruleMatches: [], llmInvoked: false, parseTimeMs: 0 }
      });
    }
  }

  /**
   * CENTRAL CONFIDENCE COMPUTATION (Control Plane)
   *
   * Confidence is computed here, using the Confidence Registry,
   * regardless of whether LLM or rules were used for parsing.
   *
   * @param {Object} signals - Raw signals from the parser
   * @param {string} intentId - Intent ID from parse result (not in signals)
   */
  _computeCentralConfidence(signals, intentId = null) {
    return calculateNLSConfidence({
      matchType: signals.matchType,
      rawConfidence: signals.rawWeight || signals.llmRawConfidence || 0,
      queryLength: signals.queryLength,
      hasAmbiguity: signals.hasAmbiguity,
      closeMatchCount: signals.closeMatchCount || 0,
      entityCompleteness: signals.entityCompleteness,
      missingRequired: signals.missingRequired > 0,
      intentId: intentId,
      llmFailed: signals.llmFailed
    });
  }

  /**
   * Build envelope from raw parse result and computed confidence
   */
  _buildEnvelope(parseResult, confidence, parserOverride = null) {
    const trace = {
      ...parseResult.trace,
      parserUsed: parserOverride || parseResult.trace.parserUsed,
      // Confidence audit trail (P5)
      confidenceModel: confidence.modelId,
      confidenceModelVersion: confidence.modelVersion,
      confidenceLevel: confidence.level,
      confidenceFactors: confidence.factors,
      confidencePenalties: confidence.penalties,
      confidenceBoosts: confidence.boosts,
      canProceed: confidence.canProceed,
      safetyFlag: confidence.safetyFlag
    };

    if (parseResult.requiresClarification) {
      let reason = ClarificationReason.LOW_CONFIDENCE;
      if (parseResult.clarificationReason === 'missing_required') {
        reason = ClarificationReason.MISSING_REQUIRED_PARAMETER;
      } else if (parseResult.clarificationReason === 'ambiguous') {
        reason = ClarificationReason.AMBIGUOUS_INTENT;
      }

      return createClarificationEnvelope({
        intentFamily: parseResult.intentFamily || 'system',
        parameters: parseResult.parameters,
        parseConfidence: confidence.value,
        clarification: {
          reason,
          message: parseResult.clarificationMessage || this._getClarificationMessage(parseResult),
          options: parseResult.ambiguousOptions,
          missingParameters: parseResult.missingParameters
        },
        originalText: parseResult.originalText,
        trace,
        correlationId: parseResult.correlationId
      });
    }

    return createSuccessEnvelope({
      intentId: parseResult.intentId,
      intentFamily: parseResult.intentFamily,
      parameters: parseResult.parameters,
      parseConfidence: confidence.value,
      originalText: parseResult.originalText,
      trace,
      correlationId: parseResult.correlationId
    });
  }

  _getClarificationMessage(parseResult) {
    if (parseResult.missingParameters?.length > 0) {
      return `Missing required parameter(s): ${parseResult.missingParameters.join(', ')}`;
    }
    if (parseResult.clarificationReason === 'ambiguous') {
      return 'Multiple possible intents detected. Which did you mean?';
    }
    return 'Could not determine intent. Try /help for commands.';
  }

  async confirmIntent(confirmation) {
    try {
      const { isValid, error, value } = validateConfirmation(confirmation);
      if (!isValid) return createConfirmResponse({ confirmed: false, readyForExecution: false, error: `Invalid: ${error}` });

      const { parseEnvelopeId, confirmedIntentId, confirmedParameters } = value.payload;
      if (!this.registry.isKnown(confirmedIntentId)) return createConfirmResponse({ confirmed: false, readyForExecution: false, error: `Unknown intent: ${confirmedIntentId}` });

      const pending = this.pendingClarifications.get(parseEnvelopeId);
      const originalText = pending?.payload?.originalText || '';
      const intent = this.registry.getIntent(confirmedIntentId);

      const existingParams = pending?.payload?.parameters || [];
      const confirmedParamMap = new Map(confirmedParameters.map(p => [p.name, p.value]));
      const mergedParameters = [
        ...existingParams.filter(p => !confirmedParamMap.has(p.name)),
        ...confirmedParameters.map(p => ({ name: p.name, value: p.value, source: 'explicit', confidence: 1.0 }))
      ];

      const missingRequired = this.registry.getMissingRequired(confirmedIntentId, mergedParameters);
      if (missingRequired.length > 0) return createConfirmResponse({ confirmed: false, readyForExecution: false, error: `Missing: ${missingRequired.join(', ')}` });

      // Confirmed intents get full confidence from control plane
      const confirmedConfidence = this._computeCentralConfidence({
        matchType: 'confirmed',
        rawWeight: 1.0,
        queryLength: originalText.length,
        hasAmbiguity: false,
        entityCompleteness: 1.0,
        missingRequired: 0
      }, confirmedIntentId);

      const confirmedEnvelope = createSuccessEnvelope({
        intentId: confirmedIntentId, intentFamily: intent.intentFamily, parameters: mergedParameters,
        parseConfidence: confirmedConfidence.value,
        originalText,
        trace: {
          parserUsed: 'confirmed',
          ruleMatches: [],
          llmInvoked: false,
          parseTimeMs: 0,
          confidenceModel: confirmedConfidence.modelId,
          confidenceLevel: confirmedConfidence.level
        }
      });

      this.pendingClarifications.delete(parseEnvelopeId);
      const paramObj = {};
      for (const p of mergedParameters) paramObj[p.name] = p.value;

      return createConfirmResponse({ confirmed: true, parseEnvelope: confirmedEnvelope, routing: { intentId: confirmedIntentId, recipeId: intent.recipe, parameters: paramObj }, readyForExecution: true });
    } catch (error) {
      return createConfirmResponse({ confirmed: false, readyForExecution: false, error: error.message });
    }
  }

  getAvailableIntents() { return this.registry.getIntentSummary(); }

  getHelpText(intentId = null) {
    if (intentId) {
      const intent = this.registry.getIntent(intentId);
      if (!intent) return null;
      return { intentId: intent.intentId, name: intent.name, description: intent.description, triggers: intent.triggers, requiredParameters: intent.requiredParameters, examples: intent.examples };
    }
    return this.registry.getAllIntents().map(i => ({ intentId: i.intentId, name: i.name, description: i.description, triggers: i.triggers }));
  }

  getConfidenceModelInfo() {
    return getNLSConfidenceModelInfo();
  }

  _storePending(envelope) {
    const id = envelope.header.envelopeId;
    this.pendingClarifications.set(id, envelope);
    setTimeout(() => this.pendingClarifications.delete(id), 5 * 60 * 1000);
  }

  _getCacheKey(text, context) { return `nls:parse:${context.orgId || 'default'}:${text.toLowerCase().trim()}`; }

  async _getFromCache(key) {
    if (!this.config.cacheEnabled) return null;
    if (this.externalCache) { try { return await this.externalCache.getJSON(key); } catch {} }
    const entry = this.parseCache.get(key);
    if (entry && Date.now() - entry.timestamp < this.config.cacheTTLSeconds * 1000) return entry.value;
    return null;
  }

  async _setCache(key, value) {
    if (!this.config.cacheEnabled) return;
    this.parseCache.set(key, { value, timestamp: Date.now() });
    if (this.externalCache) { try { await this.externalCache.setJSON(key, value, this.config.cacheTTLSeconds); } catch {} }
  }

  clearCache() { this.parseCache.clear(); }
}

let instance = null;
export function getNaturalLanguageService() {
  if (!instance) instance = new NaturalLanguageService();
  return instance;
}

export default NaturalLanguageService;
