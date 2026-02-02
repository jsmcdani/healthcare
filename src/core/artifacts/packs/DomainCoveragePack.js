/**
 * DomainCoveragePack - Pack for domain coverage analysis
 *
 * Tracks coverage of domain concepts, fields, and capabilities.
 */

import { z } from 'zod';
import { FeaturePackPayloadSchema, createFeaturePack } from '../FeaturePackEnvelope.js';
import { registerSchema, SchemaIds } from '../../contracts/registry.js';

/**
 * Coverage status
 */
export const CoverageStatusSchema = z.enum([
  'full',       // 100% covered
  'partial',    // Some coverage
  'minimal',    // Basic coverage only
  'none',       // No coverage
  'unknown'     // Cannot determine
]);

/**
 * Coverage item - a single coverage entry
 */
export const CoverageItemSchema = z.object({
  domainId: z.string().describe('Domain concept identifier'),
  domainName: z.string(),
  category: z.string().optional().describe('Domain category'),
  parentDomainId: z.string().optional().describe('Parent domain if hierarchical'),
  status: CoverageStatusSchema,
  coveragePercent: z.number().min(0).max(100),
  metrics: z.object({
    totalElements: z.number().describe('Total elements in domain'),
    coveredElements: z.number().describe('Elements with coverage'),
    uncoveredElements: z.number().optional(),
    partialElements: z.number().optional()
  }),
  gaps: z.array(z.object({
    gapId: z.string(),
    description: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    recommendation: z.string().optional()
  })).optional(),
  lastAssessedAt: z.string().datetime().optional(),
  trend: z.enum(['improving', 'stable', 'declining']).optional()
});

/**
 * Domain Coverage Pack specific payload
 */
export const DomainCoveragePackPayloadSchema = FeaturePackPayloadSchema.extend({
  packType: z.literal('domain_coverage'),
  items: z.array(CoverageItemSchema),
  targetCoverage: z.number().min(0).max(100).optional().describe('Target coverage percentage'),
  assessmentCriteria: z.object({
    fullThreshold: z.number().default(95),
    partialThreshold: z.number().default(50),
    minimalThreshold: z.number().default(20)
  }).optional(),
  aggregations: z.object({
    totalDomains: z.number(),
    overallCoveragePercent: z.number(),
    byStatus: z.record(z.number()),
    byCategory: z.record(z.object({
      count: z.number(),
      averageCoverage: z.number()
    })).optional(),
    totalGaps: z.number(),
    criticalGaps: z.number()
  }).optional()
});

/**
 * Create a domain coverage pack
 */
export function createDomainCoveragePack(options) {
  const pack = createFeaturePack({
    ...options,
    packType: 'domain_coverage',
    items: options.items || []
  });

  pack.payload.packType = 'domain_coverage';
  if (options.targetCoverage) {
    pack.payload.targetCoverage = options.targetCoverage;
  }
  if (options.assessmentCriteria) {
    pack.payload.assessmentCriteria = options.assessmentCriteria;
  }

  // Compute aggregations
  const items = pack.payload.items;
  const byStatus = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  const byCategory = {};
  items.forEach(item => {
    const cat = item.category || 'uncategorized';
    if (!byCategory[cat]) {
      byCategory[cat] = { count: 0, totalCoverage: 0 };
    }
    byCategory[cat].count++;
    byCategory[cat].totalCoverage += item.coveragePercent;
  });

  Object.keys(byCategory).forEach(cat => {
    byCategory[cat].averageCoverage = byCategory[cat].totalCoverage / byCategory[cat].count;
    delete byCategory[cat].totalCoverage;
  });

  const totalGaps = items.reduce((sum, item) => sum + (item.gaps?.length || 0), 0);
  const criticalGaps = items.reduce((sum, item) => {
    return sum + (item.gaps?.filter(g => g.severity === 'critical').length || 0);
  }, 0);

  pack.payload.aggregations = {
    totalDomains: items.length,
    overallCoveragePercent: items.length > 0
      ? items.reduce((sum, item) => sum + item.coveragePercent, 0) / items.length
      : 0,
    byStatus,
    byCategory,
    totalGaps,
    criticalGaps
  };

  return pack;
}

/**
 * Add coverage item
 */
export function addCoverageItem(pack, item) {
  if (pack.payload.status !== 'draft') {
    throw new Error('Cannot modify non-draft pack');
  }

  // Auto-calculate status based on coverage percent
  const criteria = pack.payload.assessmentCriteria || {
    fullThreshold: 95,
    partialThreshold: 50,
    minimalThreshold: 20
  };

  let status = 'none';
  if (item.coveragePercent >= criteria.fullThreshold) status = 'full';
  else if (item.coveragePercent >= criteria.partialThreshold) status = 'partial';
  else if (item.coveragePercent >= criteria.minimalThreshold) status = 'minimal';

  const completeItem = {
    ...item,
    status: item.status || status
  };

  pack.payload.items.push(completeItem);
  pack.payload.itemCount = pack.payload.items.length;
  pack.payload.updatedAt = new Date().toISOString();

  return completeItem;
}

/**
 * Get coverage gaps
 */
export function getCoverageGaps(pack, severityFilter = null) {
  const gaps = [];
  pack.payload.items.forEach(item => {
    if (item.gaps) {
      item.gaps.forEach(gap => {
        if (!severityFilter || gap.severity === severityFilter) {
          gaps.push({
            domainId: item.domainId,
            domainName: item.domainName,
            ...gap
          });
        }
      });
    }
  });
  return gaps;
}

/**
 * Get domains below target coverage
 */
export function getUndercoveredDomains(pack) {
  const target = pack.payload.targetCoverage || 80;
  return pack.payload.items.filter(item => item.coveragePercent < target);
}

/**
 * Validate a domain coverage pack
 */
export function validateDomainCoveragePack(pack) {
  return DomainCoveragePackPayloadSchema.safeParse(pack.payload);
}

// Register schema on load
try {
  registerSchema(SchemaIds.PACK_COVERAGE, '1.0.0', DomainCoveragePackPayloadSchema);
} catch (e) {
  // Already registered
}

export default DomainCoveragePackPayloadSchema;
