/**
 * NLSConfidenceIntegration - Control Plane Confidence for NLS
 *
 * Loads confidence model + signal mappings from versioned pack.
 * NO hardcoded confidence logic — all values from pack/registry.
 *
 * Architecture: Mount Sinai InfEHR approach
 *   - Deterministic scoring (0-1) from weighted factors
 *   - Explainability (full factor breakdown in every result)
 *   - Clinical gating (canProceed flag blocks action when confidence insufficient)
 *   - "I don't know" safety (uncertaintyTriggers → refuse rather than guess)
 *
 * Per architecture (connfidenc.xml):
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

// State — all loaded from pack, nothing hardcoded
let calculator = null;
let packData = null;
let tierReliability = null;
let queryClarity = null;

/**
 * Initialize the NLS confidence system from versioned pack.
 * Fails with CONFIGURATION ERROR if pack is missing or invalid — no silent fallbacks.
 */
export function initializeNLSConfidence() {
  if (calculator) return calculator;

  const packPath = path.resolve(__dirname, '../packs/confidence/nls-intent-parsing.confidence.json');

  // Load pack — fail loud if missing
  let packJson;
  try {
    packJson = fs.readFileSync(packPath, 'utf-8');
  } catch (error) {
    const msg = `CONFIGURATION ERROR: NLS confidence pack not found at ${packPath}. ` +
      'Confidence computation requires a valid pack. Status: REQUIRES_REVIEW';
    logger.error(msg, { error: error.message });
    throw new Error(msg);
  }

  // Parse — fail loud if invalid JSON
  try {
    packData = JSON.parse(packJson);
  } catch (error) {
    const msg = 'CONFIGURATION ERROR: NLS confidence pack contains invalid JSON. ' +
      'Status: REQUIRES_REVIEW';
    logger.error(msg, { error: error.message });
    throw new Error(msg);
  }

  // Validate required pack sections — no guessing, no defaults
  if (!packData.modelId || !packData.modelVersion) {
    throw new Error(
      'CONFIGURATION ERROR: NLS confidence pack missing modelId or modelVersion. ' +
      'Status: REQUIRES_REVIEW'
    );
  }

  if (!packData.signalMappings) {
    throw new Error(
      'CONFIGURATION ERROR: NLS confidence pack missing signalMappings section. ' +
      'Tier reliability and query clarity must be defined in the pack. ' +
      'Status: REQUIRES_REVIEW'
    );
  }

  if (!packData.signalMappings.tierReliability) {
    throw new Error(
      'CONFIGURATION ERROR: NLS confidence pack missing signalMappings.tierReliability. ' +
      'Status: REQUIRES_REVIEW'
    );
  }

  if (!packData.signalMappings.queryClarity) {
    throw new Error(
      'CONFIGURATION ERROR: NLS confidence pack missing signalMappings.queryClarity. ' +
      'Status: REQUIRES_REVIEW'
    );
  }

  // Load signal mappings from pack
  tierReliability = packData.signalMappings.tierReliability;
  queryClarity = packData.signalMappings.queryClarity;

  // Create calculator from model definition (Zod-validated by ConfidenceCalculator)
  calculator = new ConfidenceCalculator(packData);

  logger.info('NLS confidence initialized from pack', {
    modelId: packData.modelId,
    modelVersion: packData.modelVersion,
    tierMappings: Object.keys(tierReliability),
    clarityBrackets: queryClarity.brackets?.length || 0
  });

  return calculator;
}

/**
 * Calculate calibrated confidence for a parse result.
 *
 * All factor values derived from pack-defined signal mappings.
 * Conditions derived from deterministic parse signals only.
 * Version pinned in result for audit trail (P5).
 *
 * @param {Object} parseContext - Deterministic signals from parser
 * @param {string} parseContext.matchType - 'trigger', 'pattern', 'synonym', 'llm', 'confirmed', 'none'
 * @param {number} parseContext.rawConfidence - Raw parser weight (pattern weight or LLM output)
 * @param {number} parseContext.entityCompleteness - 0-1 ratio of extracted vs required entities
 * @param {number} parseContext.queryLength - Length of user query
 * @param {boolean} parseContext.hasAmbiguity - Whether close matches exist
 * @param {boolean} parseContext.missingRequired - Whether required params are missing
 * @param {number} parseContext.closeMatchCount - Number of close competing matches
 * @returns {Object} Calibrated confidence result with value, level, canProceed, pinned versions
 */
export function calculateNLSConfidence(parseContext) {
  if (!calculator) {
    initializeNLSConfidence(); // Throws if pack missing — no fallback
  }

  // Map signals to factors using pack-defined mappings (not hardcoded)
  const factors = {
    model_certainty: parseContext.rawConfidence || 0,
    source_reliability: tierReliability[parseContext.matchType] ?? tierReliability['none'] ?? 0,
    data_completeness: parseContext.entityCompleteness ?? 1.0,
    data_quality: resolveQueryClarity(parseContext.queryLength)
  };

  // Build conditions from deterministic parse signals
  const conditions = buildConditions(parseContext);

  // Calculate via ConfidenceCalculator (model-driven, not hardcoded)
  const result = calculator.calculate({ factors, conditions });

  // Pin pack version in result for audit trail (P5)
  result.packVersion = packData.modelVersion;
  result.modelId = packData.modelId;
  result.modelVersion = packData.modelVersion;

  logger.debug('NLS confidence calculated', {
    matchType: parseContext.matchType,
    rawConfidence: parseContext.rawConfidence,
    calibratedConfidence: result.value,
    level: result.level,
    model: `${packData.modelId}@${packData.modelVersion}`,
    factors,
    conditions,
    penalties: result.penalties,
    boosts: result.boosts
  });

  return result;
}

/**
 * Build conditions array from deterministic parse signals.
 * Maps boolean parse signals to condition strings that match
 * penalty/boost definitions in the pack model.
 */
function buildConditions(parseContext) {
  const conditions = [];

  // Penalties (conditions matching pack penalty definitions)
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

  // Boosts (conditions matching pack boost definitions)
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

  // Uncertainty triggers (conditions matching pack uncertaintyTriggers)
  if (!parseContext.intentId && parseContext.matchType !== 'llm') {
    conditions.push('no_intent_match');
  }
  if (parseContext.llmFailed) {
    conditions.push('llmFallback');
    conditions.push('no_intent_match');
  }
  if (parseContext.matchType === 'none') {
    conditions.push('no_intent_match');
  }

  return conditions;
}

/**
 * Resolve query clarity from pack-defined brackets.
 * All thresholds come from pack signalMappings.queryClarity.
 */
function resolveQueryClarity(queryLength) {
  if (!queryLength) return queryClarity.default;

  if (queryClarity.brackets) {
    for (const bracket of queryClarity.brackets) {
      if (queryLength < bracket.maxLength) {
        return bracket.value;
      }
    }
  }

  return queryClarity.aboveAll ?? queryClarity.default;
}

/**
 * Get explanation of how confidence would be calculated
 */
export function explainNLSConfidence(parseContext) {
  if (!calculator) {
    initializeNLSConfidence();
  }

  const factors = {
    model_certainty: parseContext.rawConfidence || 0,
    source_reliability: tierReliability[parseContext.matchType] ?? tierReliability['none'] ?? 0,
    data_completeness: parseContext.entityCompleteness ?? 1.0,
    data_quality: resolveQueryClarity(parseContext.queryLength)
  };

  const conditions = [];
  if (parseContext.hasAmbiguity) conditions.push('ambiguousIntent');
  if (parseContext.missingRequired) conditions.push('missingRequiredParams');
  if (parseContext.matchType === 'llm') conditions.push('llmFallback');
  if (parseContext.matchType === 'trigger') conditions.push('exactTriggerMatch');

  return calculator.explain({ factors, conditions });
}

/**
 * Get loaded model info including pack version and signal mapping metadata
 */
export function getNLSConfidenceModelInfo() {
  if (!calculator) {
    initializeNLSConfidence();
  }

  const info = calculator.getModelInfo();
  return {
    ...info,
    packVersion: packData?.modelVersion,
    signalMappings: {
      tierReliabilityKeys: tierReliability ? Object.keys(tierReliability) : [],
      queryClarity: queryClarity ? {
        brackets: queryClarity.brackets?.length || 0,
        default: queryClarity.default
      } : null
    }
  };
}

export default {
  initializeNLSConfidence,
  calculateNLSConfidence,
  explainNLSConfidence,
  getNLSConfidenceModelInfo
};
