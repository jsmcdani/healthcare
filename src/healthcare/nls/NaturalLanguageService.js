/**
 * NaturalLanguageService - Main NLS orchestrator
 */

import { Logger } from '../../utils/logger.js';
import { getIntentRegistry } from './IntentRegistry.js';
import { getRuleBasedParser } from './parsers/RuleBasedParser.js';
import { createLLMParser } from './parsers/LLMParser.js';
import { createClarificationEnvelope, createSuccessEnvelope, ClarificationReason } from './contracts/IntentParseEnvelope.js';
import { createConfirmResponse, validateConfirmation } from './contracts/IntentConfirmEnvelope.js';

const logger = new Logger('NaturalLanguageService');

const DEFAULT_CONFIG = { ruleConfidenceThreshold: 0.8, enableLLMFallback: true, cacheEnabled: true, cacheTTLSeconds: 300 };

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
      if (deps.cache) this.externalCache = deps.cache;
      if (deps.orchestrator && this.config.enableLLMFallback) {
        this.llmParser = createLLMParser(deps.orchestrator);
        logger.info('LLM fallback enabled via cachedLLMCall');
      }
      this.initialized = true;
      logger.info('NaturalLanguageService initialized');
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
      const ruleResult = this.ruleParser.parse(trimmedText, context);

      if (ruleResult) {
        if (ruleResult.payload.parseConfidence >= this.config.ruleConfidenceThreshold) {
          await this._setCache(cacheKey, ruleResult);
          if (ruleResult.payload.requiresClarification) this._storePending(ruleResult);
          return ruleResult;
        }

        if (this.llmParser && this.config.enableLLMFallback) {
          const llmResult = await this.llmParser.parse(trimmedText, context);
          if (llmResult.payload.parseConfidence > ruleResult.payload.parseConfidence) {
            llmResult.payload.trace.parserUsed = 'hybrid';
            await this._setCache(cacheKey, llmResult);
            if (llmResult.payload.requiresClarification) this._storePending(llmResult);
            return llmResult;
          }
        }

        await this._setCache(cacheKey, ruleResult);
        if (ruleResult.payload.requiresClarification) this._storePending(ruleResult);
        return ruleResult;
      }

      if (this.llmParser && this.config.enableLLMFallback) {
        const llmResult = await this.llmParser.parse(trimmedText, context);
        await this._setCache(cacheKey, llmResult);
        if (llmResult.payload.requiresClarification) this._storePending(llmResult);
        return llmResult;
      }

      const unknownResult = createClarificationEnvelope({
        intentFamily: 'system', parameters: [], parseConfidence: 0,
        clarification: { reason: ClarificationReason.AMBIGUOUS_INTENT, message: 'Unable to understand. Try /help.', options: [{ label: 'Show Help', value: 'hc:help', intentId: 'hc:help' }] },
        originalText: trimmedText, trace: { parserUsed: 'rule-based', ruleMatches: [], llmInvoked: !!this.llmParser, parseTimeMs: 0 }, correlationId: context.correlationId
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

      const confirmedEnvelope = createSuccessEnvelope({
        intentId: confirmedIntentId, intentFamily: intent.intentFamily, parameters: mergedParameters, parseConfidence: 1.0,
        originalText, trace: { parserUsed: 'confirmed', ruleMatches: [], llmInvoked: false, parseTimeMs: 0 }
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
