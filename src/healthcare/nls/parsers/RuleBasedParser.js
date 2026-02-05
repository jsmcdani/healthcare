/**
 * RuleBasedParser - Deterministic pattern-based intent parsing
 *
 * Outputs raw parse signals. Confidence is computed centrally by the
 * control plane (NLSConfidenceIntegration), never by the parser itself.
 */

import { Logger } from '../../../utils/logger.js';
import { getIntentRegistry } from '../IntentRegistry.js';
import { getEntityExtractor } from '../extractors/EntityExtractor.js';

const logger = new Logger('RuleBasedParser');

class ParseResult {
  constructor() {
    this.intentId = null;
    this.rawWeight = 0;  // Raw pattern weight - NOT confidence
    this.parameters = [];
    this.matchType = null;  // 'trigger', 'pattern', 'synonym'
    this.matchDetails = null;
    this.tier = null;  // 1, 2, or 3
  }
}

export class RuleBasedParser {
  constructor() {
    this.registry = getIntentRegistry();
    this.entityExtractor = getEntityExtractor();
  }

  /**
   * Parse text and return raw signals for central confidence computation
   * @returns {Object|null} Raw parse result with signals (NOT confidence)
   */
  parse(text, context = {}) {
    const startTime = Date.now();
    const trimmedText = text.trim();
    const matches = [];

    const triggerMatch = this._matchTrigger(trimmedText);
    if (triggerMatch) matches.push(triggerMatch);

    const patternMatches = this._matchPatterns(trimmedText);
    matches.push(...patternMatches);

    const synonymMatches = this._matchSynonyms(trimmedText);
    matches.push(...synonymMatches);

    if (matches.length === 0) return null;

    matches.sort((a, b) => b.rawWeight - a.rawWeight);
    const parseTimeMs = Date.now() - startTime;

    const topMatch = matches[0];
    const closeMatches = matches.filter(m => m.intentId !== topMatch.intentId && topMatch.rawWeight - m.rawWeight < 0.15);

    const additionalEntities = this.entityExtractor.extractAll(trimmedText);
    const mergedEntities = this.entityExtractor.mergeEntities(this._parametersToEntities(topMatch.parameters), additionalEntities);
    const intent = this.registry.getIntent(topMatch.intentId);
    const finalEntities = this.entityExtractor.applyDefaults(mergedEntities, intent);
    const finalParameters = this.entityExtractor.toParameterArray(finalEntities);
    const missingRequired = this.registry.getMissingRequired(topMatch.intentId, finalParameters);

    // Return raw signals for central confidence computation
    return {
      // Parse result
      intentId: topMatch.intentId,
      intentFamily: intent.intentFamily,
      parameters: finalParameters,
      originalText: trimmedText,

      // Raw signals for confidence computation (control plane)
      signals: {
        matchType: topMatch.matchType,
        tier: topMatch.tier,
        rawWeight: topMatch.rawWeight,
        queryLength: trimmedText.length,
        hasAmbiguity: closeMatches.length > 0,
        closeMatchCount: closeMatches.length,
        totalRequired: intent.requiredParameters?.length || 0,
        missingRequired: missingRequired.length,
        entityCompleteness: intent.requiredParameters?.length > 0
          ? (intent.requiredParameters.length - missingRequired.length) / intent.requiredParameters.length
          : 1.0,
        allMatches: matches.map(m => ({ intentId: m.intentId, matchType: m.matchType, rawWeight: m.rawWeight }))
      },

      // Clarification info
      requiresClarification: missingRequired.length > 0 || (closeMatches.length > 0 && topMatch.rawWeight < 0.85),
      clarificationReason: missingRequired.length > 0 ? 'missing_required' : (closeMatches.length > 0 ? 'ambiguous' : null),
      missingParameters: missingRequired,
      ambiguousOptions: closeMatches.length > 0 ? this._buildAmbiguousOptions(matches) : null,

      // Trace for audit (P5)
      trace: {
        parserUsed: 'rule-based',
        tier: topMatch.tier,
        ruleMatches: matches.map(m => ({ pattern: m.matchType, rawWeight: m.rawWeight, tier: m.tier })),
        llmInvoked: false,
        parseTimeMs,
        ruleTableVersion: this.registry.getRuleTableVersion?.() || 'unknown'
      },

      correlationId: context.correlationId
    };
  }

  _matchTrigger(text) {
    const firstWord = text.split(/\s+/)[0].toLowerCase();
    for (const intent of this.registry.getAllIntents()) {
      for (const trigger of intent.triggers) {
        if (firstWord === trigger.toLowerCase()) {
          const remaining = text.substring(trigger.length).trim();
          const entities = this.entityExtractor.extractAll(remaining);
          const result = new ParseResult();
          result.intentId = intent.intentId;
          result.rawWeight = 0.95;  // Raw weight, NOT confidence
          result.parameters = this.entityExtractor.toParameterArray(entities);
          result.matchType = 'trigger';
          result.tier = 1;
          result.matchDetails = { trigger, remaining };
          return result;
        }
      }
    }
    return null;
  }

  _matchPatterns(text) {
    const matches = [];
    for (const intent of this.registry.getAllIntents()) {
      for (const pattern of intent.patterns) {
        try {
          const regex = new RegExp(pattern.regex, 'i');
          const match = text.match(regex);
          if (match) {
            const entities = this.entityExtractor.extractFromGroups(match);
            const result = new ParseResult();
            result.intentId = intent.intentId;
            result.rawWeight = pattern.weight;  // Raw weight from pattern
            result.parameters = this.entityExtractor.toParameterArray(entities);
            result.matchType = 'pattern';
            result.tier = 2;
            result.matchDetails = { pattern: pattern.regex, groups: match.groups };
            matches.push(result);
          }
        } catch (e) { logger.warn(`Invalid regex: ${pattern.regex}`, e); }
      }
    }
    return matches;
  }

  _matchSynonyms(text) {
    const matches = [];
    const lowerText = text.toLowerCase();
    for (const intent of this.registry.getAllIntents()) {
      for (const synonym of intent.synonyms || []) {
        if (lowerText.includes(synonym.toLowerCase())) {
          const entities = this.entityExtractor.extractAll(text);
          const result = new ParseResult();
          result.intentId = intent.intentId;
          result.rawWeight = 0.6;  // Raw weight for synonyms
          result.parameters = this.entityExtractor.toParameterArray(entities);
          result.matchType = 'synonym';
          result.tier = 2;
          result.matchDetails = { synonym };
          matches.push(result);
        }
      }
    }
    return matches;
  }

  _buildAmbiguousOptions(matches) {
    const seen = new Set();
    const options = [];
    for (const match of matches) {
      if (!seen.has(match.intentId) && options.length < 4) {
        seen.add(match.intentId);
        const intent = this.registry.getIntent(match.intentId);
        options.push({ label: intent.name, value: match.intentId, intentId: match.intentId });
      }
    }
    return options;
  }

  _parametersToEntities(parameters) {
    const entities = {};
    for (const p of parameters) entities[p.name] = { value: p.value, confidence: p.confidence, source: p.source };
    return entities;
  }
}

let instance = null;
export function getRuleBasedParser() {
  if (!instance) instance = new RuleBasedParser();
  return instance;
}

export default RuleBasedParser;
