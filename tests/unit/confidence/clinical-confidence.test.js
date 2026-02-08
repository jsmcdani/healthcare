import { jest } from '@jest/globals';
import {
  createMockExecutionSignals,
  createMockExecutionContext
} from '../../helpers/mock-factories.js';

// ClinicalConfidenceIntegration uses module-level state (modelCache, registryIndex).
// We import fresh and let it initialize from the real DEFAULT_MODELS / DEFAULT_REGISTRY_INDEX.
// This tests the real integration with ConfidenceCalculator and default-models.
import {
  initializeClinicalConfidence,
  calculateClinicalConfidence,
  buildSignalsFromRecipeResult,
  selectModelForContext,
  getClinicalConfidenceInfo
} from '../../../src/healthcare/confidence/ClinicalConfidenceIntegration.js';

describe('ClinicalConfidenceIntegration', () => {

  describe('initializeClinicalConfidence', () => {
    test('initializes without error', () => {
      expect(() => initializeClinicalConfidence()).not.toThrow();
    });

    test('getClinicalConfidenceInfo returns valid info after init', () => {
      initializeClinicalConfidence();
      const info = getClinicalConfidenceInfo();
      expect(info.registryId).toBe('healthcare-confidence-registry');
      expect(info.registryVersion).toBe('1.0.0');
      expect(info.loadedModels.length).toBeGreaterThanOrEqual(4);
      expect(info.defaultModel).toBe('clinical_readiness_v1@1.0.0');
    });
  });

  describe('selectModelForContext', () => {
    beforeAll(() => {
      initializeClinicalConfidence();
    });

    test('selects drug_interaction model for drug-interaction-check intent', () => {
      const modelKey = selectModelForContext({
        intentId: 'drug-interaction-check',
        intentMode: 'PHARMACY',
        decisionType: 'medication'
      });
      expect(modelKey.modelId).toBe('drug_interaction_v1');
    });

    test('selects care_gap model for care-gaps intent', () => {
      const modelKey = selectModelForContext({
        intentId: 'care-gaps',
        intentMode: 'QUALITY',
        decisionType: 'quality'
      });
      expect(modelKey.modelId).toBe('care_gap_v1');
    });

    test('selects diagnostic_assessment model for diagnosis-support intent', () => {
      const modelKey = selectModelForContext({
        intentId: 'diagnosis-support',
        intentMode: 'CLINICAL_DECISION_SUPPORT',
        decisionType: 'diagnostic'
      });
      expect(modelKey.modelId).toBe('diagnostic_assessment_v1');
    });

    test('falls back to clinical_readiness for unknown intent', () => {
      const modelKey = selectModelForContext({
        intentId: 'unknown-intent',
        intentMode: 'CLINICAL_DECISION_SUPPORT',
        decisionType: 'treatment'
      });
      // intentId doesn't match any mapping, falls back based on intentMode or decisionType
      expect(modelKey.modelId).toBe('clinical_readiness_v1');
    });

    test('selects by intentMode when no intentId match', () => {
      const modelKey = selectModelForContext({
        intentId: 'custom-pharmacy-check',
        intentMode: 'PHARMACY'
      });
      // intentId 'custom-pharmacy-check' doesn't match any mapping
      // intentMode 'PHARMACY' maps to drug_interaction_v1
      // But the algorithm filters out mappings with non-matching intentId first,
      // so it falls through to intentMode-only mappings
      expect(['drug_interaction_v1', 'clinical_readiness_v1']).toContain(modelKey.modelId);
    });

    test('selects by decisionType when no other match', () => {
      const modelKey = selectModelForContext({
        decisionType: 'medication'
      });
      expect(modelKey.modelId).toBe('drug_interaction_v1');
    });
  });

  describe('calculateClinicalConfidence', () => {
    beforeAll(() => {
      initializeClinicalConfidence();
    });

    test('returns high confidence for strong signals', () => {
      const context = createMockExecutionContext({
        intentId: 'treatment-recommendation',
        intentMode: 'CLINICAL_DECISION_SUPPORT',
        decisionType: 'treatment'
      });
      const signals = createMockExecutionSignals({
        dataCompleteness: 0.95,
        dataQuality: 0.9,
        sourceReliability: 0.85,
        modelCertainty: 0.8,
        evidenceLevel: 0.9,
        temporalRelevance: 0.85,
        multipleSources: true,
        expertReviewed: true
      });

      const result = calculateClinicalConfidence(context, signals);
      expect(result.value).toBeGreaterThan(0.7);
      expect(['HIGH', 'MODERATE']).toContain(result.level);
      expect(result.canProceed).toBe(true);
      expect(result.executionContext.intentId).toBe('treatment-recommendation');
    });

    test('returns uncertain when missingCritical is true', () => {
      const context = createMockExecutionContext();
      const signals = createMockExecutionSignals({
        missingCritical: true
      });

      const result = calculateClinicalConfidence(context, signals);
      // missingCritical adds 'missing_critical_data' to conditions,
      // which is an uncertainty trigger
      expect(result.level).toBe('UNCERTAIN');
      expect(result.canProceed).toBe(false);
      expect(result.value).toBe(0);
    });

    test('applies syntheticData penalty', () => {
      const context = createMockExecutionContext();
      const signals = createMockExecutionSignals();

      const withoutSynthetic = calculateClinicalConfidence(context, signals);

      const syntheticSignals = createMockExecutionSignals({ syntheticData: true });
      const withSynthetic = calculateClinicalConfidence(context, syntheticSignals);

      expect(withSynthetic.value).toBeLessThan(withoutSynthetic.value);
    });

    test('applies llmFallback penalty when llm failed', () => {
      const context = createMockExecutionContext();
      const baseline = calculateClinicalConfidence(
        context,
        createMockExecutionSignals()
      );
      const withLlmFailure = calculateClinicalConfidence(
        context,
        createMockExecutionSignals({ llmFailed: true })
      );

      expect(withLlmFailure.value).toBeLessThan(baseline.value);
    });

    test('applies expertReviewed boost', () => {
      const context = createMockExecutionContext();
      const baseline = calculateClinicalConfidence(
        context,
        createMockExecutionSignals()
      );
      const withExpert = calculateClinicalConfidence(
        context,
        createMockExecutionSignals({ expertReviewed: true })
      );

      expect(withExpert.value).toBeGreaterThan(baseline.value);
    });

    test('applies multipleSources boost', () => {
      const context = createMockExecutionContext();
      const baseline = calculateClinicalConfidence(
        context,
        createMockExecutionSignals()
      );
      const withMultiple = calculateClinicalConfidence(
        context,
        createMockExecutionSignals({ multipleSources: true })
      );

      expect(withMultiple.value).toBeGreaterThan(baseline.value);
    });

    test('includes execution context in result', () => {
      const context = createMockExecutionContext({ intentId: 'test-intent', recipeId: 'test-recipe' });
      const signals = createMockExecutionSignals({ llmUsed: true });

      const result = calculateClinicalConfidence(context, signals);
      expect(result.executionContext).toBeDefined();
      expect(result.executionContext.intentId).toBe('test-intent');
      expect(result.executionContext.recipeId).toBe('test-recipe');
      expect(result.executionContext.llmUsed).toBe(true);
    });

    test('uses default values for missing signal fields', () => {
      const context = createMockExecutionContext();
      const result = calculateClinicalConfidence(context, {});

      expect(result.value).toBeGreaterThanOrEqual(0);
      expect(result.value).toBeLessThanOrEqual(1);
      expect(result.modelId).toBeDefined();
    });

    test('result has model pinned in result', () => {
      const context = createMockExecutionContext();
      const signals = createMockExecutionSignals();
      const result = calculateClinicalConfidence(context, signals);

      expect(result.modelId).toBeDefined();
      expect(result.modelVersion).toBe('1.0.0');
    });
  });

  describe('buildSignalsFromRecipeResult', () => {
    test('extracts data completeness from recipe data', () => {
      const recipeResult = {
        data: { field1: 'value', field2: 'value', field3: null },
        meta: { cacheHits: 1, totalSteps: 3 }
      };
      const signals = buildSignalsFromRecipeResult(recipeResult);

      expect(signals.dataCompleteness).toBeGreaterThan(0);
      expect(signals.dataCompleteness).toBeLessThanOrEqual(1);
    });

    test('returns 0.5 when data is empty', () => {
      const recipeResult = { data: {}, meta: {} };
      const signals = buildSignalsFromRecipeResult(recipeResult);
      expect(signals.dataCompleteness).toBe(0.5);
    });

    test('detects LLM usage from timing metadata', () => {
      const recipeResult = {
        data: {},
        meta: {
          timing: [{ stepId: 'llm-summary', duration: 500 }],
          totalSteps: 2
        }
      };
      const signals = buildSignalsFromRecipeResult(recipeResult);
      expect(signals.llmUsed).toBe(true);
    });

    test('detects no LLM usage when no llm step', () => {
      const recipeResult = {
        data: {},
        meta: {
          timing: [{ stepId: 'db-query', duration: 50 }],
          totalSteps: 1
        }
      };
      const signals = buildSignalsFromRecipeResult(recipeResult);
      expect(signals.llmUsed).toBe(false);
    });

    test('detects llmFailed from meta', () => {
      const recipeResult = {
        data: {},
        meta: { llmFailed: true, totalSteps: 2 }
      };
      const signals = buildSignalsFromRecipeResult(recipeResult);
      expect(signals.llmFailed).toBe(true);
    });

    test('applies additional context overrides', () => {
      const recipeResult = { data: {}, meta: {} };
      const signals = buildSignalsFromRecipeResult(recipeResult, {
        sourceReliability: 0.95,
        multipleSources: true,
        expertReviewed: true
      });
      expect(signals.sourceReliability).toBe(0.95);
      expect(signals.multipleSources).toBe(true);
      expect(signals.expertReviewed).toBe(true);
    });

    test('calculates data quality from cache ratio', () => {
      const highCache = buildSignalsFromRecipeResult(
        { data: {}, meta: { cacheHits: 4, totalSteps: 5 } }
      );
      const lowCache = buildSignalsFromRecipeResult(
        { data: {}, meta: { cacheHits: 0, totalSteps: 5 } }
      );
      // High cache ratio > 0.5 → dataQuality 0.7, low → 0.5
      expect(highCache.dataQuality).toBe(0.7);
      expect(lowCache.dataQuality).toBe(0.5);
    });

    test('handles missing meta gracefully', () => {
      const signals = buildSignalsFromRecipeResult({});
      expect(signals.llmUsed).toBe(false);
      expect(signals.llmFailed).toBe(false);
      expect(signals.cacheHits).toBe(0);
      expect(signals.totalSteps).toBe(0);
    });
  });
});
