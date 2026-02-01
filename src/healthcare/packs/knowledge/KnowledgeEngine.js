/**
 * Knowledge Engine
 * Provides domain knowledge, heuristics, and institutional memory
 * for healthcare-specific reasoning
 */

import { Logger } from '../../../utils/logger.js';

export class KnowledgeEngine {
  constructor(options = {}) {
    this.logger = new Logger('KnowledgeEngine');
    this.knowledgeBases = new Map();
    this.graphService = options.graphService;
    this.heuristics = new Map();
    this.initialized = false;
  }

  /**
   * Initialize with graph service for persistence
   */
  async initialize(graphService) {
    this.graphService = graphService;
    await this.loadBuiltInHeuristics();
    this.initialized = true;
  }

  /**
   * Load built-in healthcare heuristics
   */
  async loadBuiltInHeuristics() {
    const heuristics = [
      // PHI Detection Heuristics
      {
        key: 'phi_field_patterns',
        category: 'phi_detection',
        type: 'pattern',
        content: {
          patterns: [
            { regex: '^Patient.*Name$', classification: 'PATIENT_NAME', confidence: 0.95 },
            { regex: '^(DOB|DateOfBirth|BirthDate)$', classification: 'DATE_OF_BIRTH', confidence: 0.95 },
            { regex: 'SSN|SocialSecurity', classification: 'SSN', confidence: 0.99 },
            { regex: '^MRN|MedicalRecord', classification: 'MEDICAL_RECORD_NUMBER', confidence: 0.95 },
            { regex: 'Diagnosis|ICD|DxCode', classification: 'DIAGNOSIS', confidence: 0.90 },
            { regex: 'Prescription|RxNumber', classification: 'PRESCRIPTION', confidence: 0.90 },
            { regex: 'LabResult|TestResult', classification: 'LAB_RESULT', confidence: 0.85 },
            { regex: 'Treatment|Procedure', classification: 'TREATMENT', confidence: 0.85 }
          ]
        }
      },
      // Healthcare Object Patterns
      {
        key: 'healthcare_objects',
        category: 'schema_patterns',
        type: 'guidance',
        content: {
          commonObjects: [
            { pattern: 'Patient', sensitivity: 'PHI', description: 'Patient demographic and clinical data' },
            { pattern: 'Encounter', sensitivity: 'PHI', description: 'Patient visits and interactions' },
            { pattern: 'Diagnosis', sensitivity: 'PHI', description: 'Clinical diagnoses' },
            { pattern: 'Medication', sensitivity: 'PHI', description: 'Prescribed medications' },
            { pattern: 'Insurance', sensitivity: 'CONFIDENTIAL', description: 'Insurance and payer info' },
            { pattern: 'Provider', sensitivity: 'INTERNAL', description: 'Healthcare provider info' },
            { pattern: 'Facility', sensitivity: 'PUBLIC', description: 'Healthcare facility data' }
          ]
        }
      },
      // Automation Best Practices
      {
        key: 'automation_constraints',
        category: 'best_practices',
        type: 'constraint',
        content: {
          rules: [
            'PHI fields should not be used in formula fields without encryption consideration',
            'Flows processing PHI should have explicit audit logging',
            'Batch operations on PHI should be scheduled during off-hours',
            'PHI should not be displayed in list views without explicit business need',
            'Validation rules on PHI fields should not expose data in error messages'
          ]
        }
      },
      // Migration Checklist
      {
        key: 'migration_checklist',
        category: 'migration',
        type: 'guidance',
        content: {
          phases: [
            {
              name: 'Pre-Migration',
              items: [
                'Identify all PHI fields and their dependencies',
                'Document current data retention policies',
                'Map field-level security configurations',
                'Audit current automation for PHI handling'
              ]
            },
            {
              name: 'Data Mapping',
              items: [
                'Verify PHI field mappings maintain encryption',
                'Confirm no PHI in formula fields',
                'Check lookup relationships for data exposure',
                'Validate sharing rules don\'t expose PHI'
              ]
            },
            {
              name: 'Testing',
              items: [
                'Test with synthetic PHI data only',
                'Verify audit trails are captured',
                'Confirm access controls are enforced',
                'Validate data masking in lower environments'
              ]
            }
          ]
        }
      },
      // Clinical Hours Definition
      {
        key: 'clinical_hours',
        category: 'operational',
        type: 'configuration',
        content: {
          standard: {
            start: '06:00',
            end: '22:00',
            timezone: 'America/New_York',
            daysOfWeek: [1, 2, 3, 4, 5]
          },
          emergency: {
            description: 'Emergency access available 24/7 with approval',
            requiresApproval: true,
            auditLevel: 'full'
          },
          maintenanceWindow: {
            preferredDay: 0,  // Sunday
            preferredStart: '02:00',
            preferredEnd: '06:00'
          }
        }
      }
    ];

    for (const h of heuristics) {
      this.heuristics.set(h.key, h);
    }

    this.logger.info(`Loaded ${heuristics.length} built-in heuristics`);
  }

  /**
   * Load a knowledge base
   */
  async loadKnowledgeBase(name, entries) {
    const kb = {
      name,
      entries: new Map(),
      loadedAt: new Date().toISOString()
    };

    for (const entry of entries) {
      kb.entries.set(entry.key, {
        ...entry,
        loadedAt: kb.loadedAt
      });
    }

    this.knowledgeBases.set(name, kb);
    this.logger.info(`Loaded knowledge base: ${name} with ${entries.length} entries`);

    return kb;
  }

  /**
   * Get relevant knowledge for a task
   */
  async getRelevantKnowledge(taskType, context) {
    const relevant = [];

    // Search heuristics
    for (const [key, heuristic] of this.heuristics) {
      const relevance = this.calculateRelevance(heuristic, taskType, context);
      if (relevance > 0.3) {
        relevant.push({
          key,
          ...heuristic,
          relevance,
          source: 'heuristics'
        });
      }
    }

    // Search knowledge bases
    for (const [kbName, kb] of this.knowledgeBases) {
      for (const [key, entry] of kb.entries) {
        const relevance = this.calculateRelevance(entry, taskType, context);
        if (relevance > 0.3) {
          relevant.push({
            key,
            ...entry,
            relevance,
            source: kbName
          });
        }
      }
    }

    // Search graph for knowledge entries if available
    if (this.graphService) {
      try {
        const graphKnowledge = await this.searchGraphKnowledge(taskType, context);
        relevant.push(...graphKnowledge);
      } catch (e) {
        this.logger.debug('Graph knowledge search failed:', e.message);
      }
    }

    // Sort by relevance
    relevant.sort((a, b) => b.relevance - a.relevance);

    return relevant;
  }

  /**
   * Calculate relevance of knowledge to task
   */
  calculateRelevance(knowledge, taskType, context) {
    let relevance = 0;
    const category = knowledge.category || '';
    const tags = knowledge.tags || [];

    // Category matching
    if (taskType.includes('phi') && category.includes('phi')) relevance += 0.4;
    if (taskType.includes('migration') && category.includes('migration')) relevance += 0.4;
    if (taskType.includes('schema') && category.includes('schema')) relevance += 0.3;
    if (taskType.includes('automation') && category.includes('automation')) relevance += 0.3;

    // Context matching
    if (context.hasPHI && category.includes('phi')) relevance += 0.3;
    if (context.isMigration && category.includes('migration')) relevance += 0.3;

    // Tag matching
    for (const tag of tags) {
      if (taskType.includes(tag) || JSON.stringify(context).includes(tag)) {
        relevance += 0.1;
      }
    }

    return Math.min(relevance, 1.0);
  }

  /**
   * Search graph for knowledge entries
   */
  async searchGraphKnowledge(taskType, context) {
    if (!this.graphService) return [];

    try {
      // Query for knowledge entries related to task type
      const results = await this.graphService.client.query(
        `g.V().hasLabel('KnowledgeEntry')
          .has('category', within('${taskType}', 'general'))
          .limit(10)`
      );

      return results.map(v => ({
        key: v.properties?.key?.[0]?.value,
        category: v.properties?.category?.[0]?.value,
        content: v.properties?.content?.[0]?.value,
        relevance: 0.5,
        source: 'graph'
      }));
    } catch (e) {
      return [];
    }
  }

  /**
   * Get PHI detection patterns
   */
  getPHIPatterns() {
    const phiHeuristic = this.heuristics.get('phi_field_patterns');
    return phiHeuristic?.content?.patterns || [];
  }

  /**
   * Detect PHI in a field name
   */
  detectPHI(fieldName) {
    const patterns = this.getPHIPatterns();

    for (const pattern of patterns) {
      if (new RegExp(pattern.regex, 'i').test(fieldName)) {
        return {
          isPHI: true,
          classification: pattern.classification,
          confidence: pattern.confidence
        };
      }
    }

    return { isPHI: false, classification: null, confidence: 0 };
  }

  /**
   * Get guidance for a specific category
   */
  getGuidance(category) {
    const guidance = [];

    for (const [key, h] of this.heuristics) {
      if (h.category === category && h.type === 'guidance') {
        guidance.push(h.content);
      }
    }

    return guidance;
  }

  /**
   * Get constraints for a context
   */
  getConstraints(context) {
    const constraints = [];

    for (const [key, h] of this.heuristics) {
      if (h.type === 'constraint') {
        // Check if constraint applies to context
        if (context.hasPHI && h.category.includes('phi')) {
          constraints.push(...(h.content.rules || []));
        }
        if (context.isMigration && h.category.includes('migration')) {
          constraints.push(...(h.content.rules || []));
        }
      }
    }

    return [...new Set(constraints)];  // Dedupe
  }

  /**
   * Add a knowledge entry
   */
  async addKnowledgeEntry(entry) {
    const { key, category, content, source, tags } = entry;

    // Store in graph if available
    if (this.graphService) {
      await this.graphService.addKnowledgeEntry({
        key,
        category,
        content: JSON.stringify(content),
        source: source || 'runtime',
        tags: tags?.join(',')
      });
    }

    // Also store in memory
    const kb = this.knowledgeBases.get('runtime') || {
      name: 'runtime',
      entries: new Map(),
      loadedAt: new Date().toISOString()
    };

    kb.entries.set(key, {
      key,
      category,
      content,
      source: source || 'runtime',
      tags,
      addedAt: new Date().toISOString()
    });

    this.knowledgeBases.set('runtime', kb);

    return entry;
  }

  /**
   * Get clinical hours configuration
   */
  getClinicalHoursConfig() {
    return this.heuristics.get('clinical_hours')?.content;
  }

  /**
   * Check if current time is within clinical hours
   */
  isWithinClinicalHours() {
    const config = this.getClinicalHoursConfig();
    if (!config) return false;

    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dayOfWeek = now.getDay();

    const [startHour, startMin] = config.standard.start.split(':').map(Number);
    const [endHour, endMin] = config.standard.end.split(':').map(Number);

    const currentMinutes = hour * 60 + minute;
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    const isWithinTime = currentMinutes >= startMinutes && currentMinutes < endMinutes;
    const isWorkday = config.standard.daysOfWeek.includes(dayOfWeek);

    return isWithinTime && isWorkday;
  }

  /**
   * Get statistics
   */
  getStats() {
    let totalEntries = 0;
    for (const kb of this.knowledgeBases.values()) {
      totalEntries += kb.entries.size;
    }

    return {
      heuristics: this.heuristics.size,
      knowledgeBases: this.knowledgeBases.size,
      totalEntries,
      initialized: this.initialized
    };
  }
}

export default KnowledgeEngine;
