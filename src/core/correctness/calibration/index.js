/**
 * Calibration Module - Barrel export
 */

export {
  CalibrationFramework,
  ComparisonStrategy
} from './CalibrationFramework.js';

export {
  CalibrationTestCaseEnvelopeSchema,
  CalibrationTestCasePayloadSchema,
  DifficultyLevel,
  DifficultyLevelSchema,
  ClinicalRisk,
  ClinicalRiskSchema,
  TestCaseInputSchema,
  ExpectedOutputSchema,
  ToleranceSchema,
  createCalibrationTestCase,
  createTestCaseFromTemplate,
  validateCalibrationTestCase
} from './CalibrationTestCaseEnvelope.js';

export {
  CalibrationRunEnvelopeSchema,
  CalibrationRunPayloadSchema,
  TestResultSchema,
  RunSummarySchema,
  TrendSchema,
  createCalibrationRun,
  calculateRunSummary,
  compareWithPriorRun,
  validateCalibrationRun
} from './CalibrationRunEnvelope.js';
