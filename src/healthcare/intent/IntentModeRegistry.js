/**
 * Healthcare Intent Mode Registry
 * Defines available intent modes for healthcare AI assistant
 */

export const IntentModes = {
  CLINICAL_DECISION_SUPPORT: {
    id: 'CLINICAL_DECISION_SUPPORT',
    name: 'Clinical Decision Support',
    description: 'Assist with clinical decisions, diagnosis, treatment planning',
    priority: 1,
    constraints: {
      requiresPatientContext: true,
      requiresProviderAuth: true,
      auditLevel: 'FULL',
      phiHandling: 'ENCRYPTED'
    },
    allowedRecipes: ['patient-summary', 'drug-interaction-check', 'lab-interpretation', 'diagnosis-coding', 'treatment-recommendation', 'care-gap-analysis']
  },

  PHI_PROTECTION: {
    id: 'PHI_PROTECTION',
    name: 'PHI Protection Mode',
    description: 'Maximum data protection for patient health information',
    priority: 0,
    constraints: {
      requiresPatientContext: false,
      requiresProviderAuth: true,
      auditLevel: 'FULL',
      phiHandling: 'REDACTED',
      noExternalCalls: true
    },
    allowedRecipes: ['phi-audit', 'access-review', 'data-classification']
  },

  CARE_COORDINATION: {
    id: 'CARE_COORDINATION',
    name: 'Care Coordination',
    description: 'Coordinate care across providers and facilities',
    priority: 2,
    constraints: {
      requiresPatientContext: true,
      requiresProviderAuth: true,
      auditLevel: 'STANDARD',
      phiHandling: 'NEED_TO_KNOW'
    },
    allowedRecipes: ['care-team-summary', 'referral-preparation', 'transition-of-care', 'follow-up-scheduling']
  },

  POPULATION_HEALTH: {
    id: 'POPULATION_HEALTH',
    name: 'Population Health Analytics',
    description: 'Analyze health trends across patient populations',
    priority: 3,
    constraints: {
      requiresPatientContext: false,
      requiresProviderAuth: true,
      auditLevel: 'STANDARD',
      phiHandling: 'DEIDENTIFIED'
    },
    allowedRecipes: ['disease-prevalence', 'outcome-analysis', 'risk-stratification', 'quality-metrics']
  },

  EMERGENCY_TRIAGE: {
    id: 'EMERGENCY_TRIAGE',
    name: 'Emergency Triage',
    description: 'Urgent care prioritization and emergency support',
    priority: 0,
    constraints: {
      requiresPatientContext: true,
      requiresProviderAuth: false,
      auditLevel: 'FULL',
      phiHandling: 'IMMEDIATE_ACCESS',
      timeConstraint: 'URGENT'
    },
    allowedRecipes: ['triage-assessment', 'critical-alerts', 'emergency-protocol', 'allergy-check-urgent']
  },

  COMPLIANCE_AUDIT: {
    id: 'COMPLIANCE_AUDIT',
    name: 'Compliance Audit',
    description: 'HIPAA, regulatory compliance checking',
    priority: 1,
    constraints: {
      requiresPatientContext: false,
      requiresProviderAuth: true,
      auditLevel: 'FULL',
      phiHandling: 'AUDIT_ONLY'
    },
    allowedRecipes: ['hipaa-compliance-check', 'access-audit', 'consent-verification']
  }
};

export function getMode(modeId) {
  return IntentModes[modeId] || null;
}

export function getModesByPriority() {
  return Object.values(IntentModes).sort((a, b) => a.priority - b.priority);
}

export function isRecipeAllowedInMode(recipeId, modeId) {
  const mode = getMode(modeId);
  return mode ? mode.allowedRecipes.includes(recipeId) : false;
}

export function getDefaultMode(context = {}) {
  if (context.isEmergency) return IntentModes.EMERGENCY_TRIAGE;
  if (context.isAudit) return IntentModes.COMPLIANCE_AUDIT;
  if (context.hasPatientId) return IntentModes.CLINICAL_DECISION_SUPPORT;
  return IntentModes.POPULATION_HEALTH;
}

export default IntentModes;
