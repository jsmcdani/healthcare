# Healthcare Intent Classification System

## Overview

The Healthcare Intent Classification System uses **Zod** for deterministic, type-safe validation to classify user requests into structured intents. This document explains how the system works and why it uses deterministic validation.

---

## Why Zod for Deterministic Validation

### The Problem with Non-Deterministic Classification

In healthcare, non-deterministic behavior is dangerous:
- LLMs can return different results for the same input
- Runtime type coercion can silently transform data
- Implicit validation can miss invalid states

### How Zod Solves This

Zod provides **parse, don't validate** semantics:

```javascript
// Traditional validation (non-deterministic)
if (typeof data.patientId === 'string') {
  // data is still "any" type - runtime could fail later
}

// Zod validation (deterministic)
const result = PatientSchema.safeParse(data);
if (result.success) {
  // result.data is GUARANTEED to match schema
  // Same input ALWAYS produces same output
}
```

**Key Zod Benefits:**

1. **Deterministic** - Same input always produces same output
2. **Fail-fast** - Invalid data throws immediately with clear errors
3. **Type inference** - TypeScript types generated from schemas
4. **Composable** - Build complex schemas from simple ones
5. **No runtime surprises** - Schema IS the runtime validation

### Zod Schema Example

```javascript
import { z } from 'zod';

// Define schema
const ParameterSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  source: z.enum(['explicit', 'inferred', 'default', 'context']),
  confidence: z.number().min(0).max(1)
});

// Parse (throws on invalid)
const param = ParameterSchema.parse({
  name: 'patientId',
  value: 'P001',
  source: 'inferred',
  confidence: 0.95
});

// Safe parse (returns result object)
const result = ParameterSchema.safeParse(input);
if (!result.success) {
  console.log(result.error.errors);  // Detailed error info
}
```

---

## Core Principles

### P1: Closed-World Intent Universe

The system only recognizes intents defined in rule tables. Any unrecognized intent is rejected with `OUTSIDE_ALLOWLIST`.

**Why:** In healthcare, executing unknown intents is dangerous. The closed-world assumption ensures only validated, tested intents can execute.

**How Zod enforces it:**
```javascript
// IntentRegistry uses Zod to validate intentId exists
if (!registry.isKnown(intentId)) {
  return createOutsideAllowlistEnvelope({
    clarification: {
      reason: ClarificationReason.OUTSIDE_ALLOWLIST,
      message: 'Command not recognized'
    }
  });
}
```

### P2: Deterministic-First Resolution

Intent classification follows a strict tier hierarchy:

| Tier | Method | Confidence | Deterministic? |
|------|--------|------------|----------------|
| **1** | Slash command triggers | 0.95-1.0 | Yes |
| **2** | Regex pattern matching | 0.6-0.95 | Yes |
| **3** | LLM classification | 0.5-0.9 | No |

**How it works:**

```
Input: "/staging P001"
         │
         ▼
   ┌─────────────────────────────────────────────────────────┐
   │ TIER 1: Trigger Match                                   │
   │                                                         │
   │ for (trigger of intent.triggers) {                     │
   │   if (input.startsWith(trigger)) {                     │
   │     // MATCH! confidence = 0.95                        │
   │     // Extract remaining text for parameters           │
   │     return { intentId, confidence: 0.95, tier: 1 }    │
   │   }                                                    │
   │ }                                                       │
   └─────────────────────────────────────────────────────────┘
         │ No match
         ▼
   ┌─────────────────────────────────────────────────────────┐
   │ TIER 2: Pattern Match                                   │
   │                                                         │
   │ for (pattern of intent.patterns) {                     │
   │   const regex = new RegExp(pattern.regex, 'i');        │
   │   const match = input.match(regex);                    │
   │   if (match) {                                         │
   │     // Extract named groups as parameters              │
   │     // confidence = pattern.weight (0.6-0.95)          │
   │     matches.push({ intentId, confidence, tier: 2 })   │
   │   }                                                    │
   │ }                                                       │
   │ // Return highest confidence match                      │
   └─────────────────────────────────────────────────────────┘
         │ No match (and allowLLMParse === true)
         ▼
   ┌─────────────────────────────────────────────────────────┐
   │ TIER 3: LLM Classification (Optional)                   │
   │                                                         │
   │ if (constraints.allowLLMParse) {                       │
   │   // Send to LLM with intent descriptions              │
   │   // confidence = LLM's reported confidence            │
   │   // NON-DETERMINISTIC - same input may vary           │
   │ }                                                       │
   └─────────────────────────────────────────────────────────┘
```

**Constraint to disable LLM:**
```javascript
const request = createDeterministicRequest(
  'staging readiness for P001',
  { userId: 'doc-123' }
);
// Sets constraints.allowLLMParse = false
// Only Tier 1-2 will be used (deterministic)
```

### P3: Clarify, Don't Guess

When the system is uncertain, it asks for clarification instead of guessing.

**Triggers for clarification:**
- Multiple intents match with similar confidence
- Required parameter missing
- Confidence below threshold
- Intent not in allowlist

**How Zod enforces it:**
```javascript
// ClarificationSchema ensures proper structure
const ClarificationSchema = z.object({
  reason: z.enum([
    'ambiguous_intent',
    'missing_required_parameter',
    'multiple_intent_matches',
    'low_confidence',
    'outside_allowlist'
  ]),
  message: z.string(),
  options: z.array(ClarificationOptionSchema).optional(),
  missingParameters: z.array(z.string()).optional()
});
```

### P4: Dual Confidence Model

Two separate confidence scores:

| Score | Meaning | Range |
|-------|---------|-------|
| `parseConfidence` | How confident we understood what the user meant | 0-1 |
| `decisionConfidence` | How appropriate this action is for the clinical context | 0-1 |

**Example:**
```
User: "Give patient insulin"

parseConfidence: 0.95
  → We clearly understood they want to give insulin

decisionConfidence: 0.3
  → But this patient is not diabetic, so insulin is inappropriate
```

**Zod schema:**
```javascript
const IntentParsePayloadSchema = z.object({
  // ...
  parseConfidence: z.number().min(0).max(1),
  decisionConfidence: z.number().min(0).max(1).optional()
});
```

### P5: Auditability and Version Pinning

Every parse result includes a trace for reproducibility.

**Why:** For clinical audits, we need to reproduce exactly how a classification was made.

**Trace schema:**
```javascript
const ParseTraceSchema = z.object({
  parserUsed: z.enum(['rule-based', 'llm', 'hybrid', 'confirmed']),
  tier: z.number().int().min(1).max(3).optional(),
  ruleMatches: z.array(RuleMatchSchema).default([]),
  llmInvoked: z.boolean().default(false),
  parseTimeMs: z.number().int(),
  ruleTableVersion: z.string().optional()  // e.g., "clinical-intents.json@1.0.0"
});
```

**Using version for audit:**
```javascript
// 6 months later, auditor asks: "Why did the system classify this as staging?"

// We can reproduce exactly:
const rules = await loadRuleTables({ version: 'clinical-intents.json@1.0.0' });
const result = parser.parse(originalInput, originalContext);
// Same result as 6 months ago (deterministic)
```

---

## Zod Contract Schemas

### IntentParseRequestEnvelope (Input)

What goes INTO classification.

```javascript
// Schema definition
const IntentParseRequestPayloadSchema = z.object({
  rawText: z.string().min(1).max(2000),
  context: z.object({
    userId: z.string().optional(),
    orgId: z.string().optional(),
    patientId: z.string().optional(),
    sessionId: z.string().optional(),
    clinicalMode: z.enum([
      'standard',
      'emergency_triage',
      'phi_protection',
      'medication_safety',
      'staging_readiness'
    ]).default('standard'),
    locale: z.string().default('en-US')
  }).default({}),
  constraints: z.object({
    allowLLMParse: z.boolean().default(true),
    forceConfirm: z.boolean().default(false),
    maxParseTimeMs: z.number().int().min(100).max(30000).default(5000)
  }).default({})
});
```

**Factory functions:**
```javascript
// Simple request
const req = createSimpleRequest(
  'staging readiness for patient P001',
  { userId: 'doc-123', patientId: 'P001' },
  { allowLLMParse: true }
);

// Deterministic only (P2)
const detReq = createDeterministicRequest(
  '/staging P001',
  { userId: 'doc-123' }
);

// Always require confirmation (P3)
const confReq = createConfirmationRequest(
  'give insulin',
  { userId: 'doc-123', patientId: 'P001' }
);
```

### IntentParseEnvelope (Output)

What comes OUT of classification.

```javascript
// Parameter schema
const ParameterSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  source: z.enum(['explicit', 'inferred', 'default', 'context']),
  confidence: z.number().min(0).max(1)
});

// Full payload schema
const IntentParsePayloadSchema = z.object({
  intentId: z.string().nullable(),
  intentFamily: z.enum(['clinical', 'administrative', 'system']),
  parameters: z.array(ParameterSchema).default([]),
  parseConfidence: z.number().min(0).max(1),
  decisionConfidence: z.number().min(0).max(1).optional(),
  requiresClarification: z.boolean(),
  clarification: ClarificationSchema.optional(),
  originalText: z.string(),
  trace: ParseTraceSchema
});
```

**Factory functions:**
```javascript
// Success envelope
const success = createSuccessEnvelope({
  intentId: 'clinical.staging.readiness',
  intentFamily: 'clinical',
  parameters: [{
    name: 'patientId',
    value: 'P001',
    source: ParameterSource.INFERRED,
    confidence: 0.95
  }],
  parseConfidence: 0.85,
  originalText: 'staging readiness for patient P001',
  trace: {
    parserUsed: 'rule-based',
    tier: 2,
    parseTimeMs: 12,
    ruleTableVersion: 'clinical-intents.json@1.0.0'
  }
});

// Clarification envelope
const clarify = createClarificationEnvelope({
  originalText: 'check patient',
  clarification: {
    reason: ClarificationReason.AMBIGUOUS_INTENT,
    message: 'What would you like to check?',
    options: [
      { label: 'Patient Summary', value: 'summary', intentId: 'hc:patient-summary' },
      { label: 'Care Gaps', value: 'gaps', intentId: 'hc:care-gaps' }
    ]
  },
  trace: { parserUsed: 'rule-based', parseTimeMs: 8 }
});

// Outside allowlist envelope (P1)
const unknown = createOutsideAllowlistEnvelope({
  originalText: 'order pizza',
  message: 'Command not recognized. Use /help for available commands.',
  trace: { parserUsed: 'rule-based', parseTimeMs: 3 }
});
```

### IntentConfirmEnvelope (Confirmation)

User confirmation after clarification.

```javascript
// Confirmed parameter schema
const ConfirmedParameterSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  userModified: z.boolean().default(false)
});

// Full payload schema
const IntentConfirmPayloadSchema = z.object({
  parseEnvelopeId: z.string().uuid(),  // Reference to original parse
  confirmedIntentId: z.string(),
  confirmedParameters: z.array(ConfirmedParameterSchema).default([]),
  userAcknowledged: z.boolean(),
  confirmationSource: z.enum([
    'user_selection',
    'user_typed',
    'system_auto',
    'clinical_override'
  ]).default('user_selection'),
  additionalContext: z.string().optional()
});
```

**Factory functions:**
```javascript
// User confirmed from options
const confirm = createUserConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440000',
  confirmedIntentId: 'clinical.staging.readiness',
  confirmedParameters: [{
    name: 'patientId',
    value: 'P001',
    userModified: false
  }]
});

// System auto-confirmed (high confidence)
const auto = createAutoConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440001',
  confirmedIntentId: 'hc:help',
  confirmedParameters: [],
  additionalContext: 'Tier 1 trigger match with 0.95 confidence'
});
```

---

## Rule Tables

### How Rule Tables Define the Closed World (P1)

Rule tables are JSON files that define ALL valid intents. Zod validates these at load time.

```javascript
// Rule table schema
const RuleTableSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  lastUpdated: z.string().datetime(),
  intents: z.array(ClinicalIntentRuleSchema).min(1)
});

// Single intent rule schema
const ClinicalIntentRuleSchema = z.object({
  intentId: z.string().regex(/^(hc:|clinical\.)/),
  domain: z.enum(['staging', 'medication_safety', 'triage', 'care_gaps',
                  'patient_summary', 'treatment', 'administrative', 'system']),
  name: z.string(),
  description: z.string(),
  intentFamily: z.enum(['clinical', 'administrative', 'system']),
  triggers: z.array(z.string().startsWith('/')).min(1),
  patterns: z.array(PatternRuleSchema).default([]),
  requiredParameters: z.array(ParameterDefSchema).default([]),
  optionalParameters: z.array(ParameterDefSchema).default([]),
  recipe: z.string(),
  clinicalSafetyLevel: z.enum(['informational', 'advisory', 'action_required', 'critical'])
});
```

### Example Rule Table

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-02-05T00:00:00.000Z",
  "intents": [
    {
      "intentId": "clinical.staging.readiness",
      "domain": "staging",
      "name": "Staging Readiness Assessment",
      "description": "Check if patient meets staging criteria",
      "intentFamily": "clinical",
      "triggers": ["/staging-readiness", "/staging", "/stage-check"],
      "patterns": [
        {
          "regex": "^/staging(?:-readiness)?\\s+(?<patientId>[\\w-]+)$",
          "weight": 0.95
        },
        {
          "regex": "staging\\s+readiness\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[A-Z0-9-]+)",
          "weight": 0.85
        }
      ],
      "requiredParameters": [
        { "name": "patientId", "type": "patientId" }
      ],
      "optionalParameters": [
        { "name": "stagingType", "type": "string", "defaultValue": "general" }
      ],
      "recipe": "clinical-staging-readiness",
      "clinicalSafetyLevel": "advisory"
    },
    {
      "intentId": "clinical.med_safety.check",
      "domain": "medication_safety",
      "name": "Medication Safety Check",
      "description": "Check for drug interactions and contraindications",
      "intentFamily": "clinical",
      "triggers": ["/med-safety", "/drug-check", "/ddi"],
      "patterns": [
        {
          "regex": "drug\\s+interaction(?:s)?\\s+(?:for\\s+)?(?<patientId>[\\w-]+)?",
          "weight": 0.85
        },
        {
          "regex": "check\\s+(?:for\\s+)?interactions?\\s+(?:between\\s+)?(?<medications>.+)",
          "weight": 0.8
        }
      ],
      "requiredParameters": [],
      "optionalParameters": [
        { "name": "patientId", "type": "patientId" },
        { "name": "medications", "type": "string" }
      ],
      "recipe": "medication-safety-check",
      "clinicalSafetyLevel": "advisory"
    }
  ]
}
```

### Rule Loader with Caching

```javascript
import { loadRuleTables, clearRuleCache, getCurrentVersion } from './rules/index.js';

// Load with 5-minute cache
const rules = await loadRuleTables();

// Version string for audit (P5)
console.log(rules.version);  // "clinical-intents.json@1.0.0"

// Access intents
const staging = rules.getIntent('clinical.staging.readiness');
const byDomain = rules.getIntentsByDomain('medication_safety');

// P1: Check closed world
rules.isKnownIntent('clinical.staging.readiness');  // true
rules.isKnownIntent('unknown.intent');               // false

// Force reload
clearRuleCache();
const fresh = await loadRuleTables();
```

---

## IntentRegistry

The registry loads rule tables and provides Zod-validated intent lookup.

```javascript
import { getIntentRegistryAsync } from './IntentRegistry.js';

const registry = await getIntentRegistryAsync();

// P1: Closed-world check
registry.isKnown('clinical.staging.readiness');  // true
registry.isKnown('fake.intent');                  // false

// Get intent definition
const intent = registry.getIntent('clinical.staging.readiness');
// Returns: { intentId, name, parameterSchema, triggers, patterns, recipe, ... }

// Get by trigger (Tier 1)
const byTrigger = registry.getIntentByTrigger('/staging');

// P5: Version for audit
registry.getRuleTableVersion();  // "clinical-intents.json@1.0.0"

// Zod parameter validation
const validation = registry.validateParameters('clinical.staging.readiness', [
  { name: 'patientId', value: 'P001' }
]);
// { isValid: true, value: { patientId: 'P001', stagingType: 'general' } }

// Check missing required parameters
const missing = registry.getMissingRequired('clinical.staging.readiness', []);
// ['patientId']
```

---

## Files

```
src/healthcare/nls/
├── index.js                          # Module exports
├── IntentRegistry.js                 # Registry with Zod parameter validation
│
├── contracts/zod/
│   ├── IntentParseRequestEnvelope.js # Input envelope schema
│   ├── IntentParseEnvelope.js        # Output envelope schema (dual confidence)
│   └── IntentConfirmEnvelope.js      # Confirmation envelope schema
│
├── rules/
│   ├── index.js                      # Rule loader with 5-min cache
│   ├── rule-schema.js                # Zod schema for rule JSON validation
│   └── clinical-intents.json         # Clinical intent definitions
│
├── parsers/
│   ├── RuleBasedParser.js            # Tier 1-2 deterministic parsing
│   └── LLMParser.js                  # Tier 3 LLM parsing
│
└── extractors/
    └── EntityExtractor.js            # Parameter extraction from text
```

---

## Testing

```bash
node src/healthcare/nls/test-all.mjs
```

**26 tests verify:**
- Rule table Zod validation
- IntentRegistry initialization and P1 closed-world
- IntentParseRequestEnvelope factory functions
- IntentParseEnvelope with dual confidence (P4)
- IntentConfirmEnvelope with correct field names
- P2 tier tracking in trace
- P5 version tracking

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-05 | Initial Zod-based implementation with P1-P5 |
