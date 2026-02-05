/**
 * NLSConfidenceIntegration - Control Plane Confidence Computation
 *
 * Central confidence computation for NLS, following the Metalligent architecture:
 * - Confidence is ALWAYS computed by the platform (control plane)
 * - Confidence is NEVER self-reported by the LLM
 * - Uses Confidence Registry for model selection
 * - Same model applies whether LLM or rules were used for parsing
 *
 * Per the spec (connfidenc.xml):
 * "Confidence is computed centrally (registry-driven) and pinned by version
 *  across deterministic execution and AI expert consultation —
 *  never self-reported by the LLM."
 */

import { ConfidenceCalculator } from '../confidence/core/ConfidenceCalculator.js';
import { Logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = new Logger('NLSConfidenceIntegration');

// Parser tier reliability scores - control plane determines reliability, not the parser
const TIER_RELIABILITY = {
  'trigger': 1.0,      // Tier 1: Exact slash command match (highest reliability)
  'pattern': 0.8,      // Tier 2: Regex pattern match
  'synonym': 0.6,      // Tier 2b: Synonym match
  'llm': 0.65,         // Tier 3: LLM semantic classification
  'confirmed': 1.0,    // User confirmed intent (highest reliability)
  'none': 0.0          // No match found
};

let calculator = null;
let modelDefinition = null;

/**
 * Initialize the NLS confidence calculator
 */
export function initializeNLSConfidence() {
  if (calculator) return calculator;

  try {
    // Load NLS confidence model
    const modelPath = path.resolve(__dirname, '../packs/confidence/nls-intent-parsing.confidence.json');
    const modelJson = fs.readFileSync(modelPath, 'utf-8');
    modelDefinition = JSON.parse(modelJson);

    calculator = new ConfidenceCalculator(modelDefinition);
    logger.info('NLS confidence calculator initialized', {
      modelId: modelDefinition.modelId,
      modelVersion: modelDefinition.modelVersion
    });

    return calculator;
  } catch (error) {
    logger.error('Failed to initialize NLS confidence calculator', { error: error.message });
    return null;
  }
}

/**
 * Calculate calibrated confidence for a parse result
 *
 * @param {Object} parseContext - Context from the parser
 * @param {string} parseContext.matchType - 'trigger', 'pattern', 'synonym', or 'llm'
 * @param {number} parseContext.rawConfidence - Raw parser confidence (pattern weight or LLM output)
 * @param {number} parseContext.entityCompleteness - 0-1 ratio of extracted vs required entities
 * @param {number} parseContext.queryLength - Length of user query
 * @param {boolean} parseContext.hasAmbiguity - Whether close matches exist
 * @param {boolean} parseContext.missingRequired - Whether required params are missing
 * @param {number} parseContext.closeMatchCount - Number of close competing matches
 * @returns {Object} Calibrated confidence result with value, level, canProceed
 */
export function calculateNLSConfidence(parseContext) {
  if (!calculator) {
    initializeNLSConfidence();
  }

  if (!calculator) {
    // Fallback if model couldn't load - return simple confidence
    return {
      value: parseContext.rawConfidence || 0.5,
      level: parseContext.rawConfidence >= 0.85 ? 'HIGH' :
             parseContext.rawConfidence >= 0.65 ? 'MODERATE' :
             parseContext.rawConfidence >= 0.40 ? 'LOW' : 'UNCERTAIN',
      canProceed: parseContext.rawConfidence >= 0.40,
      modelId: 'fallback',
      safetyFlag: null
    };
  }

  // Build factors from parse context
  const factors = {
    model_certainty: parseContext.rawConfidence || 0.5,
    source_reliability: TIER_RELIABILITY[parseContext.matchType] || 0.5,
    data_completeness: parseContext.entityCompleteness ?? 1.0,
    data_quality: calculateQueryClarity(parseContext.queryLength)
  };

  // Build conditions from parse context
  const conditions = [];

  // Penalties
  if (parseContext.hasAmbiguity || (parseContext.closeMatchCount && parseContext.closeMatchCount > 0)) {
    conditions.push('ambiguousIntent');
  }
  if (parseContext.missingRequired) {
    conditions.push('missingRequiredParams');
  }
  if (parseContext.matchType === 'llm') {
    conditions.push('llmFallback');
  }
  if (parseContext.rawConfidence < 0.7) {
    conditions.push('lowPatternMatch');
  }
  if (parseContext.entityCompleteness !== undefined &&
      parseContext.entityCompleteness > 0 &&
      parseContext.entityCompleteness < 1.0) {
    conditions.push('partialEntityMatch');
  }

  // Boosts
  if (parseContext.matchType === 'trigger') {
    conditions.push('exactTriggerMatch');
  }
  if (parseContext.entityCompleteness === 1.0 && parseContext.missingRequired !== true) {
    conditions.push('allEntitiesExtracted');
  }
  if (parseContext.rawConfidence >= 0.9) {
    conditions.push('highPatternWeight');
  }
  if (!parseContext.hasAmbiguity && (!parseContext.closeMatchCount || parseContext.closeMatchCount === 0)) {
    conditions.push('singleClearMatch');
  }

  // Check for uncertainty triggers
  if (!parseContext.intentId && parseContext.matchType !== 'llm') {
    conditions.push('no_intent_match');
  }
  if (parseContext.llmFailed) {
    conditions.push('llmFallback');  // Extra penalty when LLM failed completely
    conditions.push('no_intent_match');
  }
  if (parseContext.matchType === 'none') {
    conditions.push('no_intent_match');
  }

  const result = calculator.calculate({ factors, conditions });

  logger.debug('NLS confidence calculated', {
    matchType: parseContext.matchType,
    rawConfidence: parseContext.rawConfidence,
    calibratedConfidence: result.value,
    level: result.level,
    factors,
    conditions,
    penalties: result.penalties,
    boosts: result.boosts
  });

  return result;
}

/**
 * Calculate query clarity based on length (very short queries are often ambiguous)
 */
function calculateQueryClarity(queryLength) {
  if (!queryLength) return 0.7;

  // Very short queries (< 5 chars) are often ambiguous
  if (queryLength < 5) return 0.3;
  // Short queries (5-15 chars) might be commands or brief requests
  if (queryLength < 15) return 0.6;
  // Medium queries (15-50 chars) typically provide enough context
  if (queryLength < 50) return 0.8;
  // Longer queries usually have good context
  return 0.9;
}

/**
 * Get explanation of how confidence would be calculated
 */
export function explainNLSConfidence(parseContext) {
  if (!calculator) {
    initializeNLSConfidence();
  }

  if (!calculator) {
    return { error: 'Confidence calculator not available' };
  }

  const factors = {
    model_certainty: parseContext.rawConfidence || 0.5,
    source_reliability: TIER_RELIABILITY[parseContext.matchType] || 0.5,
    data_completeness: parseContext.entityCompleteness ?? 1.0,
    data_quality: calculateQueryClarity(parseContext.queryLength)
  };

  const conditions = [];
  if (parseContext.hasAmbiguity) conditions.push('ambiguousIntent');
  if (parseContext.missingRequired) conditions.push('missingRequiredParams');
  if (parseContext.matchType === 'llm') conditions.push('llmFallback');
  if (parseContext.matchType === 'trigger') conditions.push('exactTriggerMatch');

  return calculator.explain({ factors, conditions });
}

/**
 * Get the loaded model info
 */
export function getNLSConfidenceModelInfo() {
  if (!calculator) {
    initializeNLSConfidence();
  }

  return calculator ? calculator.getModelInfo() : null;
}

export default {
  initializeNLSConfidence,
  calculateNLSConfidence,
  explainNLSConfidence,
  getNLSConfidenceModelInfo
};
