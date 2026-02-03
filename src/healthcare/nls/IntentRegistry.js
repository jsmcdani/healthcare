/**
 * IntentRegistry - Central source of truth for known healthcare intents
 */

import Joi from 'joi';
import { Logger } from '../../utils/logger.js';
import { IntentFamily } from './contracts/IntentParseEnvelope.js';

const logger = new Logger('IntentRegistry');

const HEALTHCARE_INTENTS = [
  {
    intentId: 'hc:patient-summary',
    intentFamily: IntentFamily.CLINICAL,
    name: 'Patient Summary',
    description: 'Retrieve and summarize patient information',
    parameterSchema: Joi.object({
      patientId: Joi.string().required(),
      timeRange: Joi.string().valid('3months', '6months', '12months', 'all').default('all')
    }),
    requiredParameters: ['patientId'],
    triggers: ['/patient', '/patient-summary', '/ps'],
    patterns: [
      { regex: '^/patient(?:-summary)?\\s+(?<patientId>[\\w-]+)(?:\\s+(?<timeRange>\\d+months|all))?$', weight: 0.95 },
      { regex: 'patient\\s+(?:summary\\s+(?:for\\s+)?)?(?<patientId>[A-Z]{2,3}-?\\d{3,10})', weight: 0.85 },
      { regex: 'show\\s+(?:me\\s+)?patient\\s+(?<patientId>[\\w-]+)', weight: 0.8 }
    ],
    synonyms: ['patient info', 'patient data', 'patient record'],
    recipe: 'patient-summary',
    examples: ['/patient MRN-12345', 'show me patient P001']
  },
  {
    intentId: 'hc:treatment-recommendation',
    intentFamily: IntentFamily.CLINICAL,
    name: 'Treatment Recommendation',
    description: 'Get treatment recommendations for a patient condition',
    parameterSchema: Joi.object({
      patientId: Joi.string().required(),
      condition: Joi.string().optional(),
      urgency: Joi.string().valid('routine', 'urgent', 'emergency').default('routine')
    }),
    requiredParameters: ['patientId'],
    triggers: ['/treatment', '/treat', '/recommend'],
    patterns: [
      { regex: '^/treat(?:ment)?\\s+(?<patientId>[\\w-]+)(?:\\s+(?<condition>.+))?$', weight: 0.95 },
      { regex: 'treatment\\s+(?:recommendation|plan)\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[\\w-]+)', weight: 0.85 }
    ],
    synonyms: ['treatment plan', 'treatment options'],
    recipe: 'treatment-recommendation',
    examples: ['/treatment P001', 'treatment recommendation for patient MRN-456']
  },
  {
    intentId: 'hc:care-gaps',
    intentFamily: IntentFamily.CLINICAL,
    name: 'Care Gap Analysis',
    description: 'Analyze care gaps for a patient or population',
    parameterSchema: Joi.object({
      patientId: Joi.string().optional(),
      measure: Joi.string().optional(),
      scope: Joi.string().valid('patient', 'panel', 'organization').default('patient')
    }),
    requiredParameters: [],
    triggers: ['/care-gaps', '/gaps', '/quality'],
    patterns: [
      { regex: '^/(?:care-)?gaps\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[\\w-]+)?$', weight: 0.95 },
      { regex: 'care\\s+gaps?\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[\\w-]+)', weight: 0.85 }
    ],
    synonyms: ['quality measures', 'preventive care'],
    recipe: 'care-gaps',
    examples: ['/care-gaps P001', 'show care gaps for patient 12345']
  },
  {
    intentId: 'hc:emergency-triage',
    intentFamily: IntentFamily.CLINICAL,
    name: 'Emergency Triage',
    description: 'Assess emergency triage status for a patient',
    parameterSchema: Joi.object({
      patientId: Joi.string().required(),
      chiefComplaint: Joi.string().optional(),
      vitalSigns: Joi.object().optional()
    }),
    requiredParameters: ['patientId'],
    triggers: ['/triage', '/emergency', '/esi'],
    patterns: [
      { regex: '^/(?:triage|emergency|esi)\\s+(?<patientId>[\\w-]+)(?:\\s+(?<chiefComplaint>.+))?$', weight: 0.95 },
      { regex: 'triage\\s+(?:patient\\s+)?(?<patientId>[\\w-]+)', weight: 0.9 }
    ],
    synonyms: ['acuity assessment', 'urgency evaluation'],
    recipe: 'emergency-triage',
    examples: ['/triage P001 chest pain', 'triage patient MRN-456']
  },
  {
    intentId: 'hc:help',
    intentFamily: IntentFamily.SYSTEM,
    name: 'Help',
    description: 'Show available healthcare commands and capabilities',
    parameterSchema: Joi.object({
      topic: Joi.string().optional()
    }),
    requiredParameters: [],
    triggers: ['/help', '/commands', '/?'],
    patterns: [
      { regex: '^/(?:help|commands|\\?)(?:\\s+(?<topic>.+))?$', weight: 0.95 },
      { regex: 'help(?:\\s+(?:with|on))?(?:\\s+(?<topic>.+))?', weight: 0.8 }
    ],
    synonyms: ['assistance', 'commands', 'options'],
    recipe: 'help',
    examples: ['/help', 'help with patient commands']
  }
];

export class IntentRegistry {
  constructor() {
    this.intents = new Map();
    this.triggerMap = new Map();
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return;
    for (const intent of HEALTHCARE_INTENTS) {
      this.registerIntent(intent);
    }
    this.initialized = true;
    logger.info(`IntentRegistry initialized with ${this.intents.size} intents`);
  }

  registerIntent(intentDef) {
    const validated = this._validateIntentDef(intentDef);
    this.intents.set(validated.intentId, validated);
    for (const trigger of validated.triggers) {
      this.triggerMap.set(trigger.toLowerCase(), validated.intentId);
    }
  }

  isKnown(intentId) { return this.intents.has(intentId); }
  getIntent(intentId) { return this.intents.get(intentId); }
  getIntentByTrigger(trigger) {
    const intentId = this.triggerMap.get(trigger.toLowerCase());
    return intentId ? this.intents.get(intentId) : null;
  }
  getAllIntents() { return Array.from(this.intents.values()); }
  getAllIntentIds() { return Array.from(this.intents.keys()); }
  getIntentsByFamily(family) { return this.getAllIntents().filter(i => i.intentFamily === family); }

  validateParameters(intentId, parameters) {
    const intent = this.getIntent(intentId);
    if (!intent) return { isValid: false, error: `Unknown intent: ${intentId}` };
    const paramObj = {};
    for (const p of parameters) paramObj[p.name] = p.value;
    const { error, value } = intent.parameterSchema.validate(paramObj, { stripUnknown: true, abortEarly: false });
    if (error) {
      return {
        isValid: false,
        error: error.message,
        missingFields: error.details.filter(d => d.type === 'any.required').map(d => d.path.join('.'))
      };
    }
    return { isValid: true, value };
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
      requiredParameters: i.requiredParameters,
      examples: i.examples
    }));
  }

  _validateIntentDef(def) {
    if (!def.intentId || !def.intentId.startsWith('hc:')) throw new Error(`Intent ID must start with 'hc:': ${def.intentId}`);
    if (!def.name) throw new Error(`Intent must have a name: ${def.intentId}`);
    if (!def.parameterSchema) throw new Error(`Intent must have a parameterSchema: ${def.intentId}`);
    if (!def.triggers || def.triggers.length === 0) throw new Error(`Intent must have at least one trigger: ${def.intentId}`);
    if (!def.recipe) throw new Error(`Intent must have a recipe: ${def.intentId}`);
    return { ...def, requiredParameters: def.requiredParameters || [], patterns: def.patterns || [], synonyms: def.synonyms || [], examples: def.examples || [] };
  }
}

let instance = null;
export function getIntentRegistry() {
  if (!instance) {
    instance = new IntentRegistry();
    instance.initialize();
  }
  return instance;
}

export default IntentRegistry;
