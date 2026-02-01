/**
 * Healthcare Graph Schema
 * Defines vertex labels, edge labels, and property schemas
 * for the Metalligent Healthcare graph database
 */

export const VertexLabels = {
  // Core Healthcare Entities
  PATIENT: 'Patient',
  ENCOUNTER: 'Encounter',
  DIAGNOSIS: 'Diagnosis',
  MEDICATION: 'Medication',
  LAB_RESULT: 'LabResult',
  PROCEDURE: 'Procedure',
  PROVIDER: 'Provider',
  FACILITY: 'Facility',
  INSURANCE: 'Insurance',
  ALLERGY: 'Allergy',
  VITAL_SIGNS: 'VitalSigns',
  CLINICAL_NOTE: 'ClinicalNote',
  APPOINTMENT: 'Appointment',

  // Healthcare Pack Entities
  POLICY_RULE: 'PolicyRule',
  KNOWLEDGE_ENTRY: 'KnowledgeEntry',
  RECIPE: 'Recipe',

  // Reasoning Entities
  DECISION_ARTIFACT: 'DecisionArtifact',
  AUDIT_ENTRY: 'AuditEntry',
  REASON: 'Reason'
};

export const EdgeLabels = {
  // Patient Relationships
  HAS_ENCOUNTER: 'HAS_ENCOUNTER',
  HAS_DIAGNOSIS: 'HAS_DIAGNOSIS',
  PRESCRIBED: 'PRESCRIBED',
  HAS_LAB_RESULT: 'HAS_LAB_RESULT',
  UNDERWENT: 'UNDERWENT',
  HAS_ALLERGY: 'HAS_ALLERGY',
  HAS_VITALS: 'HAS_VITALS',
  HAS_INSURANCE: 'HAS_INSURANCE',
  HAS_APPOINTMENT: 'HAS_APPOINTMENT',
  HAS_NOTE: 'HAS_NOTE',

  // Encounter Relationships
  AT_FACILITY: 'AT_FACILITY',
  ATTENDED_BY: 'ATTENDED_BY',
  RESULTED_IN: 'RESULTED_IN',
  INCLUDED: 'INCLUDED',
  ORDERED: 'ORDERED',
  RECORDED: 'RECORDED',

  // Provider Relationships
  WORKS_AT: 'WORKS_AT',
  PERFORMED: 'PERFORMED',
  AUTHORED: 'AUTHORED',

  // Clinical Relationships
  TREATED_WITH: 'TREATED_WITH',
  MONITORED_BY: 'MONITORED_BY',
  CONTRAINDICATED_BY: 'CONTRAINDICATED_BY',
  REQUIRES: 'REQUIRES',

  // Policy & Governance
  GOVERNED_BY: 'GOVERNED_BY',
  REQUIRES_APPROVAL: 'REQUIRES_APPROVAL',
  CLASSIFIED_AS: 'CLASSIFIED_AS',

  // Knowledge & Reasoning
  INFORMED_BY: 'INFORMED_BY',
  DERIVED_FROM: 'DERIVED_FROM',
  SUPPORTS: 'SUPPORTS',

  // Execution
  EXECUTED_VIA: 'EXECUTED_VIA',
  PRODUCED: 'PRODUCED'
};

/**
 * Property schemas for each vertex type
 */
export const VertexSchemas = {
  Patient: {
    required: ['id', 'patientId'],
    optional: ['firstName', 'lastName', 'middleName', 'dateOfBirth', 'gender',
               'ssn', 'address', 'city', 'state', 'zip', 'phone', 'email',
               'emergencyContact', 'primaryLanguage', 'maritalStatus', 'race', 'ethnicity',
               'sensitivity'],
    indexed: ['patientId', 'lastName', 'dateOfBirth'],
    phiFields: ['firstName', 'lastName', 'ssn', 'address', 'phone', 'email', 'dateOfBirth']
  },

  Encounter: {
    required: ['id', 'encounterId', 'patientId'],
    optional: ['encounterType', 'admitDate', 'dischargeDate', 'chiefComplaint',
               'status', 'facilityId', 'attendingProviderId', 'sensitivity'],
    indexed: ['encounterId', 'patientId', 'encounterType', 'status', 'admitDate']
  },

  Diagnosis: {
    required: ['id', 'diagnosisId', 'icdCode'],
    optional: ['description', 'diagnosisDate', 'status', 'severity', 'isPrimary',
               'patientId', 'encounterId', 'sensitivity'],
    indexed: ['diagnosisId', 'icdCode', 'patientId', 'status']
  },

  Medication: {
    required: ['id', 'medicationId'],
    optional: ['rxNormCode', 'name', 'genericName', 'dosage', 'unit', 'frequency',
               'route', 'startDate', 'endDate', 'status', 'patientId', 'prescriberId',
               'forDiagnosisId', 'sensitivity'],
    indexed: ['medicationId', 'rxNormCode', 'patientId', 'status']
  },

  LabResult: {
    required: ['id', 'labResultId'],
    optional: ['loincCode', 'testName', 'value', 'unit', 'referenceRange', 'status',
               'collectionDate', 'resultDate', 'patientId', 'encounterId',
               'orderingProviderId', 'sensitivity'],
    indexed: ['labResultId', 'loincCode', 'patientId', 'status']
  },

  Procedure: {
    required: ['id', 'procedureId'],
    optional: ['cptCode', 'description', 'procedureDate', 'status',
               'performingProviderId', 'facilityId', 'patientId', 'encounterId', 'sensitivity'],
    indexed: ['procedureId', 'cptCode', 'patientId']
  },

  Provider: {
    required: ['id', 'providerId'],
    optional: ['npi', 'firstName', 'lastName', 'credentials', 'specialty',
               'department', 'facilityId', 'phone', 'email', 'sensitivity'],
    indexed: ['providerId', 'npi', 'specialty']
  },

  Facility: {
    required: ['id', 'facilityId', 'name'],
    optional: ['type', 'address', 'city', 'state', 'zip', 'phone', 'npi', 'sensitivity'],
    indexed: ['facilityId', 'type', 'name']
  },

  Insurance: {
    required: ['id', 'insuranceId'],
    optional: ['payerName', 'planType', 'memberId', 'groupNumber',
               'effectiveDate', 'terminationDate', 'copay', 'deductible',
               'patientId', 'sensitivity'],
    indexed: ['insuranceId', 'payerName', 'patientId']
  },

  Allergy: {
    required: ['id', 'allergyId', 'allergen'],
    optional: ['reaction', 'severity', 'onsetDate', 'status', 'patientId', 'sensitivity'],
    indexed: ['allergyId', 'allergen', 'patientId', 'severity']
  },

  VitalSigns: {
    required: ['id', 'vitalId', 'measurementDate'],
    optional: ['bloodPressureSystolic', 'bloodPressureDiastolic', 'heartRate',
               'temperature', 'respiratoryRate', 'oxygenSaturation', 'weight', 'height', 'bmi',
               'patientId', 'encounterId', 'sensitivity'],
    indexed: ['vitalId', 'patientId', 'measurementDate']
  },

  ClinicalNote: {
    required: ['id', 'noteId'],
    optional: ['noteType', 'content', 'authorId', 'signedDate', 'status',
               'patientId', 'encounterId', 'sensitivity'],
    indexed: ['noteId', 'noteType', 'patientId', 'authorId']
  },

  Appointment: {
    required: ['id', 'appointmentId'],
    optional: ['appointmentDate', 'appointmentTime', 'duration', 'type', 'status',
               'patientId', 'providerId', 'facilityId', 'sensitivity'],
    indexed: ['appointmentId', 'patientId', 'providerId', 'status', 'appointmentDate']
  },

  PolicyRule: {
    required: ['id', 'name', 'packName'],
    optional: ['priority', 'condition', 'intentMode', 'overrides', 'enabled',
               'description', 'version'],
    indexed: ['name', 'packName', 'intentMode']
  },

  KnowledgeEntry: {
    required: ['id', 'key', 'category'],
    optional: ['source', 'content', 'confidence', 'tags', 'validFrom', 'validTo',
               'version', 'lastUpdated'],
    indexed: ['key', 'category', 'source']
  },

  Recipe: {
    required: ['id', 'name', 'packName'],
    optional: ['intentMode', 'taskType', 'steps', 'inputs', 'outputs',
               'version', 'description'],
    indexed: ['name', 'packName', 'intentMode', 'taskType']
  },

  DecisionArtifact: {
    required: ['id', 'taskType', 'decision'],
    optional: ['timestamp', 'intentMode', 'policyTrace', 'knowledgeUsed',
               'recipeExecuted', 'reasons', 'confidence', 'actor', 'context'],
    indexed: ['taskType', 'intentMode', 'timestamp']
  },

  AuditEntry: {
    required: ['id', 'action', 'actor'],
    optional: ['entityType', 'entityId', 'timestamp', 'details', 'outcome',
               'sessionId', 'ipAddress'],
    indexed: ['action', 'actor', 'entityType', 'timestamp']
  }
};

/**
 * Data sensitivity classifications for healthcare
 */
export const SensitivityLevels = {
  PUBLIC: 'PUBLIC',
  INTERNAL: 'INTERNAL',
  CONFIDENTIAL: 'CONFIDENTIAL',
  PHI: 'PHI',           // Protected Health Information
  PII: 'PII',           // Personally Identifiable Information
  SENSITIVE: 'SENSITIVE' // Other sensitive data
};

/**
 * PHI sub-classifications (HIPAA 18 identifiers)
 */
export const PHIClassifications = {
  // Direct identifiers
  PATIENT_NAME: 'PATIENT_NAME',
  DATE_OF_BIRTH: 'DATE_OF_BIRTH',
  ADDRESS: 'ADDRESS',
  PHONE_NUMBER: 'PHONE_NUMBER',
  EMAIL: 'EMAIL',
  SSN: 'SSN',
  MEDICAL_RECORD_NUMBER: 'MEDICAL_RECORD_NUMBER',
  HEALTH_PLAN_ID: 'HEALTH_PLAN_ID',
  ACCOUNT_NUMBER: 'ACCOUNT_NUMBER',
  CERTIFICATE_LICENSE: 'CERTIFICATE_LICENSE',
  VEHICLE_ID: 'VEHICLE_ID',
  DEVICE_ID: 'DEVICE_ID',
  URL: 'URL',
  IP_ADDRESS: 'IP_ADDRESS',
  BIOMETRIC: 'BIOMETRIC',
  PHOTO: 'PHOTO',

  // Clinical data
  DIAGNOSIS: 'DIAGNOSIS',
  TREATMENT: 'TREATMENT',
  PRESCRIPTION: 'PRESCRIPTION',
  LAB_RESULT: 'LAB_RESULT',
  GENETIC_DATA: 'GENETIC_DATA',
  VITAL_SIGNS: 'VITAL_SIGNS'
};

/**
 * Intent modes for healthcare reasoning
 */
export const IntentModes = {
  GUARDRAIL_ENFORCEMENT: 'GUARDRAIL_ENFORCEMENT',
  MIGRATION_READINESS: 'MIGRATION_READINESS',
  PHI_PROTECTION: 'PHI_PROTECTION',
  CLINICAL_HOURS: 'CLINICAL_HOURS',
  AUDIT_COMPLIANCE: 'AUDIT_COMPLIANCE',
  OPTIMIZATION: 'OPTIMIZATION'
};

/**
 * Healthcare code systems
 */
export const CodeSystems = {
  ICD10: 'ICD-10',       // Diagnosis codes
  CPT: 'CPT',            // Procedure codes
  LOINC: 'LOINC',        // Lab test codes
  RXNORM: 'RxNorm',      // Medication codes
  SNOMED: 'SNOMED-CT',   // Clinical terminology
  NPI: 'NPI',            // Provider identifiers
  HCPCS: 'HCPCS'         // Healthcare supplies/services
};

/**
 * Validate vertex properties against schema
 */
export function validateVertex(label, properties) {
  const schema = VertexSchemas[label];
  if (!schema) {
    throw new Error(`Unknown vertex label: ${label}`);
  }

  const errors = [];

  // Check required properties
  for (const prop of schema.required) {
    if (properties[prop] === undefined || properties[prop] === null) {
      errors.push(`Missing required property: ${prop}`);
    }
  }

  // Check for unknown properties
  const allKnown = [...schema.required, ...schema.optional];
  for (const prop of Object.keys(properties)) {
    if (!allKnown.includes(prop) && prop !== 'label') {
      errors.push(`Unknown property: ${prop}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Field patterns that indicate PHI
 */
export const PHIFieldPatterns = [
  { pattern: /^(Patient|First|Last|Middle).*Name$/i, classification: PHIClassifications.PATIENT_NAME },
  { pattern: /^(DOB|DateOfBirth|BirthDate|birthDate)$/i, classification: PHIClassifications.DATE_OF_BIRTH },
  { pattern: /SSN|SocialSecurity|ssn/i, classification: PHIClassifications.SSN },
  { pattern: /^(MRN|patientId|MedicalRecord)/i, classification: PHIClassifications.MEDICAL_RECORD_NUMBER },
  { pattern: /^(address|street|city|zip|state)$/i, classification: PHIClassifications.ADDRESS },
  { pattern: /^(phone|fax|mobile|cell)/i, classification: PHIClassifications.PHONE_NUMBER },
  { pattern: /^email$/i, classification: PHIClassifications.EMAIL },
  { pattern: /(Diagnosis|icdCode|DxCode)/i, classification: PHIClassifications.DIAGNOSIS },
  { pattern: /(Prescription|RxNumber|medication)/i, classification: PHIClassifications.PRESCRIPTION },
  { pattern: /(LabResult|TestResult|loincCode)/i, classification: PHIClassifications.LAB_RESULT },
  { pattern: /(Treatment|Procedure|cptCode)/i, classification: PHIClassifications.TREATMENT },
  { pattern: /(bloodPressure|heartRate|temperature|weight|height)/i, classification: PHIClassifications.VITAL_SIGNS },
  { pattern: /(memberId|insuranceId|groupNumber)/i, classification: PHIClassifications.HEALTH_PLAN_ID }
];

/**
 * Detect PHI classification from field name
 */
export function detectPHIClassification(fieldName) {
  for (const { pattern, classification } of PHIFieldPatterns) {
    if (pattern.test(fieldName)) {
      return classification;
    }
  }
  return null;
}

/**
 * Check if a vertex type contains PHI
 */
export function vertexContainsPHI(label) {
  const phiVertices = ['Patient', 'Encounter', 'Diagnosis', 'Medication',
                       'LabResult', 'Procedure', 'Allergy', 'VitalSigns',
                       'ClinicalNote', 'Insurance', 'Appointment'];
  return phiVertices.includes(label);
}

/**
 * Get PHI fields for a vertex type
 */
export function getPHIFields(label) {
  const schema = VertexSchemas[label];
  return schema?.phiFields || [];
}

export default {
  VertexLabels,
  EdgeLabels,
  VertexSchemas,
  SensitivityLevels,
  PHIClassifications,
  IntentModes,
  CodeSystems,
  validateVertex,
  detectPHIClassification,
  vertexContainsPHI,
  getPHIFields
};
