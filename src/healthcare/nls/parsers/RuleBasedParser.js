/**
 * RuleBasedParser - Deterministic pattern-based intent parsing
 */

import { Logger } from '../../../utils/logger.js';
import { getIntentRegistry } from '../IntentRegistry.js';
import { getEntityExtractor } from '../extractors/EntityExtractor.js';
import { createSuccessEnvelope, createClarificationEnvelope, ClarificationReason, ParameterSource } from '../contracts/IntentParseEnvelope.js';

const logger = new Logger('RuleBasedParser');

class ParseResult {
  constructor() {
    this.intentId = null;
    this.confidence = 0;
    this.parameters = [];
    this.matchType = null;
    this.matchDetails = null;
  }
}

export class RuleBasedParser {
  constructor() {
    this.registry = getIntentRegistry();
    this.entityExtractor = getEntityExtractor();
  }

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

    matches.sort((a, b) => b.confidence - a.confidence);
    const parseTimeMs = Date.now() - startTime;

    const topMatch = matches[0];
    const closeMatches = matches.filter(m => m.intentId !== topMatch.intentId && topMatch.confidence - m.confidence < 0.15);

    if (closeMatches.length > 0 && topMatch.confidence < 0.85) {
      return this._createAmbiguousResult(matches, trimmedText, parseTimeMs);
    }

    const additionalEntities = this.entityExtractor.extractAll(trimmedText);
    const mergedEntities = this.entityExtractor.mergeEntities(this._parametersToEntities(topMatch.parameters), additionalEntities);
    const intent = this.registry.getIntent(topMatch.intentId);
    const finalEntities = this.entityExtractor.applyDefaults(mergedEntities, intent);
    const finalParameters = this.entityExtractor.toParameterArray(finalEntities);
    const missingRequired = this.registry.getMissingRequired(topMatch.intentId, finalParameters);

    if (missingRequired.length > 0) {
      return createClarificationEnvelope({
        intentFamily: intent.intentFamily,
        parameters: finalParameters,
        parseConfidence: topMatch.confidence * 0.8,
        clarification: { reason: ClarificationReason.MISSING_REQUIRED_PARAMETER, message: `Missing required parameter(s): ${missingRequired.join(', ')}`, missingParameters: missingRequired },
        originalText: trimmedText,
        trace: { parserUsed: 'rule-based', ruleMatches: matches.map(m => ({ pattern: m.matchType, confidence: m.confidence })), llmInvoked: false, parseTimeMs },
        correlationId: context.correlationId
      });
    }

    return createSuccessEnvelope({
      intentId: topMatch.intentId,
      intentFamily: intent.intentFamily,
      parameters: finalParameters,
      parseConfidence: topMatch.confidence,
      originalText: trimmedText,
      trace: { parserUsed: 'rule-based', ruleMatches: matches.map(m => ({ pattern: m.matchType, confidence: m.confidence })), llmInvoked: false, parseTimeMs },
      correlationId: context.correlationId
    });
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
          result.confidence = 0.95;
          result.parameters = this.entityExtractor.toParameterArray(entities);
          result.matchType = 'trigger';
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
            result.confidence = pattern.weight;
            result.parameters = this.entityExtractor.toParameterArray(entities);
            result.matchType = 'pattern';
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
          result.confidence = 0.6;
          result.parameters = this.entityExtractor.toParameterArray(entities);
          result.matchType = 'synonym';
          result.matchDetails = { synonym };
          matches.push(result);
        }
      }
    }
    return matches;
  }

  _createAmbiguousResult(matches, originalText, parseTimeMs) {
    const seen = new Set();
    const topIntents = [];
    for (const match of matches) {
      if (!seen.has(match.intentId) && topIntents.length < 4) {
        seen.add(match.intentId);
        const intent = this.registry.getIntent(match.intentId);
        topIntents.push({ label: intent.name, value: match.intentId, intentId: match.intentId });
      }
    }
    return createClarificationEnvelope({
      intentFamily: 'system',
      parameters: matches[0].parameters,
      parseConfidence: matches[0].confidence * 0.7,
      clarification: { reason: ClarificationReason.AMBIGUOUS_INTENT, message: 'Multiple possible intents detected. Which did you mean?', options: topIntents },
      originalText,
      trace: { parserUsed: 'rule-based', ruleMatches: matches.slice(0, 5).map(m => ({ pattern: m.matchType, confidence: m.confidence })), llmInvoked: false, parseTimeMs }
    });
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
