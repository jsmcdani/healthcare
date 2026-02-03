/**
 * EntityExtractor - Extract healthcare entities from text
 */

import { Logger } from '../../../utils/logger.js';
import { ParameterSource } from '../contracts/IntentParseEnvelope.js';

const logger = new Logger('EntityExtractor');

const ENTITY_PATTERNS = {
  patientId: [
    { name: 'mrn_prefixed', regex: /(?:MRN|mrn|M)[-:]?\s*(\d{3,10})/i, confidence: 0.95, transform: (m) => `MRN-${m[1]}` },
    { name: 'patient_prefixed', regex: /(?:patient|pt|p)[-:\s]?([A-Z]?\d{3,10})/i, confidence: 0.9, transform: (m) => m[1].toUpperCase() },
    { name: 'alphanumeric_id', regex: /\b([A-Z]{1,3}[-]?\d{3,10})\b/, confidence: 0.75, transform: (m) => m[1] },
    { name: 'numeric_only', regex: /\b(\d{5,10})\b/, confidence: 0.5, transform: (m) => m[1] }
  ],
  timeRange: [
    { name: 'months_format', regex: /\b(\d+)\s*months?\b/i, confidence: 0.9, transform: (m) => `${m[1]}months` },
    { name: 'named_range', regex: /\b(3months|6months|12months|all)\b/i, confidence: 0.95, transform: (m) => m[1].toLowerCase() }
  ],
  urgency: [
    { name: 'explicit', regex: /\b(routine|urgent|emergency|stat|emergent)\b/i, confidence: 0.95, transform: (m) => m[1] === 'stat' || m[1] === 'emergent' ? 'emergency' : m[1].toLowerCase() }
  ],
  condition: [
    { name: 'common', regex: /\b(diabetes|hypertension|asthma|copd|chf|cad|ckd|obesity|depression|anxiety)\b/i, confidence: 0.85, transform: (m) => m[1].toLowerCase() },
    { name: 'icd_code', regex: /\b([A-Z]\d{2}(?:\.\d{1,2})?)\b/, confidence: 0.9, transform: (m) => m[1] }
  ],
  chiefComplaint: [
    { name: 'after_with', regex: /\bwith\s+(.+)$/i, confidence: 0.8, transform: (m) => m[1].trim() }
  ]
};

export class EntityExtractor {
  constructor() { this.patterns = ENTITY_PATTERNS; }

  extractAll(text, entityTypes = null) {
    const types = entityTypes || Object.keys(this.patterns);
    const results = {};
    for (const type of types) {
      const extracted = this.extractEntity(text, type);
      if (extracted) results[type] = extracted;
    }
    return results;
  }

  extractEntity(text, entityType) {
    const patterns = this.patterns[entityType];
    if (!patterns) return null;
    const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence);
    for (const pattern of sorted) {
      const match = text.match(pattern.regex);
      if (match) {
        return { value: pattern.transform(match), confidence: pattern.confidence, pattern: pattern.name, source: ParameterSource.EXPLICIT };
      }
    }
    return null;
  }

  extractFromGroups(match) {
    if (!match?.groups) return {};
    const results = {};
    for (const [name, value] of Object.entries(match.groups)) {
      if (value !== undefined && value !== null && value !== '') {
        results[name] = { value, confidence: 0.9, pattern: 'named_group', source: ParameterSource.EXPLICIT };
      }
    }
    return results;
  }

  toParameterArray(entities) {
    return Object.entries(entities).map(([name, data]) => ({
      name, value: data.value, source: data.source || ParameterSource.EXPLICIT, confidence: data.confidence
    }));
  }

  mergeEntities(base, additional) {
    const result = { ...base };
    for (const [name, data] of Object.entries(additional)) {
      if (!result[name] || data.confidence > result[name].confidence) result[name] = data;
    }
    return result;
  }

  applyDefaults(entities, intent) {
    if (!intent?.parameterSchema?.describe) return entities;
    const result = { ...entities };
    const schemaDesc = intent.parameterSchema.describe();
    if (schemaDesc.keys) {
      for (const [key, desc] of Object.entries(schemaDesc.keys)) {
        if (!result[key] && desc.flags?.default !== undefined) {
          result[key] = { value: desc.flags.default, confidence: 1.0, pattern: 'default', source: ParameterSource.DEFAULT };
        }
      }
    }
    return result;
  }
}

let instance = null;
export function getEntityExtractor() {
  if (!instance) instance = new EntityExtractor();
  return instance;
}

export default EntityExtractor;
