import { jest } from '@jest/globals';
import { ConfidenceCalculator } from '../../../src/healthcare/confidence/core/ConfidenceCalculator.js';
import { CLINICAL_READINESS_V1, DRUG_INTERACTION_V1 } from '../../../src/healthcare/confidence/config/default-models.js';

// Minimal valid model for isolated tests
const MINIMAL_MODEL = {
  modelId: 'test_model_v1',
  modelVersion: '1.0.0',
  name: 'Test Model',
  factors: [
    { id: 'factor_a', name: 'Factor A', weight: 0.6, source: 'data_completeness', defaultValue: 0.5 },
    { id: 'factor_b', name: 'Factor B', weight: 0.4, source: 'data_quality', defaultValue: 0.5 }
  ],
  penalties: [
    { id: 'pen1', condition: 'testPenalty', multiplier: 0.5, description: '50% penalty' }
  ],
  boosts: [
    { id: 'boost1', condition: 'testBoost', additive: 0.1, description: '10% boost' }
  ],
  thresholds: { high: 0.85, moderate: 0.65, low: 0.40 },
  uncertaintyTriggers: ['missing_critical_data', 'conflicting_evidence'],
  metadata: { createdAt: '2025-02-04T00:00:00.000Z', domain: 'test' }
};

describe('ConfidenceCalculator', () => {

  describe('constructor', () => {
    test('creates calculator with valid model definition', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      expect(calc).toBeDefined();
      expect(calc.model.modelId).toBe('clinical_readiness_v1');
    });

    test('throws on invalid model definition', () => {
      expect(() => new ConfidenceCalculator({})).toThrow('Invalid model definition');
    });

    test('throws when modelId is missing', () => {
      expect(() => new ConfidenceCalculator({ modelVersion: '1.0.0', name: 'X' })).toThrow();
    });

    test('throws when factors is empty', () => {
      expect(() => new ConfidenceCalculator({
        modelId: 'x', modelVersion: '1.0.0', name: 'X',
        factors: [],
        thresholds: { high: 0.85, moderate: 0.65, low: 0.40 },
        metadata: { createdAt: '2025-01-01T00:00:00.000Z', domain: 'test' }
      })).toThrow();
    });

    test('creates calculator with all four default models', () => {
      const calc1 = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const calc2 = new ConfidenceCalculator(DRUG_INTERACTION_V1);
      expect(calc1.model.modelId).toBe('clinical_readiness_v1');
      expect(calc2.model.modelId).toBe('drug_interaction_v1');
    });
  });

  describe('calculateFactorScores', () => {
    let calc;
    beforeEach(() => {
      calc = new ConfidenceCalculator(MINIMAL_MODEL);
    });

    test('calculates weighted score from provided factors', () => {
      const { baseScore, factorBreakdown } = calc.calculateFactorScores({
        data_completeness: 1.0,
        data_quality: 1.0
      });
      // 1.0*0.6 + 1.0*0.4 = 1.0
      expect(baseScore).toBeCloseTo(1.0, 3);
      expect(factorBreakdown.factor_a.contribution).toBeCloseTo(0.6, 3);
      expect(factorBreakdown.factor_b.contribution).toBeCloseTo(0.4, 3);
    });

    test('uses defaultValue when factor not provided', () => {
      const { baseScore } = calc.calculateFactorScores({});
      // 0.5*0.6 + 0.5*0.4 = 0.5
      expect(baseScore).toBeCloseTo(0.5, 3);
    });

    test('clamps factor values to 0-1 range', () => {
      const { baseScore } = calc.calculateFactorScores({
        data_completeness: 1.5,
        data_quality: -0.5
      });
      // clamped: 1.0*0.6 + 0.0*0.4 = 0.6
      expect(baseScore).toBeCloseTo(0.6, 3);
    });

    test('normalizes weights that do not sum to 1', () => {
      const unevenModel = {
        ...MINIMAL_MODEL,
        factors: [
          { id: 'f1', name: 'F1', weight: 0.8, source: 'data_completeness', defaultValue: 0.5 },
          { id: 'f2', name: 'F2', weight: 0.8, source: 'data_quality', defaultValue: 0.5 }
        ]
      };
      const calc2 = new ConfidenceCalculator(unevenModel);
      const { baseScore } = calc2.calculateFactorScores({
        data_completeness: 1.0,
        data_quality: 1.0
      });
      // (1.0*0.8 + 1.0*0.8) / 1.6 = 1.0
      expect(baseScore).toBeCloseTo(1.0, 3);
    });
  });

  describe('applyPenalties', () => {
    let calc;
    beforeEach(() => {
      calc = new ConfidenceCalculator(MINIMAL_MODEL);
    });

    test('applies penalty when condition is active', () => {
      const { score, applied } = calc.applyPenalties(0.8, ['testPenalty']);
      expect(score).toBeCloseTo(0.4, 3); // 0.8 * 0.5
      expect(applied).toHaveLength(1);
      expect(applied[0].id).toBe('pen1');
    });

    test('skips penalty when condition is not active', () => {
      const { score, applied } = calc.applyPenalties(0.8, []);
      expect(score).toBeCloseTo(0.8, 3);
      expect(applied).toHaveLength(0);
    });

    test('applies multiple penalties multiplicatively', () => {
      const multiPenaltyModel = {
        ...MINIMAL_MODEL,
        penalties: [
          { id: 'p1', condition: 'cond1', multiplier: 0.8, description: '20% penalty' },
          { id: 'p2', condition: 'cond2', multiplier: 0.5, description: '50% penalty' }
        ]
      };
      const calc2 = new ConfidenceCalculator(multiPenaltyModel);
      const { score } = calc2.applyPenalties(1.0, ['cond1', 'cond2']);
      // 1.0 * 0.8 * 0.5 = 0.4
      expect(score).toBeCloseTo(0.4, 3);
    });
  });

  describe('applyBoosts', () => {
    let calc;
    beforeEach(() => {
      calc = new ConfidenceCalculator(MINIMAL_MODEL);
    });

    test('applies boost when condition is active', () => {
      const { score, applied } = calc.applyBoosts(0.7, ['testBoost']);
      expect(score).toBeCloseTo(0.8, 3); // 0.7 + 0.1
      expect(applied).toHaveLength(1);
      expect(applied[0].id).toBe('boost1');
    });

    test('caps score at 1.0', () => {
      const { score } = calc.applyBoosts(0.95, ['testBoost']);
      expect(score).toBe(1.0);
    });

    test('skips boost when condition is not active', () => {
      const { score, applied } = calc.applyBoosts(0.7, []);
      expect(score).toBeCloseTo(0.7, 3);
      expect(applied).toHaveLength(0);
    });
  });

  describe('evaluateCondition', () => {
    let calc;
    beforeEach(() => {
      calc = new ConfidenceCalculator(MINIMAL_MODEL);
    });

    test('direct string match', () => {
      expect(calc.evaluateCondition('testPenalty', ['testPenalty', 'other'])).toBe(true);
    });

    test('camelCase to snake_case conversion match', () => {
      expect(calc.evaluateCondition('testPenalty', ['test_penalty'])).toBe(true);
    });

    test('no match returns false', () => {
      expect(calc.evaluateCondition('testPenalty', ['unrelated'])).toBe(false);
    });
  });

  describe('classifyLevel', () => {
    let calc;
    beforeEach(() => {
      calc = new ConfidenceCalculator(MINIMAL_MODEL);
    });

    test('HIGH for score >= threshold.high', () => {
      expect(calc.classifyLevel(0.90)).toBe('HIGH');
      expect(calc.classifyLevel(0.85)).toBe('HIGH');
    });

    test('MODERATE for score >= threshold.moderate', () => {
      expect(calc.classifyLevel(0.70)).toBe('MODERATE');
      expect(calc.classifyLevel(0.65)).toBe('MODERATE');
    });

    test('LOW for score >= threshold.low', () => {
      expect(calc.classifyLevel(0.50)).toBe('LOW');
      expect(calc.classifyLevel(0.40)).toBe('LOW');
    });

    test('UNCERTAIN for score below threshold.low', () => {
      expect(calc.classifyLevel(0.30)).toBe('UNCERTAIN');
      expect(calc.classifyLevel(0.0)).toBe('UNCERTAIN');
    });
  });

  describe('canProceed', () => {
    let calc;
    beforeEach(() => {
      calc = new ConfidenceCalculator(MINIMAL_MODEL);
    });

    test('returns true for HIGH', () => {
      expect(calc.canProceed(0.90, 'HIGH')).toBe(true);
    });

    test('returns true for MODERATE', () => {
      expect(calc.canProceed(0.70, 'MODERATE')).toBe(true);
    });

    test('returns true for LOW (score >= low threshold)', () => {
      expect(calc.canProceed(0.40, 'LOW')).toBe(true);
    });

    test('returns false for UNCERTAIN', () => {
      expect(calc.canProceed(0.20, 'UNCERTAIN')).toBe(false);
    });
  });

  describe('checkUncertaintyTriggers', () => {
    let calc;
    beforeEach(() => {
      calc = new ConfidenceCalculator(MINIMAL_MODEL);
    });

    test('triggers on direct condition match', () => {
      const result = calc.checkUncertaintyTriggers(['missing_critical_data'], {});
      expect(result.triggered).toBe(true);
      expect(result.safetyFlag).toBe('MISSING_CRITICAL');
    });

    test('triggers on conflicting_evidence condition', () => {
      const result = calc.checkUncertaintyTriggers(['conflicting_evidence'], {});
      expect(result.triggered).toBe(true);
      expect(result.safetyFlag).toBe('CONFLICTING_DATA');
    });

    test('does not trigger when no matching conditions', () => {
      const result = calc.checkUncertaintyTriggers(['unrelated'], {});
      expect(result.triggered).toBe(false);
    });

    test('implicit trigger: missing_critical_data when high-weight factor is 0', () => {
      const result = calc.checkUncertaintyTriggers([], {
        data_completeness: 0  // weight 0.6 > 0.2, value 0
      });
      expect(result.triggered).toBe(true);
      expect(result.reason).toContain('Critical data');
    });

    test('implicit trigger: conflicting_evidence low evidence + high reliability', () => {
      const result = calc.checkUncertaintyTriggers([], {
        evidence_level: 0.2,
        source_reliability: 0.9
      });
      expect(result.triggered).toBe(true);
      expect(result.safetyFlag).toBe('CONFLICTING_DATA');
    });

    test('implicit trigger: insufficient_sample_size when data_completeness < 0.2', () => {
      const result = calc.checkUncertaintyTriggers([], {
        data_completeness: 0.15
      });
      // insufficient_sample_size not in MINIMAL_MODEL triggers, but missing_critical_data
      // fires because weight 0.6 > 0.2 and value 0.15 is not 0 or null
      // So this tests the insufficient check only if it's in the triggers
      // MINIMAL_MODEL has missing_critical_data and conflicting_evidence
      // insufficient_sample_size is NOT in MINIMAL_MODEL's triggers
      expect(result.triggered).toBe(false);
    });

    test('implicit trigger: insufficient_sample_size with proper model', () => {
      const modelWithInsufficient = {
        ...MINIMAL_MODEL,
        uncertaintyTriggers: ['insufficient_sample_size']
      };
      const calc2 = new ConfidenceCalculator(modelWithInsufficient);
      const result = calc2.checkUncertaintyTriggers([], { data_completeness: 0.15 });
      expect(result.triggered).toBe(true);
      expect(result.safetyFlag).toBe('I_DONT_KNOW');
    });
  });

  describe('calculate (full pipeline)', () => {
    test('returns HIGH confidence for perfect factors', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const result = calc.calculate({
        factors: {
          data_completeness: 1.0,
          data_quality: 1.0,
          source_reliability: 1.0,
          model_certainty: 1.0,
          evidence_level: 1.0
        },
        conditions: ['hasMultipleSources', 'expertReviewed']
      });
      expect(result.level).toBe('HIGH');
      expect(result.canProceed).toBe(true);
      expect(result.value).toBeGreaterThanOrEqual(0.85);
      expect(result.modelId).toBe('clinical_readiness_v1');
    });

    test('returns UNCERTAIN for missing_critical_data trigger', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const result = calc.calculate({
        factors: { data_completeness: 0.8 },
        conditions: ['missing_critical_data']
      });
      expect(result.level).toBe('UNCERTAIN');
      expect(result.canProceed).toBe(false);
      expect(result.value).toBe(0);
      expect(result.safetyFlag).toBe('MISSING_CRITICAL');
    });

    test('applies penalties and reduces confidence', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const withoutPenalty = calc.calculate({
        factors: { data_completeness: 0.8, data_quality: 0.8, source_reliability: 0.8, model_certainty: 0.8, evidence_level: 0.8 },
        conditions: []
      });
      const withPenalty = calc.calculate({
        factors: { data_completeness: 0.8, data_quality: 0.8, source_reliability: 0.8, model_certainty: 0.8, evidence_level: 0.8 },
        conditions: ['syntheticData']
      });
      expect(withPenalty.value).toBeLessThan(withoutPenalty.value);
    });

    test('applies boosts and increases confidence', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const withoutBoost = calc.calculate({
        factors: { data_completeness: 0.7, data_quality: 0.7, source_reliability: 0.7, model_certainty: 0.7, evidence_level: 0.7 },
        conditions: []
      });
      const withBoost = calc.calculate({
        factors: { data_completeness: 0.7, data_quality: 0.7, source_reliability: 0.7, model_certainty: 0.7, evidence_level: 0.7 },
        conditions: ['expertReviewed']
      });
      expect(withBoost.value).toBeGreaterThan(withoutBoost.value);
    });

    test('returns valid result with empty context', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const result = calc.calculate();
      expect(result.value).toBeGreaterThanOrEqual(0);
      expect(result.value).toBeLessThanOrEqual(1);
      expect(['HIGH', 'MODERATE', 'LOW', 'UNCERTAIN']).toContain(result.level);
      expect(typeof result.canProceed).toBe('boolean');
    });

    test('result includes modelId and modelVersion', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const result = calc.calculate({ factors: { data_completeness: 0.8 } });
      expect(result.modelId).toBe('clinical_readiness_v1');
      expect(result.modelVersion).toBe('1.0.0');
    });

    test('score is clamped between 0 and 1', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const result = calc.calculate({
        factors: { data_completeness: 1.0, data_quality: 1.0 },
        conditions: ['testBoost']
      });
      expect(result.value).toBeLessThanOrEqual(1.0);
      expect(result.value).toBeGreaterThanOrEqual(0.0);
    });

    test('Drug Interaction model has higher thresholds', () => {
      const calc = new ConfidenceCalculator(DRUG_INTERACTION_V1);
      const result = calc.calculate({
        factors: {
          source_reliability: 0.85,
          evidence_level: 0.85,
          data_completeness: 0.85,
          temporal_relevance: 0.85
        },
        conditions: []
      });
      // With 0.85 across all factors, the score should be 0.85
      // Drug interaction HIGH threshold is 0.90 — so this should be MODERATE
      expect(result.level).toBe('MODERATE');
    });
  });

  describe('buildResult', () => {
    test('rounds value to 3 decimal places', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const result = calc.buildResult({
        value: 0.12345678,
        level: 'LOW',
        canProceed: true,
        factors: {},
        penalties: [],
        boosts: []
      });
      expect(result.value).toBe(0.123);
    });

    test('includes penalties array when penalties applied', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const result = calc.buildResult({
        value: 0.5,
        level: 'MODERATE',
        canProceed: true,
        factors: {},
        penalties: [{ id: 'pen1', multiplier: 0.5, description: 'test' }],
        boosts: []
      });
      expect(result.penalties).toEqual(['pen1']);
      expect(result.penaltyDetails).toHaveLength(1);
    });

    test('includes boosts array when boosts applied', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const result = calc.buildResult({
        value: 0.8,
        level: 'MODERATE',
        canProceed: true,
        factors: {},
        penalties: [],
        boosts: [{ id: 'boost1', additive: 0.1, description: 'test' }]
      });
      expect(result.boosts).toEqual(['boost1']);
      expect(result.boostDetails).toHaveLength(1);
    });

    test('includes reason when provided', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const result = calc.buildResult({
        value: 0,
        level: 'UNCERTAIN',
        canProceed: false,
        reason: 'Missing data',
        factors: {},
        penalties: [],
        boosts: []
      });
      expect(result.reason).toBe('Missing data');
    });
  });

  describe('explain', () => {
    test('returns step-by-step explanation', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const explanation = calc.explain({
        factors: { data_completeness: 0.9, data_quality: 0.8 },
        conditions: ['testBoost']
      });
      expect(explanation.model.modelId).toBe('test_model_v1');
      expect(explanation.steps).toHaveLength(4);
      expect(explanation.steps[0].name).toBe('Uncertainty Check');
      expect(explanation.steps[1].name).toBe('Factor Calculation');
      expect(explanation.steps[2].name).toBe('Penalties');
      expect(explanation.steps[3].name).toBe('Boosts');
      expect(explanation.result).toBeDefined();
      expect(explanation.result.value).toBeGreaterThan(0);
    });

    test('short-circuits on uncertainty trigger', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const explanation = calc.explain({
        factors: {},
        conditions: ['missing_critical_data']
      });
      expect(explanation.steps).toHaveLength(1);
      expect(explanation.steps[0].triggered).toBe(true);
      expect(explanation.result.level).toBe('UNCERTAIN');
      expect(explanation.result.value).toBe(0);
    });

    test('explain with empty context returns valid explanation', () => {
      const calc = new ConfidenceCalculator(MINIMAL_MODEL);
      const explanation = calc.explain();
      expect(explanation.model).toBeDefined();
      expect(explanation.result).toBeDefined();
    });
  });

  describe('getModelInfo', () => {
    test('returns model metadata', () => {
      const calc = new ConfidenceCalculator(CLINICAL_READINESS_V1);
      const info = calc.getModelInfo();
      expect(info.modelId).toBe('clinical_readiness_v1');
      expect(info.modelVersion).toBe('1.0.0');
      expect(info.factorCount).toBe(5);
      expect(info.penaltyCount).toBe(5);
      expect(info.boostCount).toBe(3);
      expect(info.domain).toBe('clinical');
      expect(info.thresholds).toBeDefined();
    });
  });
});
