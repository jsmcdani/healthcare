/**
 * TerminologyAdapter - Adapter for medical terminology systems
 *
 * Supports ICD-10, SNOMED CT, LOINC, CPT, and other standard terminologies.
 * Can be configured to use FHIR terminology servers or local databases.
 */

import { BaseAdapter, QueryResult } from './BaseAdapter.js';

/**
 * Supported terminology systems
 */
export const TerminologySystems = {
  ICD10_CM: {
    system: 'http://hl7.org/fhir/sid/icd-10-cm',
    name: 'ICD-10-CM',
    codePattern: /^[A-Z]\d{2}(\.\d{1,4})?$/
  },
  ICD10_PCS: {
    system: 'http://www.cms.gov/Medicare/Coding/ICD10',
    name: 'ICD-10-PCS',
    codePattern: /^[A-Z0-9]{7}$/
  },
  SNOMED_CT: {
    system: 'http://snomed.info/sct',
    name: 'SNOMED CT',
    codePattern: /^\d{6,18}$/
  },
  LOINC: {
    system: 'http://loinc.org',
    name: 'LOINC',
    codePattern: /^\d{1,5}-\d$/
  },
  CPT: {
    system: 'http://www.ama-assn.org/go/cpt',
    name: 'CPT',
    codePattern: /^\d{5}[A-Z0-9]?$/
  },
  RXNORM: {
    system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    name: 'RxNorm',
    codePattern: /^\d+$/
  },
  NDC: {
    system: 'http://hl7.org/fhir/sid/ndc',
    name: 'NDC',
    codePattern: /^\d{4,5}-\d{3,4}-\d{1,2}$/
  }
};

/**
 * Adapter for terminology validation and lookup
 */
export class TerminologyAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.fhirEndpoint = config.fhirEndpoint;
    this.localDb = config.localDb;
    this.supportedSystems = config.supportedSystems || Object.keys(TerminologySystems);

    // Local terminology cache (for offline/embedded use)
    this.terminologyData = new Map();
  }

  /**
   * Initialize - load local terminology data if configured
   */
  async initialize() {
    await super.initialize();

    if (this.localDb) {
      await this.loadLocalTerminology();
    }

    return true;
  }

  /**
   * Load terminology from local database/files
   */
  async loadLocalTerminology() {
    this.logger.info('Loading local terminology data');
    // Implementation would load from configured local source
    // For now, this is a placeholder for future implementation
  }

  /**
   * Health check - verify FHIR endpoint or local data is accessible
   */
  async healthCheck() {
    const startTime = Date.now();

    try {
      if (this.fhirEndpoint) {
        // Check FHIR server metadata endpoint
        const response = await fetch(`${this.fhirEndpoint}/metadata`, {
          signal: AbortSignal.timeout(5000)
        });
        const healthy = response.ok;

        return {
          healthy,
          sourceId: this.sourceId,
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - startTime,
          details: healthy ? 'FHIR server accessible' : `HTTP ${response.status}`
        };
      }

      // For local-only mode
      return {
        healthy: this.terminologyData.size > 0 || this.localDb != null,
        sourceId: this.sourceId,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        details: 'Local terminology mode'
      };

    } catch (error) {
      return {
        healthy: false,
        sourceId: this.sourceId,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        error: error.message
      };
    }
  }

  /**
   * Query implementation
   */
  async query(queryType, params) {
    return this.executeWithWrapper(queryType, params, async () => {
      switch (queryType) {
        case 'validate_code':
          return this.doValidateCode(params.code, params.system);
        case 'lookup':
          return this.doLookupCode(params.code, params.system);
        case 'search':
          return this.doSearchCodes(params.text, params.system, params.limit);
        case 'subsumes':
          return this.doSubsumption(params.parent, params.child, params.system);
        default:
          throw new Error(`Unknown query type: ${queryType}`);
      }
    });
  }

  /**
   * Validate that a code exists and is valid
   */
  async doValidateCode(code, systemKey) {
    const system = this.getSystem(systemKey);
    if (!system) {
      return QueryResult.error(`Unknown terminology system: ${systemKey}`);
    }

    // First check format
    if (system.codePattern && !system.codePattern.test(code)) {
      return QueryResult.found({
        valid: false,
        code,
        system: systemKey,
        reason: 'Invalid code format'
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    // Check local cache/data first
    const localResult = this.checkLocal(code, systemKey);
    if (localResult) {
      return localResult;
    }

    // Query FHIR server if configured
    if (this.fhirEndpoint) {
      return this.queryFhirValidate(code, system);
    }

    // If no external source, return uncertain result
    return QueryResult.found({
      valid: true,
      code,
      system: systemKey,
      reason: 'Format valid, external validation unavailable'
    }, {
      source: this.sourceId,
      version: this.sourceVersion,
      confidence: 0.5 // Lower confidence without external validation
    });
  }

  /**
   * Lookup detailed code information
   */
  async doLookupCode(code, systemKey) {
    const system = this.getSystem(systemKey);
    if (!system) {
      return QueryResult.error(`Unknown terminology system: ${systemKey}`);
    }

    // Check local data first
    const localResult = this.lookupLocal(code, systemKey);
    if (localResult) {
      return localResult;
    }

    // Query FHIR server if configured
    if (this.fhirEndpoint) {
      return this.queryFhirLookup(code, system);
    }

    return QueryResult.notFound({
      source: this.sourceId,
      version: this.sourceVersion
    });
  }

  /**
   * Search for codes by description
   */
  async doSearchCodes(text, systemKey, limit) {
    const system = this.getSystem(systemKey);
    if (!system) {
      return QueryResult.error(`Unknown terminology system: ${systemKey}`);
    }

    if (this.fhirEndpoint) {
      return this.queryFhirSearch(text, system, limit);
    }

    return QueryResult.notFound({
      source: this.sourceId,
      version: this.sourceVersion
    });
  }

  /**
   * Check if one code subsumes another (hierarchical relationship)
   */
  async doSubsumption(parentCode, childCode, systemKey) {
    const system = this.getSystem(systemKey);
    if (!system) {
      return QueryResult.error(`Unknown terminology system: ${systemKey}`);
    }

    if (this.fhirEndpoint) {
      return this.queryFhirSubsumes(parentCode, childCode, system);
    }

    return QueryResult.notFound({
      source: this.sourceId,
      version: this.sourceVersion
    });
  }

  /**
   * Get system definition
   */
  getSystem(key) {
    if (typeof key === 'string') {
      return TerminologySystems[key.toUpperCase().replace(/-/g, '_')] || null;
    }
    return key;
  }

  /**
   * Check local data for code
   */
  checkLocal(code, systemKey) {
    const key = `${systemKey}:${code}`;
    const data = this.terminologyData.get(key);

    if (data) {
      return QueryResult.found({
        valid: true,
        code,
        system: systemKey,
        display: data.display,
        definition: data.definition
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    return null;
  }

  /**
   * Lookup local data for code
   */
  lookupLocal(code, systemKey) {
    const key = `${systemKey}:${code}`;
    const data = this.terminologyData.get(key);

    if (data) {
      return QueryResult.found(data, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });
    }

    return null;
  }

  /**
   * Query FHIR $validate-code operation
   */
  async queryFhirValidate(code, system) {
    const url = new URL(`${this.fhirEndpoint}/CodeSystem/$validate-code`);
    url.searchParams.set('code', code);
    url.searchParams.set('url', system.system);

    try {
      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/fhir+json' },
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        return QueryResult.error(`FHIR server returned ${response.status}`);
      }

      const result = await response.json();
      const valid = result.parameter?.find(p => p.name === 'result')?.valueBoolean ?? false;
      const display = result.parameter?.find(p => p.name === 'display')?.valueString;

      return QueryResult.found({
        valid,
        code,
        system: system.name,
        display,
        fhirResponse: result
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });

    } catch (error) {
      return QueryResult.error(error);
    }
  }

  /**
   * Query FHIR $lookup operation
   */
  async queryFhirLookup(code, system) {
    const url = new URL(`${this.fhirEndpoint}/CodeSystem/$lookup`);
    url.searchParams.set('code', code);
    url.searchParams.set('system', system.system);

    try {
      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/fhir+json' },
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        if (response.status === 404) {
          return QueryResult.notFound();
        }
        return QueryResult.error(`FHIR server returned ${response.status}`);
      }

      const result = await response.json();

      return QueryResult.found({
        code,
        system: system.name,
        display: result.parameter?.find(p => p.name === 'display')?.valueString,
        definition: result.parameter?.find(p => p.name === 'definition')?.valueString,
        properties: result.parameter?.filter(p => p.name === 'property'),
        fhirResponse: result
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });

    } catch (error) {
      return QueryResult.error(error);
    }
  }

  /**
   * Query FHIR ValueSet $expand for search
   */
  async queryFhirSearch(text, system, limit) {
    const url = new URL(`${this.fhirEndpoint}/ValueSet/$expand`);
    url.searchParams.set('filter', text);
    url.searchParams.set('count', limit.toString());
    url.searchParams.set('system', system.system);

    try {
      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/fhir+json' },
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        return QueryResult.error(`FHIR server returned ${response.status}`);
      }

      const result = await response.json();
      const codes = result.expansion?.contains || [];

      return QueryResult.found({
        query: text,
        system: system.name,
        results: codes.map(c => ({
          code: c.code,
          display: c.display,
          system: c.system
        })),
        total: result.expansion?.total || codes.length
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });

    } catch (error) {
      return QueryResult.error(error);
    }
  }

  /**
   * Query FHIR $subsumes operation
   */
  async queryFhirSubsumes(parentCode, childCode, system) {
    const url = new URL(`${this.fhirEndpoint}/CodeSystem/$subsumes`);
    url.searchParams.set('codeA', parentCode);
    url.searchParams.set('codeB', childCode);
    url.searchParams.set('system', system.system);

    try {
      const response = await fetch(url.toString(), {
        headers: { 'Accept': 'application/fhir+json' },
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        return QueryResult.error(`FHIR server returned ${response.status}`);
      }

      const result = await response.json();
      const outcome = result.parameter?.find(p => p.name === 'outcome')?.valueCode;

      return QueryResult.found({
        parentCode,
        childCode,
        system: system.name,
        relationship: outcome, // 'subsumes', 'subsumed-by', 'equivalent', 'not-subsumed'
        subsumes: outcome === 'subsumes' || outcome === 'equivalent'
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 1.0
      });

    } catch (error) {
      return QueryResult.error(error);
    }
  }

  /**
   * Add local terminology data (for testing or embedded use)
   */
  addLocalCode(systemKey, code, display, definition = null, properties = {}) {
    const key = `${systemKey}:${code}`;
    this.terminologyData.set(key, {
      code,
      system: systemKey,
      display,
      definition,
      properties
    });
  }

  /**
   * Load bulk terminology data
   */
  loadTerminologyData(systemKey, codes) {
    for (const entry of codes) {
      this.addLocalCode(systemKey, entry.code, entry.display, entry.definition, entry.properties);
    }
    this.logger.info('Loaded terminology data', {
      system: systemKey,
      count: codes.length
    });
  }
}

export default TerminologyAdapter;
