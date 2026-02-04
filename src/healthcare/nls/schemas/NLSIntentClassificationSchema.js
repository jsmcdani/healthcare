/**
 * NLS Intent Classification Schema for Claude Structured Outputs
 *
 * Guarantees 100% valid JSON output from LLM intent classification.
 * Used with cachedLLMCall outputSchema parameter.
 */

export const NLSIntentClassificationSchema = {
  type: "object",
  description: "NLS intent classification result from LLM",
  properties: {
    intentId: {
      type: ["string", "null"],
      description: "The classified intent ID from the allowed list, or null if unable to classify",
      enum: [
        "hc:patient-summary",
        "hc:treatment-recommendation",
        "hc:care-gaps",
        "hc:emergency-triage",
        "hc:help",
        null
      ]
    },
    confidence: {
      type: "number",
      description: "Classification confidence score from 0.0 to 1.0",
      minimum: 0,
      maximum: 1
    },
    parameters: {
      type: "array",
      description: "Extracted parameters from the input",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Parameter name (e.g., patientId, condition, timeRange)"
          },
          value: {
            type: ["string", "number", "boolean", "null"],
            description: "Extracted parameter value"
          },
          confidence: {
            type: "number",
            description: "Extraction confidence for this parameter",
            minimum: 0,
            maximum: 1
          }
        },
        required: ["name", "value", "confidence"]
      }
    },
    requiresClarification: {
      type: "boolean",
      description: "Whether clarification is needed from the user"
    },
    reasoning: {
      type: "string",
      description: "Brief explanation of the classification decision"
    }
  },
  required: ["intentId", "confidence", "parameters", "requiresClarification", "reasoning"]
};

export default NLSIntentClassificationSchema;
