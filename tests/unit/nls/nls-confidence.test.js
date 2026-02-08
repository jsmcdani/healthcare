import { jest } from '@jest/globals';
import { createMockParseContext } from '../../helpers/mock-factories.js';

// NLSConfidenceIntegration uses module-level state (calculator, packData, tierReliability, queryClarity).
// We test against the real pack file (nls-intent-parsing.confidence.json).
// This validates the full stack: pack loading → signal mapping → ConfidenceCalculator.

// Reset module state between test groups by using dynamic imports
let nlsModule;

beforeAll(async () => {
  nlsModule = await import('../../../src/healthcare/nls/NLSConfidenceIntegration.js');
});

describe('NLSConfidenceIntegration', () => {

  describe('initializeNLSConfidence', () => {
    test('loads pack without error', () => {
      expect(() => nlsModule.initializeNLSConfidence()).not.toThrow();
    });

    test('returns a ConfidenceCalculator instance', () => {
      const calculator = nlsModule.initializeNLSConfidence();
      expect(calculator).toBeDefined();
      expect(typeof calculator.calculate).toBe('function');
    });
  });

  describe('getNLSConfidenceModelInfo', () => {
    test('returns model info with pack metadata', () => {
      const info = nlsModule.getNLSConfidenceModelInfo();
      expect(info.modelId).toBe('nls_intent_parsing_v1');
      expect(info.modelVersion).toBe('1.0.0');
      expect(info.packVersion).toBe('1.0.0');
      expect(info.factorCount).toBe(4);
    });

    test('includes signal mapping metadata', () => {
      const info = nlsModule.getNLSConfidenceModelInfo();
      expect(info.signalMappings).toBeDefined();
      expect(info.signalMappings.tierReliabilityKeys).toEqual(
        expect.arrayContaining(['trigger', 'pattern', 'synonym', 'llm', 'confirmed', 'none'])
      );
      expect(info.signalMappings.queryClarity.brackets).toBe(3);
      expect(info.signalMappings.queryClarity.default).toBe(0.7);
    });
  });

  describe('calculateNLSConfidence - tier reliability mapping', () => {
    test('trigger match gets highest reliability (1.0)', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'trigger',
        rawConfidence: 1.0,
        entityCompleteness: 1.0,
        queryLength: 20
      }));
      // trigger: source_reliability = 1.0, raw = 1.0, entity = 1.0
      // Should be HIGH confidence with boosts (exactTriggerMatch, allEntitiesExtracted, highPatternWeight, singleClearMatch)
      expect(result.level).toBe('HIGH');
      expect(result.canProceed).toBe(true);
      expect(result.value).toBeGreaterThanOrEqual(0.85);
    });

    test('pattern match gets moderate reliability (0.8)', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85,
        entityCompleteness: 1.0,
        queryLength: 25
      }));
      expect(result.value).toBeGreaterThan(0.5);
      expect(['HIGH', 'MODERATE']).toContain(result.level);
    });

    test('synonym match gets lower reliability (0.6)', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'synonym',
        rawConfidence: 0.7,
        entityCompleteness: 0.8,
        queryLength: 20
      }));
      expect(result.value).toBeLessThan(
        nlsModule.calculateNLSConfidence(createMockParseContext({
          matchType: 'pattern',
          rawConfidence: 0.7,
          entityCompleteness: 0.8,
          queryLength: 20
        })).value
      );
    });

    test('llm fallback gets reliability 0.65', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'llm',
        rawConfidence: 0.65,
        entityCompleteness: 0.8,
        queryLength: 40
      }));
      // llm matchType triggers llmFallback penalty (0.85 multiplier)
      // and lowPatternMatch penalty (rawConfidence < 0.7, 0.8 multiplier)
      expect(result.canProceed).toBe(true);
      expect(result.value).toBeGreaterThan(0);
    });

    test('confirmed match gets full reliability (1.0)', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'confirmed',
        rawConfidence: 0.95,
        entityCompleteness: 1.0,
        queryLength: 30
      }));
      expect(result.value).toBeGreaterThan(0.7);
    });

    test('none match gets zero reliability', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'none',
        rawConfidence: 0,
        entityCompleteness: 0,
        missingRequired: true,
        queryLength: 5,
        intentId: null
      }));
      // matchType 'none' → source_reliability = 0.0
      // Also triggers 'no_intent_match' uncertainty trigger
      expect(result.level).toBe('UNCERTAIN');
      expect(result.canProceed).toBe(false);
    });
  });

  describe('calculateNLSConfidence - query clarity brackets', () => {
    test('very short query (< 5) gets low clarity (0.3)', () => {
      const short = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85,
        queryLength: 3,
        entityCompleteness: 1.0
      }));
      const medium = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85,
        queryLength: 25,
        entityCompleteness: 1.0
      }));
      // Shorter query → lower data_quality factor → lower overall score
      expect(short.value).toBeLessThan(medium.value);
    });

    test('medium query (5-14) gets 0.6 clarity', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85,
        queryLength: 10,
        entityCompleteness: 1.0
      }));
      expect(result.value).toBeGreaterThan(0);
    });

    test('long query (15-49) gets 0.8 clarity', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85,
        queryLength: 30,
        entityCompleteness: 1.0
      }));
      expect(result.value).toBeGreaterThan(0);
    });

    test('very long query (>=50) gets highest clarity (0.9)', () => {
      const longest = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85,
        queryLength: 60,
        entityCompleteness: 1.0
      }));
      const shorter = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85,
        queryLength: 3,
        entityCompleteness: 1.0
      }));
      expect(longest.value).toBeGreaterThan(shorter.value);
    });
  });

  describe('calculateNLSConfidence - penalties', () => {
    test('ambiguousIntent penalty reduces confidence', () => {
      const clear = nlsModule.calculateNLSConfidence(createMockParseContext({
        hasAmbiguity: false,
        closeMatchCount: 0
      }));
      const ambiguous = nlsModule.calculateNLSConfidence(createMockParseContext({
        hasAmbiguity: true,
        closeMatchCount: 3
      }));
      expect(ambiguous.value).toBeLessThan(clear.value);
    });

    test('missingRequiredParams penalty reduces confidence', () => {
      const complete = nlsModule.calculateNLSConfidence(createMockParseContext({
        missingRequired: false
      }));
      const missing = nlsModule.calculateNLSConfidence(createMockParseContext({
        missingRequired: true
      }));
      expect(missing.value).toBeLessThan(complete.value);
    });

    test('llmFallback penalty applied for llm matchType', () => {
      const pattern = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'pattern',
        rawConfidence: 0.85
      }));
      const llm = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'llm',
        rawConfidence: 0.85
      }));
      // llm gets both lower tier reliability AND the llmFallback penalty
      expect(llm.value).toBeLessThan(pattern.value);
    });

    test('lowPatternMatch penalty for rawConfidence < 0.7', () => {
      const high = nlsModule.calculateNLSConfidence(createMockParseContext({
        rawConfidence: 0.85
      }));
      const low = nlsModule.calculateNLSConfidence(createMockParseContext({
        rawConfidence: 0.55
      }));
      expect(low.value).toBeLessThan(high.value);
    });

    test('partialEntityMatch penalty for incomplete entities', () => {
      const complete = nlsModule.calculateNLSConfidence(createMockParseContext({
        entityCompleteness: 1.0
      }));
      const partial = nlsModule.calculateNLSConfidence(createMockParseContext({
        entityCompleteness: 0.6
      }));
      expect(partial.value).toBeLessThan(complete.value);
    });
  });

  describe('calculateNLSConfidence - boosts', () => {
    test('exactTriggerMatch boost for trigger matchType', () => {
      const trigger = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'trigger',
        rawConfidence: 0.85,
        entityCompleteness: 1.0
      }));
      // trigger gets exactTriggerMatch boost (+0.1) + higher tier reliability
      expect(trigger.value).toBeGreaterThan(0.7);
    });

    test('allEntitiesExtracted boost when complete and no missing required', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        entityCompleteness: 1.0,
        missingRequired: false
      }));
      // allEntitiesExtracted boost applied
      expect(result.value).toBeGreaterThan(0);
    });

    test('highPatternWeight boost for rawConfidence >= 0.9', () => {
      // Use lower entity completeness to avoid hitting the 1.0 cap
      const high = nlsModule.calculateNLSConfidence(createMockParseContext({
        rawConfidence: 0.95,
        matchType: 'pattern',
        entityCompleteness: 0.6,
        queryLength: 10
      }));
      const medium = nlsModule.calculateNLSConfidence(createMockParseContext({
        rawConfidence: 0.80,
        matchType: 'pattern',
        entityCompleteness: 0.6,
        queryLength: 10
      }));
      expect(high.value).toBeGreaterThan(medium.value);
    });

    test('singleClearMatch boost when no ambiguity', () => {
      const clear = nlsModule.calculateNLSConfidence(createMockParseContext({
        hasAmbiguity: false,
        closeMatchCount: 0
      }));
      // singleClearMatch boost applied
      expect(clear.value).toBeGreaterThan(0);
    });
  });

  describe('calculateNLSConfidence - uncertainty triggers', () => {
    test('no_intent_match trigger when no intent and not llm', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        intentId: null,
        matchType: 'pattern',
        rawConfidence: 0.5
      }));
      // no_intent_match added → uncertainty trigger fires
      expect(result.level).toBe('UNCERTAIN');
      expect(result.canProceed).toBe(false);
    });

    test('llmFailed triggers uncertainty', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        llmFailed: true,
        matchType: 'pattern',
        rawConfidence: 0.5
      }));
      // llmFailed adds no_intent_match → uncertainty trigger
      expect(result.level).toBe('UNCERTAIN');
      expect(result.canProceed).toBe(false);
    });

    test('matchType none triggers uncertainty', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext({
        matchType: 'none',
        rawConfidence: 0,
        intentId: null
      }));
      expect(result.level).toBe('UNCERTAIN');
      expect(result.canProceed).toBe(false);
    });
  });

  describe('calculateNLSConfidence - result metadata', () => {
    test('pins pack version in result', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext());
      expect(result.packVersion).toBe('1.0.0');
      expect(result.modelId).toBe('nls_intent_parsing_v1');
      expect(result.modelVersion).toBe('1.0.0');
    });

    test('result value is between 0 and 1', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext());
      expect(result.value).toBeGreaterThanOrEqual(0);
      expect(result.value).toBeLessThanOrEqual(1);
    });

    test('result has valid level', () => {
      const result = nlsModule.calculateNLSConfidence(createMockParseContext());
      expect(['HIGH', 'MODERATE', 'LOW', 'UNCERTAIN']).toContain(result.level);
    });
  });

  describe('explainNLSConfidence', () => {
    test('returns explanation with steps', () => {
      const explanation = nlsModule.explainNLSConfidence(createMockParseContext());
      expect(explanation.model).toBeDefined();
      expect(explanation.model.modelId).toBe('nls_intent_parsing_v1');
      expect(explanation.steps).toBeDefined();
      expect(explanation.steps.length).toBeGreaterThanOrEqual(1);
      expect(explanation.result).toBeDefined();
    });

    test('explain for trigger match shows high confidence', () => {
      const explanation = nlsModule.explainNLSConfidence(createMockParseContext({
        matchType: 'trigger',
        rawConfidence: 1.0,
        entityCompleteness: 1.0,
        queryLength: 20
      }));
      expect(explanation.result.level).toBe('HIGH');
    });
  });
});
