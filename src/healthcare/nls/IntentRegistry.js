/**
 * IntentRegistry - Central source of truth for known healthcare intents
 *
 * P1: Closed-world intent universe (allowlist only)
 * P5: Auditability + version pinning (ruleTableVersion tracking)
 *
 * Uses Zod for deterministic validation. Loads from rule tables with fallback.
 */

import { z } from 'zod';
import { Logger } from '../../utils/logger.js';
import { IntentFamily } from './contracts/zod/IntentParseEnvelope.js';
import { loadRuleTables, getCurrentVersion, getCachedRules } from './rules/index.js';

const logger = new Logger('IntentRegistry');

/**
 * Zod schema for parameter validation (built dynamically from rule definitions)
 */
function buildParameterSchema(requiredParams = [], optionalParams = []) {
  const shape = {};

  for (const param of requiredParams) {
    let field;
    switch (param.type) {
      case 'number': field = z.number(); break;
      case 'boolean': field = z.boolean(); break;
      case 'date': field = z.string().datetime(); break;
      default: field = z.string();
    }
    if (param.defaultValue !== undefined) {
      field = field.default(param.defaultValue);
    }
    shape[param.name] = field;
  }

  for (const param of optionalParams) {
    let field;
    switch (param.type) {
      case 'number': field = z.number(); break;
      case 'boolean': field = z.boolean(); break;
      case 'date': field = z.string().datetime(); break;
      default: field = z.string();
    }
    if (param.defaultValue !== undefined) {
      field = field.default(param.defaultValue);
    }
    shape[param.name] = field.optional();
  }

  return z.object(shape);
}

/**
 * Fallback intents (used if rule tables fail to load)
 */
const FALLBACK_INTENTS = [
  {
    intentId: 'hc:patient-summary',
    intentFamily: IntentFamily.CLINICAL,
    domain: 'patient_summary',
    name: 'Patient Summary',
    description: 'Retrieve and summarize patient information',
    requiredParameters: [{ name: 'patientId', type: 'patientId' }],
    optionalParameters: [{ name: 'timeRange', type: 'string', defaultValue: 'all' }],
    triggers: ['/patient', '/patient-summary', '/ps'],
    patterns: [
      { regex: '^/patient(?:-summary)?\\s+(?<patientId>[\\w-]+)(?:\\s+(?<timeRange>\\d+months|all))?$', weight: 0.95 },
      { regex: 'patient\\s+(?:summary\\s+(?:for\\s+)?)?(?<patientId>[A-Z]{2,3}-?\\d{3,10})', weight: 0.85 },
      { regex: 'show\\s+(?:me\\s+)?patient\\s+(?<patientId>[\\w-]+)', weight: 0.8 }
    ],
    synonyms: ['patient info', 'patient data', 'patient record'],
    recipe: 'patient-summary',
    clinicalSafetyLevel: 'informational',
    examples: ['/patient MRN-12345', 'show me patient P001']
  },
  {
    intentId: 'hc:treatment-recommendation',
    intentFamily: IntentFamily.CLINICAL,
    domain: 'treatment',
    name: 'Treatment Recommendation',
    description: 'Get treatment recommendations for a condition',
    requiredParameters: [],
    optionalParameters: [
      { name: 'condition', type: 'string' },
      { name: 'patientId', type: 'patientId' },
      { name: 'urgency', type: 'string', defaultValue: 'routine' }
    ],
    triggers: ['/treatment', '/treat', '/recommend'],
    patterns: [
      // Slash command patterns
      { regex: '^/treat(?:ment)?\\s+(?<condition>.+)$', weight: 0.95 },
      // Natural language patterns for conditions
      { regex: 'treatment\\s+(?:options?|recommendations?|plan)?\\s+(?:for\\s+)?(?<condition>diabetes|hypertension|asthma|copd|heart\\s+failure|depression|anxiety|obesity)', weight: 0.9 },
      { regex: '(?:what|how)\\s+(?:are|is|to)\\s+(?:the\\s+)?treatment\\s+(?:options?)?\\s+(?:for\\s+)?(?<condition>.+?)(?:\\?|$)', weight: 0.88 },
      { regex: '(?:how\\s+(?:do|should)\\s+(?:you|we|I)\\s+)?treat\\s+(?<condition>.+?)(?:\\?|$)', weight: 0.85 },
      { regex: '(?:recommend|recommend(?:ation)?s?\\s+(?:for\\s+)?)?(?<condition>diabetes|hypertension|asthma|copd)\\s+(?:type\\s+\\d)?\\s*treatment', weight: 0.85 },
      // Patient-specific treatment
      { regex: 'treatment\\s+(?:recommendation|plan)\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[\\w-]+)', weight: 0.82 }
    ],
    synonyms: ['treatment plan', 'treatment options', 'how to treat', 'therapy for'],
    recipe: 'treatment-recommendation',
    clinicalSafetyLevel: 'advisory',
    examples: ['/treatment diabetes type 2', 'what are the treatment options for hypertension', 'how to treat asthma']
  },
  {
    intentId: 'hc:diagnosis',
    intentFamily: IntentFamily.CLINICAL,
    domain: 'diagnosis',
    name: 'Differential Diagnosis',
    description: 'Generate differential diagnosis list from symptoms with ICD-10 coding',
    requiredParameters: [{ name: 'symptoms', type: 'string' }],
    optionalParameters: [
      { name: 'patientId', type: 'patientId' },
      { name: 'acuity', type: 'string' }
    ],
    triggers: ['/diagnosis', '/diagnose', '/ddx', '/differential'],
    patterns: [
      { regex: '^/(?:diagnosis|diagnose|ddx|differential)\\s+(?<symptoms>.+)$', weight: 0.95 },
      { regex: 'differential\\s+(?:diagnosis|dx)\\s+(?:for\\s+)?(?<symptoms>.+)', weight: 0.85 },
      { regex: 'what\\s+(?:could|might|can)\\s+cause\\s+(?<symptoms>.+?)(?:\\?|$)', weight: 0.8 },
      { regex: 'diagnos(?:e|is)\\s+(?:for\\s+)?(?<symptoms>.+?)(?:\\?|$)', weight: 0.8 }
    ],
    synonyms: ['differential', 'ddx', 'possible diagnoses', 'diagnostic coding'],
    recipe: 'diagnosis',
    clinicalSafetyLevel: 'advisory',
    examples: ['/diagnosis chest pain', '/ddx shortness of breath and fever', 'what could cause persistent headache']
  },
  {
    intentId: 'hc:care-gaps',
    intentFamily: IntentFamily.CLINICAL,
    domain: 'care_gaps',
    name: 'Care Gap Analysis',
    description: 'Analyze care gaps for a patient or population',
    requiredParameters: [],
    optionalParameters: [
      { name: 'patientId', type: 'patientId' },
      { name: 'measure', type: 'string' },
      { name: 'scope', type: 'string', defaultValue: 'patient' }
    ],
    triggers: ['/care-gaps', '/gaps', '/quality'],
    patterns: [
      { regex: '^/(?:care-)?gaps\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[\\w-]+)?$', weight: 0.95 },
      { regex: 'care\\s+gaps?\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[\\w-]+)', weight: 0.85 }
    ],
    synonyms: ['quality measures', 'preventive care'],
    recipe: 'care-gaps',
    clinicalSafetyLevel: 'informational',
    examples: ['/care-gaps P001', 'show care gaps for patient 12345']
  },
  {
    intentId: 'hc:emergency-triage',
    intentFamily: IntentFamily.CLINICAL,
    domain: 'triage',
    name: 'Emergency Triage',
    description: 'Assess emergency triage status for a patient',
    requiredParameters: [{ name: 'patientId', type: 'patientId' }],
    optionalParameters: [
      { name: 'chiefComplaint', type: 'string' },
      { name: 'vitalSigns', type: 'string' }
    ],
    triggers: ['/triage', '/emergency', '/esi'],
    patterns: [
      { regex: '^/(?:triage|emergency|esi)\\s+(?<patientId>[\\w-]+)(?:\\s+(?<chiefComplaint>.+))?$', weight: 0.95 },
      { regex: 'triage\\s+(?:patient\\s+)?(?<patientId>[\\w-]+)', weight: 0.9 }
    ],
    synonyms: ['acuity assessment', 'urgency evaluation'],
    recipe: 'emergency-triage',
    clinicalSafetyLevel: 'action_required',
    examples: ['/triage P001 chest pain', 'triage patient MRN-456']
  },
  {
    intentId: 'hc:drug-check',
    intentFamily: IntentFamily.CLINICAL,
    domain: 'medication_safety',
    name: 'Drug Interaction Check',
    description: 'Check for drug-drug interactions, contraindications, and medication safety concerns',
    requiredParameters: [],
    optionalParameters: [
      { name: 'patientId', type: 'patientId' },
      { name: 'medications', type: 'string' }
    ],
    triggers: ['/drug-check', '/ddi', '/med-safety', '/medication-check'],
    patterns: [
      { regex: '^/(?:drug-check|ddi|med-safety)(?:\\s+(?<medications>.+))?$', weight: 0.95 },
      { regex: 'drug\\s+(?:drug\\s+)?interaction(?:s)?\\s+(?:for\\s+)?(?:between\\s+)?(?<medications>.+)', weight: 0.85 },
      { regex: 'check\\s+(?:for\\s+)?(?:drug\\s+)?interactions?\\s+(?:between\\s+)?(?<medications>.+)', weight: 0.85 },
      { regex: 'medication\\s+safety\\s+(?:check\\s+)?(?:for\\s+)?(?<medications>.+)?', weight: 0.8 }
    ],
    synonyms: ['drug interaction', 'medication interaction', 'drug safety', 'DDI check'],
    recipe: 'drug-check',
    clinicalSafetyLevel: 'advisory',
    examples: ['/drug-check metformin lisinopril', 'check drug interactions for warfarin and aspirin', '/ddi aspirin ibuprofen']
  },
  {
    intentId: 'hc:help',
    intentFamily: IntentFamily.SYSTEM,
    domain: 'system',
    name: 'Help',
    description: 'Show available healthcare commands and capabilities',
    requiredParameters: [],
    optionalParameters: [{ name: 'topic', type: 'string' }],
    triggers: ['/help', '/commands', '/?'],
    patterns: [
      { regex: '^/(?:help|commands|\\?)(?:\\s+(?<topic>.+))?$', weight: 0.95 },
      { regex: 'help(?:\\s+(?:with|on))?(?:\\s+(?<topic>.+))?', weight: 0.8 }
    ],
    synonyms: ['assistance', 'commands', 'options'],
    recipe: 'help',
    clinicalSafetyLevel: 'informational',
    examples: ['/help', 'help with patient commands']
  }
];

/**
 * Transform a rule to internal intent format with Zod schema
 */
function transformRuleToIntent(rule) {
  const requiredParamNames = (rule.requiredParameters || []).map(p =>
    typeof p === 'string' ? p : p.name
  );

  return {
    intentId: rule.intentId,
    intentFamily: rule.intentFamily,
    domain: rule.domain,
    name: rule.name,
    description: rule.description,
    parameterSchema: buildParameterSchema(rule.requiredParameters, rule.optionalParameters),
    requiredParameters: requiredParamNames,
    optionalParameters: (rule.optionalParameters || []).map(p => typeof p === 'string' ? p : p.name),
    triggers: rule.triggers,
    patterns: rule.patterns || [],
    synonyms: rule.synonyms || [],
    recipe: rule.recipe,
    requiresConfirmation: rule.requiresConfirmation || false,
    clinicalSafetyLevel: rule.clinicalSafetyLevel || 'informational',
    examples: rule.examples || [],
    _source: 'rule_table'
  };
}

export class IntentRegistry {
  constructor() {
    this.intents = new Map();
    this.triggerMap = new Map();
    this.initialized = false;
    this.ruleTableVersion = null;
    this.loadedFrom = null;
  }

  /**
   * Initialize synchronously (uses fallback if rules not loaded)
   */
  initialize() {
    if (this.initialized) return;

    const cachedRules = getCachedRules();
    if (cachedRules) {
      this._loadFromRuleTables(cachedRules);
    } else {
      this._loadFromFallback();
    }

    this.initialized = true;
    logger.info(`IntentRegistry initialized`, {
      intentCount: this.intents.size,
      ruleTableVersion: this.ruleTableVersion,
      loadedFrom: this.loadedFrom
    });
  }

  /**
   * Initialize asynchronously with rule table loading
   */
  async initializeAsync() {
    if (this.initialized) return;

    try {
      const ruleTables = await loadRuleTables();
      this._loadFromRuleTables(ruleTables);
    } catch (err) {
      logger.warn('Failed to load rule tables, using fallback', { error: err.message });
      this._loadFromFallback();
    }

    this.initialized = true;
    logger.info(`IntentRegistry initialized (async)`, {
      intentCount: this.intents.size,
      ruleTableVersion: this.ruleTableVersion,
      loadedFrom: this.loadedFrom
    });
  }

  _loadFromRuleTables(ruleTables) {
    this.ruleTableVersion = ruleTables.version;
    this.loadedFrom = 'rule_tables';

    // Load rule-based intents
    for (const rule of ruleTables.intents) {
      const intent = transformRuleToIntent(rule);
      this.registerIntent(intent);
    }

    // Also load fallback intents not in rule tables
    for (const fallback of FALLBACK_INTENTS) {
      if (!this.intents.has(fallback.intentId)) {
        const intent = transformRuleToIntent(fallback);
        intent._source = 'fallback';
        this.registerIntent(intent);
      }
    }
  }

  _loadFromFallback() {
    this.ruleTableVersion = 'fallback-1.0.0';
    this.loadedFrom = 'fallback';

    for (const fallback of FALLBACK_INTENTS) {
      const intent = transformRuleToIntent(fallback);
      intent._source = 'fallback';
      this.registerIntent(intent);
    }
  }

  /**
   * Reload intents from rule tables
   */
  async reload() {
    this.intents.clear();
    this.triggerMap.clear();
    this.initialized = false;
    await this.initializeAsync();
    logger.info('IntentRegistry reloaded', {
      intentCount: this.intents.size,
      ruleTableVersion: this.ruleTableVersion
    });
  }

  registerIntent(intentDef) {
    const validated = this._validateIntentDef(intentDef);
    this.intents.set(validated.intentId, validated);
    for (const trigger of validated.triggers) {
      this.triggerMap.set(trigger.toLowerCase(), validated.intentId);
    }
  }

  // P1: Closed-world check
  isKnown(intentId) { return this.intents.has(intentId); }

  getIntent(intentId) { return this.intents.get(intentId); }

  getIntentByTrigger(trigger) {
    const intentId = this.triggerMap.get(trigger.toLowerCase());
    return intentId ? this.intents.get(intentId) : null;
  }

  getAllIntents() { return Array.from(this.intents.values()); }
  getAllIntentIds() { return Array.from(this.intents.keys()); }
  getIntentsByFamily(family) { return this.getAllIntents().filter(i => i.intentFamily === family); }
  getIntentsByDomain(domain) { return this.getAllIntents().filter(i => i.domain === domain); }

  // P5: Get rule table version
  getRuleTableVersion() { return this.ruleTableVersion; }

  /**
   * Validate parameters using Zod (deterministic)
   */
  validateParameters(intentId, parameters) {
    const intent = this.getIntent(intentId);
    if (!intent) return { isValid: false, error: `Unknown intent: ${intentId}` };

    const paramObj = {};
    for (const p of parameters) paramObj[p.name] = p.value;

    const result = intent.parameterSchema.safeParse(paramObj);

    if (!result.success) {
      const missingFields = result.error.errors
        .filter(e => e.code === 'invalid_type' && e.received === 'undefined')
        .map(e => e.path.join('.'));

      return {
        isValid: false,
        error: result.error.message,
        missingFields
      };
    }

    return { isValid: true, value: result.data };
  }

  getMissingRequired(intentId, providedParams) {
    const intent = this.getIntent(intentId);
    if (!intent) return [];
    const providedNames = new Set(providedParams.map(p => p.name));
    return intent.requiredParameters.filter(r => !providedNames.has(r));
  }

  getIntentSummary() {
    return this.getAllIntents().map(i => ({
      intentId: i.intentId,
      name: i.name,
      description: i.description,
      domain: i.domain,
      requiredParameters: i.requiredParameters,
      examples: i.examples,
      clinicalSafetyLevel: i.clinicalSafetyLevel
    }));
  }

  _validateIntentDef(def) {
    // Allow both hc: and clinical. prefixes
    if (!def.intentId || (!def.intentId.startsWith('hc:') && !def.intentId.startsWith('clinical.'))) {
      throw new Error(`Intent ID must start with 'hc:' or 'clinical.': ${def.intentId}`);
    }
    if (!def.name) throw new Error(`Intent must have a name: ${def.intentId}`);
    if (!def.parameterSchema) throw new Error(`Intent must have a parameterSchema: ${def.intentId}`);
    if (!def.triggers || def.triggers.length === 0) {
      throw new Error(`Intent must have at least one trigger: ${def.intentId}`);
    }
    if (!def.recipe) throw new Error(`Intent must have a recipe: ${def.intentId}`);

    return {
      ...def,
      requiredParameters: def.requiredParameters || [],
      optionalParameters: def.optionalParameters || [],
      patterns: def.patterns || [],
      synonyms: def.synonyms || [],
      examples: def.examples || [],
      domain: def.domain || 'system',
      clinicalSafetyLevel: def.clinicalSafetyLevel || 'informational',
      requiresConfirmation: def.requiresConfirmation || false
    };
  }
}

// Singleton
let instance = null;

export function getIntentRegistry() {
  if (!instance) {
    instance = new IntentRegistry();
    instance.initialize();
  }
  return instance;
}

export async function getIntentRegistryAsync() {
  if (!instance) {
    instance = new IntentRegistry();
    await instance.initializeAsync();
  } else if (!instance.initialized) {
    await instance.initializeAsync();
  }
  return instance;
}

export default IntentRegistry;
