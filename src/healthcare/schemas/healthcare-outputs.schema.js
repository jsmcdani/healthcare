/**
 * Healthcare Claude Structured Output Schemas
 * JSON Schema contracts for guaranteed Claude response shape
 *
 * Pattern: Same as Servient claude-outputs.schema.js
 * LLM only used for reasoning - data comes from graph/cache
 */

/**
 * PHI Risk Assessment Schema
 * Used when LLM analyzes PHI field patterns
 */
export const PHIRiskAssessmentSchema = {
  type: "object",
  description: "PHI risk assessment from field analysis",
  properties: {
    overallRisk: {
      type: "string",
      enum: ["critical", "high", "medium", "low"],
      description: "Overall PHI risk level"
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["exposure", "access", "encryption", "audit", "compliance"]
          },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"]
          },
          description: {
            type: "string",
            description: "Specific finding description"
          },
          affectedFields: {
            type: "array",
            items: { type: "string" }
          },
          recommendation: {
            type: "string"
          }
        },
        required: ["category", "severity", "description"]
      },
      minItems: 1,
      maxItems: 10
    },
    complianceGaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          regulation: {
            type: "string",
            enum: ["HIPAA", "HITECH", "State Privacy", "Other"]
          },
          requirement: { type: "string" },
          gap: { type: "string" },
          remediation: { type: "string" }
        },
        required: ["regulation", "requirement", "gap"]
      }
    },
    summary: {
      type: "string",
      description: "Executive summary of PHI risk posture"
    }
  },
  required: ["overallRisk", "findings", "summary"]
};

/**
 * Clinical Decision Support Schema
 * Used when LLM provides clinical reasoning
 */
export const ClinicalDecisionSupportSchema = {
  type: "object",
  description: "Clinical decision support output",
  properties: {
    decisionType: {
      type: "string",
      enum: ["diagnostic", "treatment", "referral", "monitoring", "preventive"]
    },
    recommendation: {
      type: "string",
      description: "Primary clinical recommendation"
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    reasoning: {
      type: "array",
      items: {
        type: "object",
        properties: {
          factor: { type: "string" },
          weight: { type: "string", enum: ["high", "medium", "low"] },
          source: { type: "string", enum: ["guidelines", "evidence", "patient_data", "clinical_judgment"] }
        },
        required: ["factor", "weight", "source"]
      },
      description: "Factors contributing to the recommendation"
    },
    contraindications: {
      type: "array",
      items: { type: "string" },
      description: "Potential contraindications to consider"
    },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        properties: {
          option: { type: "string" },
          rationale: { type: "string" }
        },
        required: ["option", "rationale"]
      }
    },
    disclaimer: {
      type: "string",
      description: "Required clinical disclaimer"
    }
  },
  required: ["decisionType", "recommendation", "confidence", "reasoning", "disclaimer"]
};

/**
 * Drug Interaction Analysis Schema
 */
export const DrugInteractionSchema = {
  type: "object",
  description: "Drug interaction analysis output",
  properties: {
    interactionFound: {
      type: "boolean"
    },
    severity: {
      type: "string",
      enum: ["contraindicated", "major", "moderate", "minor", "none"]
    },
    interactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          drug1: { type: "string" },
          drug2: { type: "string" },
          interactionType: { type: "string" },
          severity: { type: "string", enum: ["contraindicated", "major", "moderate", "minor"] },
          mechanism: { type: "string" },
          clinicalEffect: { type: "string" },
          management: { type: "string" }
        },
        required: ["drug1", "drug2", "severity", "clinicalEffect"]
      }
    },
    recommendations: {
      type: "array",
      items: { type: "string" }
    },
    monitoringRequired: {
      type: "array",
      items: {
        type: "object",
        properties: {
          parameter: { type: "string" },
          frequency: { type: "string" },
          threshold: { type: "string" }
        },
        required: ["parameter", "frequency"]
      }
    }
  },
  required: ["interactionFound", "severity", "interactions"]
};

/**
 * Migration Readiness Assessment Schema
 */
export const MigrationReadinessSchema = {
  type: "object",
  description: "Healthcare data migration readiness assessment",
  properties: {
    readinessScore: {
      type: "number",
      minimum: 0,
      maximum: 100
    },
    readinessLevel: {
      type: "string",
      enum: ["ready", "conditional", "not_ready", "blocked"]
    },
    blockers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["phi_security", "data_quality", "compliance", "technical", "operational"]
          },
          severity: { type: "string", enum: ["critical", "high", "medium"] },
          description: { type: "string" },
          resolution: { type: "string" },
          effort: { type: "string", enum: ["hours", "days", "weeks"] }
        },
        required: ["category", "severity", "description", "resolution"]
      }
    },
    warnings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          area: { type: "string" },
          concern: { type: "string" },
          mitigation: { type: "string" }
        },
        required: ["area", "concern"]
      }
    },
    phiHandlingPlan: {
      type: "object",
      properties: {
        encryptionRequired: { type: "boolean" },
        deidentificationNeeded: { type: "boolean" },
        auditTrailRequired: { type: "boolean" },
        consentVerified: { type: "boolean" }
      },
      required: ["encryptionRequired", "auditTrailRequired"]
    },
    recommendation: {
      type: "string",
      description: "Overall recommendation for proceeding"
    }
  },
  required: ["readinessScore", "readinessLevel", "blockers", "recommendation"]
};

/**
 * Triage Assessment Schema
 */
export const TriageAssessmentSchema = {
  type: "object",
  description: "Emergency triage assessment output",
  properties: {
    triageLevel: {
      type: "integer",
      minimum: 1,
      maximum: 5,
      description: "ESI Level: 1=Resuscitation, 2=Emergent, 3=Urgent, 4=Less Urgent, 5=Non-urgent"
    },
    chiefComplaint: {
      type: "string"
    },
    vitalSignsConcerns: {
      type: "array",
      items: { type: "string" }
    },
    redFlags: {
      type: "array",
      items: {
        type: "object",
        properties: {
          flag: { type: "string" },
          action: { type: "string" }
        },
        required: ["flag", "action"]
      }
    },
    resourcesNeeded: {
      type: "array",
      items: { type: "string" },
      description: "Expected resources for ESI calculation"
    },
    disposition: {
      type: "string",
      enum: ["immediate_treatment", "urgent_evaluation", "standard_care", "fast_track", "discharge_planning"]
    },
    reasoning: {
      type: "string",
      description: "Clinical reasoning for triage level"
    }
  },
  required: ["triageLevel", "chiefComplaint", "disposition", "reasoning"]
};

/**
 * Compliance Audit Schema
 */
export const ComplianceAuditSchema = {
  type: "object",
  description: "HIPAA/Healthcare compliance audit output",
  properties: {
    auditPeriod: {
      type: "object",
      properties: {
        start: { type: "string" },
        end: { type: "string" }
      },
      required: ["start", "end"]
    },
    complianceScore: {
      type: "number",
      minimum: 0,
      maximum: 100
    },
    status: {
      type: "string",
      enum: ["compliant", "minor_issues", "major_issues", "non_compliant"]
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          regulation: { type: "string" },
          requirement: { type: "string" },
          status: { type: "string", enum: ["compliant", "partial", "non_compliant"] },
          evidence: { type: "string" },
          remediation: { type: "string" }
        },
        required: ["regulation", "requirement", "status"]
      }
    },
    accessPatterns: {
      type: "object",
      properties: {
        totalAccesses: { type: "integer" },
        unusualPatterns: { type: "array", items: { type: "string" } },
        highRiskAccesses: { type: "integer" }
      }
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
          action: { type: "string" },
          deadline: { type: "string" }
        },
        required: ["priority", "action"]
      }
    }
  },
  required: ["complianceScore", "status", "findings"]
};

/**
 * Care Gap Analysis Schema
 */
export const CareGapAnalysisSchema = {
  type: "object",
  description: "Care gap identification and recommendations",
  properties: {
    gapsIdentified: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gapType: {
            type: "string",
            enum: ["screening", "vaccination", "follow_up", "medication", "referral", "lab_test"]
          },
          description: { type: "string" },
          dueDate: { type: "string" },
          overdueDays: { type: "integer" },
          priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
          recommendation: { type: "string" }
        },
        required: ["gapType", "description", "priority"]
      }
    },
    qualityMeasures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          measure: { type: "string" },
          status: { type: "string", enum: ["met", "not_met", "excluded", "pending"] },
          dueBy: { type: "string" }
        },
        required: ["measure", "status"]
      }
    },
    summary: {
      type: "object",
      properties: {
        totalGaps: { type: "integer" },
        urgentGaps: { type: "integer" },
        overallCareScore: { type: "number" }
      },
      required: ["totalGaps"]
    }
  },
  required: ["gapsIdentified", "summary"]
};

// Export all schemas
export const HealthcareSchemas = {
  PHIRiskAssessmentSchema,
  ClinicalDecisionSupportSchema,
  DrugInteractionSchema,
  MigrationReadinessSchema,
  TriageAssessmentSchema,
  ComplianceAuditSchema,
  CareGapAnalysisSchema
};

export default HealthcareSchemas;
