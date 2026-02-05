/**
 * ClinicalConfidenceIntegration - Central Confidence Computation for Clinical Responses
 *
 * This is the MAIN confidence system for healthcare - computes confidence for
 * clinical decisions/insights/recommendations returned to patients and providers.
 *
 * Per the Metalligent architecture (connfidenc.xml):
 * - Confidence is computed centrally by the control plane
 * - SAME model applies whether LLM or deterministic rules were used
 * - Confidence is NEVER self-reported by the LLM
 * - Model is selected by intent/mode, pinned by version
 *
 * "Confidence is computed centrally (registry-driven) and pinned by version
 *  across deterministic execution and AI expert consultation —
 *  never self-reported by the LLM."
 */

import { ConfidenceCalculator } from './core/ConfidenceCalculator.js';
import { selectConfidenceModelKey } from './core/selectConfidenceModel.js';
import { DEFAULT_MODELS, DEFAULT_REGISTRY_INDEX } from './config/default-models.js';
import { Logger } from '../../utils/logger.js';

const logger = new Logger('ClinicalConfidenceIntegration');

// Loaded models cache
const modelCache = new Map();
let registryIndex = null;

/**
 * Initialize the clinical confidence system
 */
export function initializeClinicalConfidence() {
  if (registryIndex) return;

  try {
    // Load registry index
    registryIndex = DEFAULT_REGISTRY_INDEX;

    // Pre-load all default models
    for (const model of DEFAULT_MODELS) {
      modelCache.set(`${model.modelId}@${model.modelVersion}`, new ConfidenceCalculator(model));
    }

    logger.info('Clinical confidence system initialized', {
      registryId: registryIndex.registryId,
      registryVersion: registryIndex.registryVersion,
      modelsLoaded: modelCache.size
    });
  } catch (error) {
    logger.error('Failed to initialize clinical confidence', { error: error.message });
  }
}

/**
 * Get calculator for a specific model
 */
function getCalculator(modelId, modelVersion) {
  const key = `${modelId}@${modelVersion}`;
  if (!modelCache.has(key)) {
    // Try to find model in defaults
    const model = DEFAULT_MODELS.find(m => m.modelId === modelId && m.modelVersion === modelVersion);
    if (model) {
      modelCache.set(key, new ConfidenceCalculator(model));
    } else {
      logger.warn('Model not found, using default', { modelId, modelVersion });
      return modelCache.get(`${registryIndex.defaultModelId}@${registryIndex.defaultModelVersion}`);
    }
  }
  return modelCache.get(key);
}

/**
 * Select the appropriate confidence model for the given context
 *
 * @param {Object} context - Execution context
 * @param {string} context.intentId - Intent being executed
 * @param {string} context.intentMode - Clinical mode (CLINICAL_DECISION_SUPPORT, PHARMACY, etc.)
 * @param {string} context.decisionType - Type of decision (diagnostic, treatment, medication, quality)
 * @returns {Object} Selected model info { modelId, modelVersion }
 */
export function selectModelForContext(context) {
  if (!registryIndex) {
    initializeClinicalConfidence();
  }

  const modelKey = selectConfidenceModelKey(registryIndex, context);

  logger.debug('Model selected for context', {
    context,
    selectedModel: modelKey
  });

  return modelKey;
}

/**
 * Calculate clinical confidence for a recipe execution result
 *
 * This is the CENTRAL confidence computation - same model applies
 * regardless of whether LLM or deterministic execution was used.
 *
 * @param {Object} executionContext - Context from recipe/insight execution
 * @param {string} executionContext.intentId - Intent that was executed
 * @param {string} executionContext.intentMode - Clinical mode
 * @param {string} executionContext.recipeId - Recipe that was executed
 * @param {Object} executionSignals - Signals from the execution
 * @param {number} executionSignals.dataCompleteness - 0-1 ratio of available data
 * @param {number} executionSignals.dataQuality - 0-1 quality score
 * @param {number} executionSignals.sourceReliability - 0-1 source reliability
 * @param {number} executionSignals.evidenceLevel - 0-1 evidence strength
 * @param {boolean} executionSignals.llmUsed - Whether LLM was used
 * @param {boolean} executionSignals.llmFailed - Whether LLM failed (fallback used)
 * @param {boolean} executionSignals.hasDataConflict - Conflicting data detected
 * @param {boolean} executionSignals.missingCritical - Critical data missing
 * @param {boolean} executionSignals.syntheticData - Demo/synthetic data used
 * @param {boolean} executionSignals.multipleSources - Multiple sources corroborated
 * @param {boolean} executionSignals.expertReviewed - Expert reviewed result
 * @param {number} executionSignals.cacheHits - Number of cache hits
 * @param {number} executionSignals.totalSteps - Total recipe steps
 * @returns {Object} Confidence result with value, level, canProceed, audit trail
 */
export function calculateClinicalConfidence(executionContext, executionSignals) {
  if (!registryIndex) {
    initializeClinicalConfidence();
  }

  // Select model based on intent/mode (NOT based on whether LLM was used)
  const modelKey = selectModelForContext(executionContext);
  const calculator = getCalculator(modelKey.modelId, modelKey.modelVersion);

  if (!calculator) {
    logger.error('No calculator available for clinical confidence');
    return {
      value: 0,
      level: 'UNCERTAIN',
      canProceed: false,
      safetyFlag: 'SYSTEM_ERROR',
      modelId: 'none',
      modelVersion: 'none',
      reason: 'Confidence calculator not available'
    };
  }

  // Build factors from execution signals
  const factors = {
    data_completeness: executionSignals.dataCompleteness ?? 0.5,
    data_quality: executionSignals.dataQuality ?? 0.5,
    source_reliability: executionSignals.sourceReliability ?? 0.6,
    model_certainty: executionSignals.modelCertainty ?? 0.5,
    evidence_level: executionSignals.evidenceLevel ?? 0.5,
    temporal_relevance: executionSignals.temporalRelevance ?? 0.7
  };

  // Build conditions for penalties/boosts
  const conditions = [];

  // Penalties
  if (executionSignals.missingCritical) {
    conditions.push('missingCriticalData');
  }
  if (executionSignals.hasDataConflict) {
    conditions.push('hasDataConflict');
  }
  if (executionSignals.guidelinesOutdated) {
    conditions.push('guidelinesOutdated');
  }
  if (executionSignals.llmFailed) {
    conditions.push('llmFallback');
  }
  if (executionSignals.syntheticData) {
    conditions.push('syntheticData');
  }
  // Drug interaction specific
  if (executionSignals.unknownDrugCombination) {
    conditions.push('unknownDrugCombination');
  }
  if (executionSignals.missingAllergies) {
    conditions.push('missingPatientAllergies');
  }
  if (executionSignals.incompleteMedications) {
    conditions.push('incompleteMedicationList');
  }
  // Diagnostic specific
  if (executionSignals.missingHistory) {
    conditions.push('missingPatientHistory');
  }
  if (executionSignals.incompleteWorkup) {
    conditions.push('incompleteDiagnosticWorkup');
  }

  // Boosts
  if (executionSignals.multipleSources) {
    conditions.push('hasMultipleSources');
  }
  if (executionSignals.recentlyValidated) {
    conditions.push('recentlyValidated');
  }
  if (executionSignals.expertReviewed) {
    conditions.push('expertReviewed');
  }
  // Drug interaction specific
  if (executionSignals.pharmacistReviewed) {
    conditions.push('pharmacistReviewed');
  }
  if (executionSignals.multipleDatabases) {
    conditions.push('multipleDatabasesChecked');
  }
  // Diagnostic specific
  if (executionSignals.confirmatoryTest) {
    conditions.push('confirmatoryTestPositive');
  }
  if (executionSignals.specialistConsulted) {
    conditions.push('specialistConsulted');
  }
  // Care gap specific
  if (executionSignals.ehrIntegrated) {
    conditions.push('ehrIntegrated');
  }
  if (executionSignals.recentVisit) {
    conditions.push('recentPatientVisit');
  }

  // Uncertainty triggers
  if (executionSignals.missingCritical) {
    conditions.push('missing_critical_data');
  }
  if (executionSignals.conflictingEvidence) {
    conditions.push('conflicting_evidence');
  }
  if (executionSignals.insufficientData) {
    conditions.push('insufficient_sample_size');
  }
  if (executionSignals.outdatedData) {
    conditions.push('outdated_reference_data');
  }

  // Calculate confidence
  const result = calculator.calculate({ factors, conditions });

  logger.info('Clinical confidence calculated', {
    intentId: executionContext.intentId,
    recipeId: executionContext.recipeId,
    modelId: result.modelId,
    confidence: result.value,
    level: result.level,
    canProceed: result.canProceed,
    llmUsed: executionSignals.llmUsed,
    safetyFlag: result.safetyFlag
  });

  return {
    ...result,
    // Include execution context for audit
    executionContext: {
      intentId: executionContext.intentId,
      recipeId: executionContext.recipeId,
      llmUsed: executionSignals.llmUsed || false
    }
  };
}

/**
 * Build execution signals from recipe execution metadata
 *
 * Helper to extract signals from a recipe execution result
 *
 * @param {Object} recipeResult - Result from RecipeEngine.execute()
 * @param {Object} additionalContext - Additional context (patient data, etc.)
 * @returns {Object} Execution signals for confidence calculation
 */
export function buildSignalsFromRecipeResult(recipeResult, additionalContext = {}) {
  const meta = recipeResult.meta || {};
  const data = recipeResult.data || {};

  // Calculate data completeness based on null/undefined fields
  let totalFields = 0;
  let populatedFields = 0;
  function countFields(obj, depth = 0) {
    if (depth > 3 || !obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      totalFields++;
      if (obj[key] !== null && obj[key] !== undefined) {
        populatedFields++;
      }
      if (typeof obj[key] === 'object') {
        countFields(obj[key], depth + 1);
      }
    }
  }
  countFields(data);

  const dataCompleteness = totalFields > 0 ? populatedFields / totalFields : 0.5;

  // Determine if LLM was used from timing/step metadata
  const llmUsed = meta.timing?.some(t => t.stepId?.includes('llm')) || false;
  const llmFailed = meta.llmFailed || false;

  // Cache hit ratio as quality indicator
  const cacheRatio = meta.totalSteps > 0 ? meta.cacheHits / meta.totalSteps : 0;

  return {
    dataCompleteness,
    dataQuality: additionalContext.dataQuality ?? (cacheRatio > 0.5 ? 0.7 : 0.5),
    sourceReliability: additionalContext.sourceReliability ?? 0.6,
    evidenceLevel: additionalContext.evidenceLevel ?? 0.5,
    modelCertainty: additionalContext.modelCertainty ?? 0.5,
    temporalRelevance: additionalContext.temporalRelevance ?? 0.7,

    llmUsed,
    llmFailed,

    missingCritical: additionalContext.missingCritical ?? false,
    hasDataConflict: additionalContext.hasDataConflict ?? false,
    syntheticData: additionalContext.syntheticData ?? false,
    multipleSources: additionalContext.multipleSources ?? false,
    expertReviewed: additionalContext.expertReviewed ?? false,

    cacheHits: meta.cacheHits || 0,
    totalSteps: meta.totalSteps || 0,

    ...additionalContext
  };
}

/**
 * Get info about the loaded models
 */
export function getClinicalConfidenceInfo() {
  if (!registryIndex) {
    initializeClinicalConfidence();
  }

  return {
    registryId: registryIndex?.registryId,
    registryVersion: registryIndex?.registryVersion,
    defaultModel: `${registryIndex?.defaultModelId}@${registryIndex?.defaultModelVersion}`,
    loadedModels: Array.from(modelCache.keys()),
    mappingCount: registryIndex?.mappings?.length || 0
  };
}

export default {
  initializeClinicalConfidence,
  calculateClinicalConfidence,
  buildSignalsFromRecipeResult,
  selectModelForContext,
  getClinicalConfidenceInfo
};
