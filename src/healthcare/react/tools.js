/**
 * Healthcare ReAct Tools
 * Tool definitions for Claude to call during reasoning loop
 *
 * Pattern: Same as OpsBot - data source tools, knowledge base tools, action tools
 */

export const HEALTHCARE_TOOLS = [
  // ===========================================
  // DATA SOURCE TOOLS - Graph/Cache queries
  // ===========================================
  {
    name: "get_patient_summary",
    description: "Get patient demographics, conditions, and care summary from graph",
    input_schema: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "Patient identifier"
        }
      },
      required: ["patient_id"]
    }
  },
  {
    name: "get_phi_fields",
    description: "Get all PHI-classified fields and their access patterns",
    input_schema: {
      type: "object",
      properties: {
        org_id: {
          type: "string",
          description: "Organization identifier"
        },
        classification: {
          type: "string",
          enum: ["all", "PII", "PHI", "MRN", "SSN", "DOB"],
          description: "PHI classification filter"
        }
      },
      required: ["org_id"]
    }
  },
  {
    name: "get_field_dependencies",
    description: "Get all automation/flows/classes that read or write a field",
    input_schema: {
      type: "object",
      properties: {
        field_id: {
          type: "string",
          description: "Field identifier"
        },
        depth: {
          type: "integer",
          description: "Traversal depth (1-3)",
          default: 2
        }
      },
      required: ["field_id"]
    }
  },
  {
    name: "get_active_automation",
    description: "Get all active flows, triggers, and process builders",
    input_schema: {
      type: "object",
      properties: {
        org_id: {
          type: "string",
          description: "Organization identifier"
        },
        type: {
          type: "string",
          enum: ["all", "Flow", "ApexTrigger", "ProcessBuilder", "ValidationRule"],
          description: "Automation type filter"
        }
      },
      required: ["org_id"]
    }
  },
  {
    name: "get_audit_trail",
    description: "Get audit log entries for PHI access",
    input_schema: {
      type: "object",
      properties: {
        org_id: { type: "string" },
        start_date: { type: "string", description: "ISO date" },
        end_date: { type: "string", description: "ISO date" },
        user_id: { type: "string", description: "Optional user filter" }
      },
      required: ["org_id", "start_date", "end_date"]
    }
  },

  // ===========================================
  // KNOWLEDGE BASE TOOLS - Past decisions, guidelines
  // ===========================================
  {
    name: "search_similar_decisions",
    description: "Semantic search for similar past decisions and their outcomes",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language description of the situation"
        },
        limit: {
          type: "integer",
          default: 5,
          description: "Number of results"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "get_clinical_guidelines",
    description: "Get relevant clinical guidelines for a condition or procedure",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Clinical topic (condition, procedure, screening)"
        },
        source: {
          type: "string",
          enum: ["all", "CMS", "CDC", "USPSTF", "AHA", "ADA"],
          description: "Guideline source filter"
        }
      },
      required: ["topic"]
    }
  },
  {
    name: "get_compliance_requirements",
    description: "Get applicable compliance requirements (HIPAA, state laws)",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Compliance topic (PHI access, consent, breach notification)"
        },
        jurisdiction: {
          type: "string",
          description: "State or federal"
        }
      },
      required: ["topic"]
    }
  },
  {
    name: "get_known_patterns",
    description: "Match symptoms to known problem patterns in healthcare systems",
    input_schema: {
      type: "object",
      properties: {
        symptoms: {
          type: "array",
          items: { type: "string" },
          description: "List of observed symptoms"
        }
      },
      required: ["symptoms"]
    }
  },

  // ===========================================
  // VALIDATION & RISK TOOLS
  // ===========================================
  {
    name: "check_phi_compliance",
    description: "Validate PHI handling against HIPAA requirements",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["access", "modify", "export", "share", "delete"],
          description: "Type of PHI operation"
        },
        data_elements: {
          type: "array",
          items: { type: "string" },
          description: "PHI elements involved"
        },
        purpose: {
          type: "string",
          enum: ["treatment", "payment", "operations", "research", "other"],
          description: "Purpose of access"
        },
        user_role: {
          type: "string",
          description: "Role of user performing operation"
        }
      },
      required: ["operation", "data_elements", "purpose"]
    }
  },
  {
    name: "assess_change_risk",
    description: "Assess risk of a proposed change to healthcare system",
    input_schema: {
      type: "object",
      properties: {
        change_type: {
          type: "string",
          enum: ["field_modify", "field_delete", "automation_change", "schema_change", "migration"],
          description: "Type of change"
        },
        target: {
          type: "string",
          description: "Target of the change"
        },
        impact_scope: {
          type: "object",
          properties: {
            phi_fields_affected: { type: "integer" },
            automations_affected: { type: "integer" },
            users_affected: { type: "integer" }
          }
        }
      },
      required: ["change_type", "target"]
    }
  },
  {
    name: "check_drug_interactions",
    description: "Check for drug-drug interactions",
    input_schema: {
      type: "object",
      properties: {
        medications: {
          type: "array",
          items: { type: "string" },
          description: "List of medication names or RxNorm codes"
        }
      },
      required: ["medications"]
    }
  },

  // ===========================================
  // ACTION TOOLS - Require risk check first
  // ===========================================
  {
    name: "request_approval",
    description: "Request human approval for high-risk actions",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action requiring approval"
        },
        risk_score: {
          type: "number",
          description: "Risk score 0-10"
        },
        justification: {
          type: "string",
          description: "Why this action is recommended"
        },
        approver_role: {
          type: "string",
          enum: ["compliance_officer", "clinical_lead", "it_admin", "supervisor"],
          description: "Role required for approval"
        }
      },
      required: ["action", "risk_score", "justification", "approver_role"]
    }
  },
  {
    name: "execute_remediation",
    description: "Execute a remediation action (requires prior risk assessment)",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["deactivate_automation", "restrict_field_access", "enable_encryption", "add_audit_logging"],
          description: "Remediation action to take"
        },
        target: {
          type: "string",
          description: "Target of the action"
        },
        risk_assessment_id: {
          type: "string",
          description: "ID of prior risk assessment (required)"
        }
      },
      required: ["action", "target", "risk_assessment_id"]
    }
  },

  // ===========================================
  // RESPONSE TOOL - Final structured output
  // ===========================================
  {
    name: "provide_response",
    description: "Provide final structured response to the user. Call this when you have enough information.",
    input_schema: {
      type: "object",
      properties: {
        response_type: {
          type: "string",
          enum: ["investigation", "recommendation", "compliance_check", "care_gap", "risk_assessment", "status"],
          description: "Type of response"
        },
        summary: {
          type: "string",
          description: "Brief summary of findings"
        },
        root_cause: {
          type: "string",
          description: "Identified root cause (if applicable)"
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence in the assessment"
        },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
              message: { type: "string" },
              evidence: { type: "string" }
            },
            required: ["severity", "message"]
          },
          description: "Detailed findings"
        },
        recommended_actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              target: { type: "string" },
              risk_score: { type: "number" },
              command: { type: "string" }
            },
            required: ["action"]
          },
          description: "Recommended next actions"
        },
        compliance_status: {
          type: "string",
          enum: ["compliant", "non_compliant", "needs_review", "not_applicable"]
        }
      },
      required: ["response_type", "summary", "confidence"]
    }
  }
];

export default HEALTHCARE_TOOLS;
