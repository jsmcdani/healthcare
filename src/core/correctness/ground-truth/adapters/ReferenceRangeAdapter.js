/**
 * ReferenceRangeAdapter - Adapter for lab reference ranges
 *
 * Provides reference ranges for laboratory values, adjusted by:
 * - Age
 * - Sex
 * - Pregnancy status
 * - Race/ethnicity (where clinically relevant)
 */

import { BaseAdapter, QueryResult } from './BaseAdapter.js';

/**
 * Reference range flags
 */
export const RangeFlags = {
  NORMAL: 'normal',
  LOW: 'low',
  HIGH: 'high',
  CRITICAL_LOW: 'critical_low',
  CRITICAL_HIGH: 'critical_high',
  INDETERMINATE: 'indeterminate'
};

/**
 * Units of measure (common lab units)
 */
export const CommonUnits = {
  // Concentrations
  MG_DL: 'mg/dL',
  MMOL_L: 'mmol/L',
  G_DL: 'g/dL',
  NG_ML: 'ng/mL',
  PG_ML: 'pg/mL',
  MCG_DL: 'mcg/dL',
  MEQ_L: 'mEq/L',

  // Counts
  CELLS_MCL: 'cells/mcL',
  THOUSAND_MCL: 'x10^3/mcL',
  MILLION_MCL: 'x10^6/mcL',

  // Time
  SECONDS: 'seconds',

  // Ratio
  RATIO: 'ratio',
  PERCENT: '%',

  // Other
  UNITS_L: 'U/L',
  IU_ML: 'IU/mL'
};

/**
 * Reference Range Adapter
 */
export class ReferenceRangeAdapter extends BaseAdapter {
  constructor(config) {
    super(config);

    // Reference range data organized by test
    this.referenceRanges = new Map();

    // Load default ranges if provided
    if (config.defaultRanges) {
      this.loadDefaultRanges(config.defaultRanges);
    }
  }

  /**
   * Query implementation
   */
  async query(queryType, params) {
    return this.executeWithWrapper(queryType, params, async () => {
      switch (queryType) {
        case 'evaluate':
          return this.doEvaluateValue(params.test, params.value, params.unit, params.patient);
        case 'get_range':
          return this.doGetRange(params.test, params.patient);
        case 'list_tests':
          return this.doListTests();
        default:
          throw new Error(`Unknown query type: ${queryType}`);
      }
    });
  }

  /**
   * Evaluate a lab value against reference range
   */
  async evaluateValue(test, value, unit, patientContext = {}) {
    return this.query('evaluate', { test, value, unit, patient: patientContext });
  }

  /**
   * Get reference range for a test
   */
  async getRange(test, patientContext = {}) {
    return this.query('get_range', { test, patient: patientContext });
  }

  /**
   * List available tests
   */
  async listTests() {
    return this.query('list_tests', {});
  }

  /**
   * Evaluate value implementation
   */
  async doEvaluateValue(test, value, unit, patient) {
    const testKey = this.normalizeTestName(test);
    const ranges = this.referenceRanges.get(testKey);

    if (!ranges) {
      return QueryResult.notFound({
        source: this.sourceId,
        version: this.sourceVersion
      });
    }

    // Find applicable range based on patient context
    const applicableRange = this.findApplicableRange(ranges, patient);

    if (!applicableRange) {
      return QueryResult.found({
        test: testKey,
        value,
        unit,
        flag: RangeFlags.INDETERMINATE,
        message: 'No applicable reference range for patient demographics'
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 0.5
      });
    }

    // Convert units if needed
    const normalizedValue = this.convertUnits(value, unit, applicableRange.unit);
    if (normalizedValue === null) {
      return QueryResult.found({
        test: testKey,
        value,
        unit,
        flag: RangeFlags.INDETERMINATE,
        message: `Cannot convert from ${unit} to ${applicableRange.unit}`
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 0.3
      });
    }

    // Evaluate against range
    const flag = this.evaluateAgainstRange(normalizedValue, applicableRange);

    return QueryResult.found({
      test: testKey,
      value: normalizedValue,
      unit: applicableRange.unit,
      originalValue: value,
      originalUnit: unit,
      referenceRange: {
        low: applicableRange.low,
        high: applicableRange.high,
        criticalLow: applicableRange.criticalLow,
        criticalHigh: applicableRange.criticalHigh,
        unit: applicableRange.unit
      },
      flag,
      isNormal: flag === RangeFlags.NORMAL,
      isCritical: flag === RangeFlags.CRITICAL_LOW || flag === RangeFlags.CRITICAL_HIGH,
      applicableTo: applicableRange.applicableTo,
      interpretation: this.getInterpretation(flag, testKey, normalizedValue, applicableRange)
    }, {
      source: this.sourceId,
      version: this.sourceVersion,
      confidence: 1.0
    });
  }

  /**
   * Get range implementation
   */
  async doGetRange(test, patient) {
    const testKey = this.normalizeTestName(test);
    const ranges = this.referenceRanges.get(testKey);

    if (!ranges) {
      return QueryResult.notFound({
        source: this.sourceId,
        version: this.sourceVersion
      });
    }

    const applicableRange = this.findApplicableRange(ranges, patient);

    if (!applicableRange) {
      // Return all ranges if no specific match
      return QueryResult.found({
        test: testKey,
        ranges: ranges.ranges,
        selectedRange: null,
        message: 'Multiple ranges available, patient context needed for selection'
      }, {
        source: this.sourceId,
        version: this.sourceVersion,
        confidence: 0.7
      });
    }

    return QueryResult.found({
      test: testKey,
      ranges: ranges.ranges,
      selectedRange: applicableRange,
      unit: applicableRange.unit
    }, {
      source: this.sourceId,
      version: this.sourceVersion,
      confidence: 1.0
    });
  }

  /**
   * List tests implementation
   */
  async doListTests() {
    const tests = [];

    for (const [key, data] of this.referenceRanges.entries()) {
      tests.push({
        code: key,
        name: data.name,
        loincCode: data.loincCode,
        category: data.category,
        unit: data.ranges[0]?.unit
      });
    }

    return QueryResult.found({
      tests,
      count: tests.length
    }, {
      source: this.sourceId,
      version: this.sourceVersion,
      confidence: 1.0
    });
  }

  /**
   * Normalize test name for lookup
   */
  normalizeTestName(test) {
    return test.toLowerCase().replace(/[^a-z0-9]/g, '_');
  }

  /**
   * Find applicable range based on patient demographics
   */
  findApplicableRange(testData, patient) {
    const ranges = testData.ranges;

    // Score each range by how well it matches the patient
    let bestMatch = null;
    let bestScore = -1;

    for (const range of ranges) {
      let score = 0;
      let applicable = true;

      // Check age
      if (range.applicableTo?.ageMin !== undefined && patient.age !== undefined) {
        if (patient.age < range.applicableTo.ageMin) {
          applicable = false;
        } else {
          score += 1;
        }
      }
      if (range.applicableTo?.ageMax !== undefined && patient.age !== undefined) {
        if (patient.age > range.applicableTo.ageMax) {
          applicable = false;
        } else {
          score += 1;
        }
      }

      // Check sex
      if (range.applicableTo?.sex && patient.sex) {
        if (range.applicableTo.sex !== 'any' && range.applicableTo.sex !== patient.sex) {
          applicable = false;
        } else if (range.applicableTo.sex === patient.sex) {
          score += 2; // Sex-specific ranges are more precise
        }
      }

      // Check pregnancy
      if (range.applicableTo?.pregnant !== undefined && patient.pregnant !== undefined) {
        if (range.applicableTo.pregnant !== patient.pregnant) {
          applicable = false;
        } else if (range.applicableTo.pregnant) {
          score += 3; // Pregnancy ranges are very specific
        }
      }

      // Default range (no restrictions)
      if (!range.applicableTo || Object.keys(range.applicableTo).length === 0) {
        score = 0; // Lowest priority
        applicable = true;
      }

      if (applicable && score > bestScore) {
        bestMatch = range;
        bestScore = score;
      }
    }

    return bestMatch;
  }

  /**
   * Convert units (basic implementation)
   */
  convertUnits(value, fromUnit, toUnit) {
    if (fromUnit === toUnit) {
      return value;
    }

    // Common conversions
    const conversions = {
      // Glucose
      'mg/dL->mmol/L': v => v / 18.0182,
      'mmol/L->mg/dL': v => v * 18.0182,

      // Creatinine
      'mg/dL->μmol/L': v => v * 88.42,
      'μmol/L->mg/dL': v => v / 88.42,

      // Hemoglobin
      'g/dL->g/L': v => v * 10,
      'g/L->g/dL': v => v / 10,

      // Percentage conversions
      '%->ratio': v => v / 100,
      'ratio->%': v => v * 100
    };

    const conversionKey = `${fromUnit}->${toUnit}`;
    const converter = conversions[conversionKey];

    if (converter) {
      return converter(value);
    }

    // Try reverse
    const reverseKey = `${toUnit}->${fromUnit}`;
    const reverseConverter = conversions[reverseKey];
    if (reverseConverter) {
      // Apply inverse (this is a simplification)
      return null; // Cannot reliably invert all conversions
    }

    return null; // Unknown conversion
  }

  /**
   * Evaluate value against range
   */
  evaluateAgainstRange(value, range) {
    // Check critical values first
    if (range.criticalLow !== undefined && value < range.criticalLow) {
      return RangeFlags.CRITICAL_LOW;
    }
    if (range.criticalHigh !== undefined && value > range.criticalHigh) {
      return RangeFlags.CRITICAL_HIGH;
    }

    // Check normal range
    if (range.low !== undefined && value < range.low) {
      return RangeFlags.LOW;
    }
    if (range.high !== undefined && value > range.high) {
      return RangeFlags.HIGH;
    }

    return RangeFlags.NORMAL;
  }

  /**
   * Get interpretation text
   */
  getInterpretation(flag, test, value, range) {
    switch (flag) {
      case RangeFlags.CRITICAL_LOW:
        return `CRITICAL: ${test} is critically low at ${value} ${range.unit} (critical threshold: ${range.criticalLow})`;
      case RangeFlags.CRITICAL_HIGH:
        return `CRITICAL: ${test} is critically high at ${value} ${range.unit} (critical threshold: ${range.criticalHigh})`;
      case RangeFlags.LOW:
        return `${test} is below normal at ${value} ${range.unit} (normal: ${range.low}-${range.high})`;
      case RangeFlags.HIGH:
        return `${test} is above normal at ${value} ${range.unit} (normal: ${range.low}-${range.high})`;
      case RangeFlags.NORMAL:
        return `${test} is within normal limits at ${value} ${range.unit}`;
      default:
        return `${test} value: ${value} ${range.unit}`;
    }
  }

  /**
   * Add a reference range for a test
   */
  addReferenceRange(testCode, testData) {
    const key = this.normalizeTestName(testCode);
    this.referenceRanges.set(key, {
      name: testData.name || testCode,
      loincCode: testData.loincCode,
      category: testData.category,
      ranges: testData.ranges || []
    });
  }

  /**
   * Load default reference ranges
   */
  loadDefaultRanges(ranges) {
    for (const [code, data] of Object.entries(ranges)) {
      this.addReferenceRange(code, data);
    }
    this.logger.info('Loaded reference ranges', { count: Object.keys(ranges).length });
  }

  /**
   * Get common reference ranges (for initialization)
   */
  static getCommonReferenceRanges() {
    return {
      'glucose': {
        name: 'Blood Glucose',
        loincCode: '2345-7',
        category: 'chemistry',
        ranges: [
          {
            low: 70, high: 100, criticalLow: 50, criticalHigh: 400,
            unit: 'mg/dL',
            applicableTo: { fasting: true }
          },
          {
            low: 70, high: 140,
            unit: 'mg/dL',
            applicableTo: { fasting: false }
          }
        ]
      },
      'creatinine': {
        name: 'Serum Creatinine',
        loincCode: '2160-0',
        category: 'chemistry',
        ranges: [
          { low: 0.7, high: 1.3, unit: 'mg/dL', applicableTo: { sex: 'male' } },
          { low: 0.6, high: 1.1, unit: 'mg/dL', applicableTo: { sex: 'female' } }
        ]
      },
      'hemoglobin': {
        name: 'Hemoglobin',
        loincCode: '718-7',
        category: 'hematology',
        ranges: [
          { low: 13.5, high: 17.5, criticalLow: 7, criticalHigh: 20, unit: 'g/dL', applicableTo: { sex: 'male' } },
          { low: 12.0, high: 16.0, criticalLow: 7, criticalHigh: 20, unit: 'g/dL', applicableTo: { sex: 'female' } },
          { low: 11.0, high: 14.0, unit: 'g/dL', applicableTo: { sex: 'female', pregnant: true } }
        ]
      },
      'potassium': {
        name: 'Serum Potassium',
        loincCode: '2823-3',
        category: 'chemistry',
        ranges: [
          { low: 3.5, high: 5.0, criticalLow: 2.5, criticalHigh: 6.5, unit: 'mEq/L' }
        ]
      },
      'sodium': {
        name: 'Serum Sodium',
        loincCode: '2951-2',
        category: 'chemistry',
        ranges: [
          { low: 136, high: 145, criticalLow: 120, criticalHigh: 160, unit: 'mEq/L' }
        ]
      },
      'wbc': {
        name: 'White Blood Cell Count',
        loincCode: '6690-2',
        category: 'hematology',
        ranges: [
          { low: 4.5, high: 11.0, criticalLow: 2.0, criticalHigh: 30.0, unit: 'x10^3/mcL' }
        ]
      },
      'platelets': {
        name: 'Platelet Count',
        loincCode: '777-3',
        category: 'hematology',
        ranges: [
          { low: 150, high: 400, criticalLow: 50, criticalHigh: 1000, unit: 'x10^3/mcL' }
        ]
      },
      'hba1c': {
        name: 'Hemoglobin A1c',
        loincCode: '4548-4',
        category: 'chemistry',
        ranges: [
          { low: 4.0, high: 5.6, unit: '%', applicableTo: { diabetic: false } },
          { low: 4.0, high: 7.0, unit: '%', applicableTo: { diabetic: true } }
        ]
      },
      'egfr': {
        name: 'Estimated GFR',
        loincCode: '33914-3',
        category: 'chemistry',
        ranges: [
          { low: 90, high: 999, unit: 'mL/min/1.73m2' }
        ]
      },
      'alt': {
        name: 'Alanine Aminotransferase',
        loincCode: '1742-6',
        category: 'chemistry',
        ranges: [
          { low: 7, high: 56, unit: 'U/L' }
        ]
      }
    };
  }
}

export default ReferenceRangeAdapter;
