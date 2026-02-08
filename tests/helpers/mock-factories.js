// tests/helpers/mock-factories.js
// Reusable mock builders for Healthcare test files

import { jest } from '@jest/globals';

/**
 * Create mock execution signals for ClinicalConfidenceIntegration
 */
export function createMockExecutionSignals(overrides = {}) {
  return {
    dataCompleteness: 0.8,
    dataQuality: 0.7,
    sourceReliability: 0.75,
    modelCertainty: 0.6,
    evidenceLevel: 0.7,
    temporalRelevance: 0.8,
    llmUsed: false,
    llmFailed: false,
    missingCritical: false,
    hasDataConflict: false,
    syntheticData: false,
    multipleSources: false,
    expertReviewed: false,
    cacheHits: 0,
    totalSteps: 3,
    ...overrides
  };
}

/**
 * Create mock execution context for ClinicalConfidenceIntegration
 */
export function createMockExecutionContext(overrides = {}) {
  return {
    intentId: 'treatment-recommendation',
    intentMode: 'CLINICAL_DECISION_SUPPORT',
    recipeId: 'treatment-lookup',
    decisionType: 'treatment',
    ...overrides
  };
}

/**
 * Create mock NLS parse context for NLSConfidenceIntegration
 */
export function createMockParseContext(overrides = {}) {
  return {
    matchType: 'pattern',
    rawConfidence: 0.85,
    queryLength: 25,
    hasAmbiguity: false,
    closeMatchCount: 0,
    entityCompleteness: 1.0,
    missingRequired: false,
    intentId: 'patient-summary',
    llmFailed: false,
    ...overrides
  };
}

/**
 * Create mock cache object
 */
export function createMockCache() {
  const store = new Map();
  return {
    get: jest.fn(async (key) => store.get(key) ?? null),
    set: jest.fn(async (key, value) => { store.set(key, value); }),
    getJSON: jest.fn(async (key) => {
      const val = store.get(key);
      if (val === undefined) return null;
      return typeof val === 'string' ? JSON.parse(val) : val;
    }),
    setJSON: jest.fn(async (key, value) => { store.set(key, value); }),
    del: jest.fn(async (key) => { store.delete(key); }),
    _store: store
  };
}

/**
 * Create mock orchestrator
 */
export function createMockOrchestrator(options = {}) {
  const cache = options.cache || createMockCache();
  return {
    processRequest: jest.fn(async () => ({
      result: { response: '{}' }
    })),
    llmService: options.llmService !== undefined ? options.llmService : {
      invoke: jest.fn(async () => ({})),
      generateText: jest.fn(async () => 'Mock LLM response')
    },
    cache,
    getService: jest.fn(() => null)
  };
}
