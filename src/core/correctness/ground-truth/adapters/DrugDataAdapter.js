/**
 * DrugDataAdapter - Adapter for drug information and interaction databases
 *
 * Supports RxNorm, First Databank, Medi-Span, Drugs@FDA for:
 * - Drug-drug interactions
 * - Drug-condition contraindications
 * - Dosing information
 * - Black box warnings
 */

import { BaseAdapter, QueryResult } from './BaseAdapter.js';

/**
 * Interaction severity levels
 */
export const InteractionSeverity = {
  CONTRAINDICATED: 'contraindicated',    // Never use together
  SEVERE: 'severe',                       // Major clinical significance
  MODERATE: 'moderate',                   // May require intervention
  MINOR: 'minor',                         // Monitor only
  UNKNOWN: 'unknown'
};

/**
 * Drug data systems
 */
export const DrugDataSystems = {
  RXNORM: {
    system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    name: 'RxNorm'
  },
  FIRST_DATABANK: {
    system: 'http://www.fdbhealth.com',
    name: 'First Databank'
  },
  MEDI_SPAN: {
    system: 'http://www.wolterskluwercdi.com/drug-data/medi-span',
    name: 'Medi-Span'
  },
  DRUGS_FDA: {
    system: 'https://www.fda.gov/drugs',
    name: 'Drugs@FDA'
  },
  NDC: {
    system: 'http://hl7.org/fhir/sid/ndc',
    name: 'NDC'
  }
};

/**
 * Adapter for drug data queries
 */
export class DrugDataAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.apiEndpoint = config.apiEndpoint;
    this.apiKey = config.apiKey;

    // Local interaction data (for offline/testing)
    this.interactionData = new Map();
    this.drugData = new Map();
    this.contraindicationData = new Map();
  }

  /**
   * Query implementation
   */
  async query(queryType, params) {
    return this.executeWithWrapper(queryType, params, async () => {
      switch (queryType) {
        case 'interaction':
          return this.doCheckInteraction(params.drugA, params.drugB);
        case 'interactions_list':
          return this.doGetInteractions(params.drug);
        case 'contraindication':
          return this.doCheckContraindication(params.drug, params.condition);
        case 'lookup':
          return this.doLookupDrug(params.identifier, params.system);
        case 'black_box':
          return this.doGetBlackBoxWarnings(params.drug);
        case 'dosing':
          return this.doGetDosingInfo(params.drug, params.indication);
        default:
          throw new Error(`Unknown query type: ${queryType}`);
      }
    });
  }

  /**
   * Check for interaction between two drugs
   */
  async checkInteraction(drugA, drugB) {
    return this.query('interaction', { drugA, drugB });
  }

  /**
   * Get all known interactions for a drug
   */
  async getInteractions(drug) {
    return this.query('interactions_list', { drug });
  }

  /**
   * Check for drug-condition contraindication
   */
  async checkContraindication(drug, condition) {
    return this.query('contraindication', { drug, condition });
  }

  /**
   * Lookup drug information
   */
  async lookupDrug(identifier, system = 'RXNORM') {
    return this.query('lookup', { identifier, system });
  }

  /**
   * Get black box warnings for a drug
   */
  async getBlackBoxWarnings(drug) {
    return this.query('black_box', { drug });
  }

  /**
   * Get dosing information
   */
  async getDosingInfo(drug, indication = null) {
    return this.query('dosing', { drug, indication });
  }

  /**
   * Check interaction between two drugs (implementation)
   */
  async doCheckInteraction(drugA, drugB) {
    // Normalize identifiers
    const keyA = this.normalizeDrugId(drugA);
    const keyB = this.normalizeDrugId(drugB);

    // Check local data first
    const localResult = this.checkLocalInteraction(keyA, keyB);
    if (localResult) {
      return localResult;
    }

    // Query external API if configured
    if (this.apiEndpoint) {
      return this.queryApiInteraction(keyA, keyB);
    }

    // No interaction found (or no data source)
    return QueryResult.found({
      drugA: keyA,
      drugB: keyB,
      interactionFound: false,
      severity: null,
      description: null,
      dataSource: 'none'
    }, {
      source: this.sourceId,
      version: this.sourceVersion,
      confidence: 0.3 // Low confidence without external validation
    });
  }

  /**
   * Get all interactions for a drug (implementation)
   */
  async doGetInteractions(drug) {
    const key = this.normalizeDrugId(drug);
    const interactions = [];

    // Check local data
    for (const [interactionKey, data] of this.interactionData.entries()) {
      if (interactionKey.includes(key)) {
        interactions.push(data);
      }
    }

    // Query API if available
    if (this.apiEndpoint) {
      const apiResult = await this.queryApiInteractionsList(key);
      if (apiResult.found && apiResult.data?.interactions) {
        interactions.push(...apiResult.data.interactions);
      }
    }

    return QueryResult.found({
      drug: key,
      interactions,
      count: interactions.length
    }, {
      source: this.sourceId,
      version: this.sourceVersion,
      confidence: interactions.length > 0 ? 1.0 : 0.5
    });
  }

  /**
   * Check drug-condition contraindication (implementation)
   */
  async doCheckContraindication(drug, condition) {
    const drugKey = this.normalizeDrugId(drug);
    const conditionKey = condition.toLowerCase().trim();

    // Check local contraindication data
    const localKey = `${drugKey}:${conditionKey}`;
    const localData = this.contraindicationData.get(localKey);

    if (localData) {
      return QueryResult.found({
        drug: drugKey,
        condition: conditionKey,
        contraindicated: true,
        severity: localData.severity,
        reason: localData.reason,
        recommendations: localData.recommendations
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    // Query API if available
    if (this.apiEndpoint) {
      return this.queryApiContraindication(drugKey, conditionKey);
    }

    return QueryResult.found({
      drug: drugKey,
      condition: conditionKey,
      contraindicated: false,
      severity: null,
      reason: 'No contraindication found in available data',
      dataSource: 'none'
    }, {
      source: this.sourceId,
      version: this.sourceVersion,
      confidence: 0.3
    });
  }

  /**
   * Lookup drug details (implementation)
   */
  async doLookupDrug(identifier, system) {
    const key = this.normalizeDrugId(identifier);

    // Check local drug data
    const localData = this.drugData.get(`${system}:${key}`) || this.drugData.get(key);
    if (localData) {
      return QueryResult.found(localData, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    // Query API
    if (this.apiEndpoint) {
      return this.queryApiDrugLookup(identifier, system);
    }

    return QueryResult.notFound({
      source: this.sourceId,
      version: this.sourceVersion
    });
  }

  /**
   * Get black box warnings (implementation)
   */
  async doGetBlackBoxWarnings(drug) {
    const key = this.normalizeDrugId(drug);

    // Check local data
    const drugInfo = this.drugData.get(key);
    if (drugInfo?.blackBoxWarnings) {
      return QueryResult.found({
        drug: key,
        warnings: drugInfo.blackBoxWarnings,
        hasBlackBox: drugInfo.blackBoxWarnings.length > 0
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    // Query API
    if (this.apiEndpoint) {
      return this.queryApiBlackBox(key);
    }

    return QueryResult.notFound({
      source: this.sourceId,
      version: this.sourceVersion
    });
  }

  /**
   * Get dosing information (implementation)
   */
  async doGetDosingInfo(drug, indication) {
    const key = this.normalizeDrugId(drug);

    // Check local data
    const drugInfo = this.drugData.get(key);
    if (drugInfo?.dosing) {
      let dosingInfo = drugInfo.dosing;
      if (indication && drugInfo.dosing.byIndication) {
        dosingInfo = drugInfo.dosing.byIndication[indication] || drugInfo.dosing.default;
      }

      return QueryResult.found({
        drug: key,
        indication,
        dosing: dosingInfo
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    // Query API
    if (this.apiEndpoint) {
      return this.queryApiDosing(key, indication);
    }

    return QueryResult.notFound({
      source: this.sourceId,
      version: this.sourceVersion
    });
  }

  /**
   * Normalize drug identifier
   */
  normalizeDrugId(id) {
    if (typeof id === 'string') {
      return id.toLowerCase().trim();
    }
    return String(id);
  }

  /**
   * Check local interaction data
   */
  checkLocalInteraction(drugA, drugB) {
    // Try both orderings
    const key1 = `${drugA}:${drugB}`;
    const key2 = `${drugB}:${drugA}`;

    const data = this.interactionData.get(key1) || this.interactionData.get(key2);

    if (data) {
      return QueryResult.found({
        drugA,
        drugB,
        interactionFound: true,
        severity: data.severity,
        description: data.description,
        mechanism: data.mechanism,
        clinicalEffects: data.clinicalEffects,
        management: data.management,
        references: data.references
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    return null;
  }

  // API query methods (stubs for external integration)

  async queryApiInteraction(drugA, drugB) {
    // Implementation would call external drug interaction API
    this.logger.debug('API interaction query', { drugA, drugB });
    return QueryResult.notFound({ source: this.sourceId });
  }

  async queryApiInteractionsList(drug) {
    this.logger.debug('API interactions list query', { drug });
    return QueryResult.notFound({ source: this.sourceId });
  }

  async queryApiContraindication(drug, condition) {
    this.logger.debug('API contraindication query', { drug, condition });
    return QueryResult.notFound({ source: this.sourceId });
  }

  async queryApiDrugLookup(identifier, system) {
    this.logger.debug('API drug lookup', { identifier, system });
    return QueryResult.notFound({ source: this.sourceId });
  }

  async queryApiBlackBox(drug) {
    this.logger.debug('API black box query', { drug });
    return QueryResult.notFound({ source: this.sourceId });
  }

  async queryApiDosing(drug, indication) {
    this.logger.debug('API dosing query', { drug, indication });
    return QueryResult.notFound({ source: this.sourceId });
  }

  // Methods for loading local data

  /**
   * Add a drug-drug interaction to local data
   */
  addInteraction(drugA, drugB, interaction) {
    const key = `${this.normalizeDrugId(drugA)}:${this.normalizeDrugId(drugB)}`;
    this.interactionData.set(key, {
      drugA,
      drugB,
      severity: interaction.severity || InteractionSeverity.UNKNOWN,
      description: interaction.description,
      mechanism: interaction.mechanism,
      clinicalEffects: interaction.clinicalEffects,
      management: interaction.management,
      references: interaction.references || []
    });
  }

  /**
   * Add drug information to local data
   */
  addDrug(identifier, drugInfo) {
    const key = this.normalizeDrugId(identifier);
    this.drugData.set(key, drugInfo);
  }

  /**
   * Add contraindication to local data
   */
  addContraindication(drug, condition, data) {
    const key = `${this.normalizeDrugId(drug)}:${condition.toLowerCase().trim()}`;
    this.contraindicationData.set(key, {
      severity: data.severity || InteractionSeverity.MODERATE,
      reason: data.reason,
      recommendations: data.recommendations || []
    });
  }

  /**
   * Load bulk interaction data
   */
  loadInteractions(interactions) {
    for (const interaction of interactions) {
      this.addInteraction(interaction.drugA, interaction.drugB, interaction);
    }
    this.logger.info('Loaded interaction data', { count: interactions.length });
  }
}

export default DrugDataAdapter;
