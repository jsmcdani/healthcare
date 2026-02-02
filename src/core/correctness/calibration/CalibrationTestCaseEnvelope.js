/**
 * CalibrationTestCaseEnvelope - Contract for calibration test cases
 *
 * Test cases benchmark system outputs against known-correct (gold standard) answers.
 * Domain experts create and validate these test cases.
 */

import { z } from 'zod';
import { EnvelopeHeaderSchema, createEnvelopeHeader } from '../../contracts/EnvelopeHeader.js';
import { SchemaIds } from '../../contracts/schema-ids.js';

/**
 * Test case difficulty levels
 */
export const DifficultyLevelSchema = z.enum([
  'basic',         // Standard case, clear-cut answer
  'intermediate',  // Some complexity, common variations
  'advanced',      // Complex case, requires expertise
  'edge_case'      // Unusual scenario, boundary conditions
]).describe('Difficulty level of the test case');

export const DifficultyLevel = {
  BASIC: 'basic',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
  EDGE_CASE: 'edge_case'
};

/**
 * Clinical risk levels
 */
export const ClinicalRiskSchema = z.enum([
  'low',       // Informational, no direct patient impact
  'medium',    // Potential for suboptimal care
  'high',      // Potential for adverse outcome
  'critical'   // Potential for severe harm or death
]).describe('Clinical risk if test case is answered incorrectly');

export const ClinicalRisk = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Test case input
 */
export const TestCaseInputSchema = z.object({
  scenario: z.string().describe('Clinical scenario description'),
  data: z.record(z.any()).describe('Input data for the recipe/query'),
  recipeId: z.string().optional().describe('Target recipe to test'),
  queryType: z.string().optional().describe('Type of query being tested')
});

/**
 * Expected output (gold standard)
 */
export const ExpectedOutputSchema = z.object({
  value: z.any().describe('Expected answer/output'),
  source: z.string().describe('Where this answer came from (guideline, expert, literature)'),
  sourceReference: z.string().optional().describe('Citation or reference'),
  expertValidated: z.boolean().default(false),
  validatedBy: z.string().optional().describe('Expert who validated'),
  validatedAt: z.string().datetime().optional(),
  validationNotes: z.string().optional()
});

/**
 * Tolerance for correctness comparison
 */
export const ToleranceSchema = z.object({
  exactMatch: z.boolean().default(false)
    .describe('Require exact match'),
  numericTolerance: z.number().optional()
    .describe('Allowed deviation for numeric values'),
  percentTolerance: z.number().min(0).max(100).optional()
    .describe('Allowed percentage deviation'),
  semanticSimilarity: z.number().min(0).max(1).optional()
    .describe('Minimum semantic similarity for text'),
  setOverlap: z.number().min(0).max(1).optional()
    .describe('Minimum overlap for set comparisons'),
  customComparator: z.string().optional()
    .describe('Name of custom comparison function')
});

/**
 * Calibration Test Case Payload
 */
export const CalibrationTestCasePayloadSchema = z.object({
  testId: z.string().describe('Unique test case identifier'),
  name: z.string().describe('Human-readable test case name'),
  description: z.string().optional(),

  // Categorization
  category: z.string().describe('Test category (e.g., drug_interaction, lab_interpretation)'),
  subcategory: z.string().optional(),
  tags: z.array(z.string()).optional(),

  // Input
  input: TestCaseInputSchema,

  // Expected output (gold standard)
  expectedOutput: ExpectedOutputSchema,

  // Tolerance
  tolerance: ToleranceSchema.optional(),

  // Metadata
  difficulty: DifficultyLevelSchema,
  clinicalRisk: ClinicalRiskSchema,

  // Versioning
  version: z.string().default('1.0.0'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  createdBy: z.string().optional(),

  // Status
  status: z.enum(['active', 'deprecated', 'draft', 'review']).default('active')
});

/**
 * Full Calibration Test Case Envelope
 */
export const CalibrationTestCaseEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: CalibrationTestCasePayloadSchema,
  _meta: z.object({
    lastRunAt: z.string().datetime().optional(),
    lastRunResult: z.enum(['passed', 'failed', 'error', 'skipped']).optional(),
    runCount: z.number().int().default(0)
  }).optional()
});

/**
 * Create a calibration test case
 */
export function createCalibrationTestCase(options) {
  const {
    testId,
    name,
    description,
    category,
    subcategory,
    tags,
    input,
    expectedOutput,
    tolerance,
    difficulty,
    clinicalRisk,
    version = '1.0.0',
    createdBy,
    userId,
    sessionId,
    traceId
  } = options;

  const header = createEnvelopeHeader({
    schemaId: SchemaIds.CALIBRATION_TEST_CASE,
    schemaVersion: '1.0.0',
    userId,
    sessionId,
    action: 'create_test_case',
    source: 'CalibrationFramework',
    traceId
  });

  const now = new Date().toISOString();

  return {
    header,
    payload: {
      testId: testId || `test_${crypto.randomUUID().slice(0, 8)}`,
      name,
      description,
      category,
      subcategory,
      tags,
      input,
      expectedOutput: {
        ...expectedOutput,
        validatedAt: expectedOutput.validatedAt || (expectedOutput.expertValidated ? now : undefined)
      },
      tolerance: tolerance || { exactMatch: false },
      difficulty,
      clinicalRisk,
      version,
      createdAt: now,
      createdBy,
      status: 'active'
    },
    _meta: {
      runCount: 0
    }
  };
}

/**
 * Validate a calibration test case
 */
export function validateCalibrationTestCase(envelope) {
  return CalibrationTestCaseEnvelopeSchema.safeParse(envelope);
}

/**
 * Create a test case from a template
 */
export function createTestCaseFromTemplate(template, overrides = {}) {
  return createCalibrationTestCase({
    ...template,
    ...overrides,
    testId: overrides.testId || `${template.category}_${Date.now()}`
  });
}

export default CalibrationTestCaseEnvelopeSchema;
