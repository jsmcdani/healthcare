# Healthcare Intent Classification System

## Overview

The Healthcare Intent Classification System classifies user requests into structured healthcare intents using Zod for deterministic, type-safe validation. This document explains how all the components work together.

---

## Why Zod for Deterministic Validation

In healthcare, non-deterministic behavior is dangerous. Zod provides **deterministic validation** - the same input ALWAYS produces the same output.

### Parse, Don't Validate

```javascript
// Traditional validation - non-deterministic, data is still "any"
if (typeof data.patientId === 'string') {
  // data could still fail later at runtime
}

// Zod - deterministic, returns typed data
const result = Schema.safeParse(data);
if (result.success) {
  // result.data is GUARANTEED to match schema
  // Same input ALWAYS produces same output or same error
}
```

### Key Benefits

1. **Deterministic** - Same input → same output, always
2. **Fail-fast** - Invalid data throws immediately with detailed errors
3. **Type inference** - TypeScript types generated from schemas
4. **Composable** - Build complex schemas from simple ones
5. **Self-documenting** - Schema IS the specification

---

## Core Principles (P1-P5)

### P1: Closed-World Intent Universe

Only intents defined in rule tables are valid. Unknown intents return `OUTSIDE_ALLOWLIST`.

**Why:** In healthcare, executing unknown intents is dangerous.

**Implementation:**
```javascript
// IntentRegistry checks against rule tables
if (!registry.isKnown(intentId)) {
  return createOutsideAllowlistEnvelope({
    clarification: {
      reason: ClarificationReason.OUTSIDE_ALLOWLIST,
      message: 'Command not recognized. Use /help for available commands.'
    }
  });
}
```

### P2: Deterministic-First Resolution

Classification follows strict tier hierarchy - deterministic methods first:

| Tier | Method | Confidence | Deterministic |
|------|--------|------------|---------------|
| 1 | Slash command triggers | 0.95-1.0 | Yes |
| 2 | Regex pattern matching | 0.6-0.95 | Yes |
| 3 | LLM classification | 0.5-0.9 | No |

**Implementation:**
```javascript
// Tier 1: Check triggers first (highest priority, deterministic)
const triggerMatch = this._matchTrigger(text);  // "/staging" → confidence 0.95
if (triggerMatch) return triggerMatch;

// Tier 2: Check patterns (deterministic)
const patternMatches = this._matchPatterns(text);  // regex with named groups
if (patternMatches.length > 0) return bestMatch(patternMatches);

// Tier 3: LLM only if allowed and tiers 1-2 failed (non-deterministic)
if (constraints.allowLLMParse) {
  return llmParser.classify(text);
}
```

**Disable LLM for pure deterministic:**
```javascript
const request = createDeterministicRequest(rawText, context);
// Sets constraints.allowLLMParse = false
```

### P3: Clarify, Don't Guess

When uncertain, ask for clarification instead of guessing.

**Triggers:**
- Multiple intents match with similar confidence
- Required parameter missing
- Confidence below threshold
- Intent not in allowlist

**Implementation:**
```javascript
if (topMatch.confidence < THRESHOLD || closeMatches.length > 0) {
  return createClarificationEnvelope({
    clarification: {
      reason: ClarificationReason.AMBIGUOUS_INTENT,
      message: 'Which did you mean?',
      options: topIntents
    }
  });
}
```

### P4: Dual Confidence Model

Two separate confidence scores:

| Score | Purpose |
|-------|---------|
| `parseConfidence` | How confident we understood what user meant (0-1) |
| `decisionConfidence` | How appropriate this action is clinically (0-1, optional) |

**Example:**
```
Input: "Give patient insulin"

parseConfidence: 0.95    → We understood: give insulin
decisionConfidence: 0.3  → But patient isn't diabetic
```

### P5: Auditability and Version Pinning

Every parse includes trace for reproducibility.

**Implementation:**
```javascript
trace: {
  parserUsed: 'rule-based',
  tier: 2,
  ruleMatches: [{ pattern: 'staging\\s+readiness', confidence: 0.85 }],
  llmInvoked: false,
  parseTimeMs: 12,
  ruleTableVersion: 'clinical-intents.json@1.0.0'  // P5: version for audit
}
```

**Audit use case:**
```javascript
// 6 months later: "Why did system classify this as staging?"
// Load same rule version, get same result (deterministic)
const rules = await loadRuleTables({ version: 'clinical-intents.json@1.0.0' });
```

---

## System Architecture - How It All Works Together

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER INPUT                                      │
│                    "staging readiness for patient P001"                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     INTENT PARSE REQUEST ENVELOPE                            │
│                                                                              │
│  Created by: createSimpleRequest(rawText, context, constraints)             │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ header: { schemaId: 'intent.parse.request', ... }                      │ │
│  │ payload: {                                                              │ │
│  │   rawText: "staging readiness for patient P001"                        │ │
│  │   context: { userId, orgId, patientId, clinicalMode }                  │ │
│  │   constraints: { allowLLMParse: true, forceConfirm: false }            │ │
│  │ }                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Zod validates: IntentParseRequestEnvelopeSchema.parse(envelope)            │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INTENT REGISTRY                                    │
│                                                                              │
│  Loads from: rules/clinical-intents.json                                    │
│  Validates with: RuleTableSchema (Zod)                                      │
│  Caches for: 5 minutes                                                      │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Methods:                                                                │ │
│  │   isKnown(intentId) → boolean                    [P1: closed-world]    │ │
│  │   getIntent(intentId) → IntentDefinition                               │ │
│  │   getIntentByTrigger('/staging') → IntentDefinition                    │ │
│  │   validateParameters(intentId, params) → Zod result                    │ │
│  │   getMissingRequired(intentId, params) → string[]                      │ │
│  │   getRuleTableVersion() → string                 [P5: audit]           │ │
│  │   getAllIntents() → IntentDefinition[]                                 │ │
│  │   getIntentsByFamily('clinical') → IntentDefinition[]                  │ │
│  │   getIntentsByDomain('staging') → IntentDefinition[]                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Each intent has Zod parameterSchema built from rule definition             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          RULE-BASED PARSER                                   │
│                                                                              │
│  TIER 1: Trigger Match (confidence: 0.95)                                   │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ for (trigger of intent.triggers) {           // ["/staging", "/staging-readiness"]
│  │   if (text.startsWith(trigger)) {                                      │ │
│  │     remaining = text.substring(trigger.length);  // " P001"            │ │
│  │     params = extractEntities(remaining);         // { patientId: P001 }│ │
│  │     return { intentId, confidence: 0.95, tier: 1 };                    │ │
│  │   }                                                                    │ │
│  │ }                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                     │                                        │
│                                     ▼ (no trigger match)                     │
│  TIER 2: Pattern Match (confidence: from pattern.weight)                    │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ for (pattern of intent.patterns) {                                      │ │
│  │   // pattern.regex: "staging\\s+readiness\\s+(?<patientId>[A-Z0-9-]+)" │ │
│  │   // pattern.weight: 0.85                                              │ │
│  │   const match = text.match(new RegExp(pattern.regex, 'i'));            │ │
│  │   if (match) {                                                         │ │
│  │     params = match.groups;  // { patientId: "P001" }                   │ │
│  │     matches.push({ intentId, confidence: pattern.weight, tier: 2 });   │ │
│  │   }                                                                    │ │
│  │ }                                                                       │ │
│  │ return highestConfidenceMatch;                                          │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                     │                                        │
│                                     ▼ (no pattern match, LLM allowed)        │
│  TIER 3: LLM Classification (non-deterministic)                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ if (constraints.allowLLMParse) {                                        │ │
│  │   return llmParser.classify(text, intentDescriptions);                  │ │
│  │ }                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PARAMETER VALIDATION                                 │
│                                                                              │
│  Registry validates parameters with Zod:                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ const validation = registry.validateParameters(intentId, params);       │ │
│  │                                                                         │ │
│  │ if (!validation.isValid) {                                              │ │
│  │   return createClarificationEnvelope({                                  │ │
│  │     clarification: {                                                    │ │
│  │       reason: MISSING_REQUIRED_PARAMETER,                               │ │
│  │       missingParameters: validation.missingFields                       │ │
│  │     }                                                                   │ │
│  │   });                                                                   │ │
│  │ }                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       INTENT PARSE ENVELOPE (Output)                         │
│                                                                              │
│  Created by: createSuccessEnvelope() or createClarificationEnvelope()       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ header: { schemaId: 'intent.parse', ... }                              │ │
│  │ payload: {                                                              │ │
│  │   intentId: "clinical.staging.readiness"                               │ │
│  │   intentFamily: "clinical"                                             │ │
│  │   parameters: [{                                                        │ │
│  │     name: "patientId",                                                  │ │
│  │     value: "P001",                                                      │ │
│  │     source: "inferred",        // explicit|inferred|default|context    │ │
│  │     confidence: 0.95                                                    │ │
│  │   }]                                                                    │ │
│  │   parseConfidence: 0.85        // P4: how sure we understood           │ │
│  │   decisionConfidence: null     // P4: clinical appropriateness         │ │
│  │   requiresClarification: false                                         │ │
│  │   originalText: "staging readiness for patient P001"                   │ │
│  │   trace: {                                                              │ │
│  │     parserUsed: "rule-based",                                           │ │
│  │     tier: 2,                                                            │ │
│  │     parseTimeMs: 12,                                                    │ │
│  │     ruleTableVersion: "clinical-intents.json@1.0.0"  // P5             │ │
│  │   }                                                                     │ │
│  │ }                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Zod validates: IntentParseEnvelopeSchema.parse(envelope)                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     │ (if requiresClarification)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      INTENT CONFIRM ENVELOPE                                 │
│                                                                              │
│  User confirms after clarification                                          │
│  Created by: createUserConfirm() or createAutoConfirm()                     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ header: { schemaId: 'intent.confirm', ... }                            │ │
│  │ payload: {                                                              │ │
│  │   parseEnvelopeId: "550e8400-e29b-41d4-a716-446655440000"  // UUID     │ │
│  │   confirmedIntentId: "clinical.staging.readiness"                      │ │
│  │   confirmedParameters: [{                                               │ │
│  │     name: "patientId",                                                  │ │
│  │     value: "P001",                                                      │ │
│  │     userModified: false        // true if user changed parsed value    │ │
│  │   }]                                                                    │ │
│  │   userAcknowledged: true       // P3: explicit consent                 │ │
│  │   confirmationSource: "user_selection"  // or user_typed, system_auto  │ │
│  │ }                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Zod validates: IntentConfirmEnvelopeSchema.parse(envelope)                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                          ┌─────────────────┐
                          │ Recipe Executor │
                          │  (downstream)   │
                          └─────────────────┘
```

---

## Zod Schemas - Complete Definitions

### IntentParseRequestEnvelope

```javascript
import { z } from 'zod';

// Clinical modes
const ClinicalModeSchema = z.enum([
  'standard',
  'emergency_triage',
  'phi_protection',
  'medication_safety',
  'staging_readiness'
]).default('standard');

// Request context
const RequestContextSchema = z.object({
  userId: z.string().optional(),
  orgId: z.string().optional(),
  patientId: z.string().optional(),
  sessionId: z.string().optional(),
  previousIntentId: z.string().optional(),
  clinicalMode: ClinicalModeSchema,
  timezone: z.string().optional(),
  locale: z.string().default('en-US')
}).default({});

// Parsing constraints
const RequestConstraintsSchema = z.object({
  allowLLMParse: z.boolean().default(true),      // P2: allow tier 3?
  forceConfirm: z.boolean().default(false),       // P3: always confirm?
  maxParseTimeMs: z.number().int().min(100).max(30000).default(5000)
}).default({});

// Full payload
const IntentParseRequestPayloadSchema = z.object({
  rawText: z.string().min(1).max(2000),
  context: RequestContextSchema,
  constraints: RequestConstraintsSchema
});

// Full envelope
const IntentParseRequestEnvelopeSchema = z.object({
  header: EnvelopeHeaderSchema,
  payload: IntentParseRequestPayloadSchema,
  _meta: z.object({
    validated: z.boolean(),
    validatedAt: z.string().datetime()
  }).optional()
});
```

**Factory Functions:**
```javascript
// Basic request
createSimpleRequest(rawText, context, constraints)

// P2: Deterministic only (no LLM)
createDeterministicRequest(rawText, context)
// → sets constraints.allowLLMParse = false

// P3: Always require confirmation
createConfirmationRequest(rawText, context)
// → sets constraints.forceConfirm = true
```

### IntentParseEnvelope

```javascript
// Parameter source
const ParameterSourceSchema = z.enum([
  'explicit',   // User typed directly: "/staging P001"
  'inferred',   // Extracted from natural language
  'default',    // System default value
  'context'     // From request context
]);

// Clarification reasons
const ClarificationReasonSchema = z.enum([
  'ambiguous_intent',
  'missing_required_parameter',
  'multiple_intent_matches',
  'low_confidence',
  'unknown_entity',
  'outside_allowlist'  // P1
]);

// Intent families
const IntentFamilySchema = z.enum([
  'clinical',
  'administrative',
  'system'
]);

// Parameter with source tracking
const ParameterSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  source: ParameterSourceSchema,
  confidence: z.number().min(0).max(1)
});

// Clarification option
const ClarificationOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  intentId: z.string()
});

// Clarification details
const ClarificationSchema = z.object({
  reason: ClarificationReasonSchema,
  message: z.string(),
  options: z.array(ClarificationOptionSchema).optional(),
  missingParameters: z.array(z.string()).optional()
});

// Parse trace for audit (P5)
const ParseTraceSchema = z.object({
  parserUsed: z.enum(['rule-based', 'llm', 'hybrid', 'confirmed']),
  tier: z.number().int().min(1).max(3).optional(),
  ruleMatches: z.array(z.object({
    pattern: z.string(),
    confidence: z.number().min(0).max(1),
    tier: z.number().int().optional()
  })).default([]),
  llmInvoked: z.boolean().default(false),
  parseTimeMs: z.number().int(),
  ruleTableVersion: z.string().optional()
});

// Full payload
const IntentParsePayloadSchema = z.object({
  intentId: z.string().nullable(),
  intentFamily: IntentFamilySchema,
  parameters: z.array(ParameterSchema).default([]),
  parseConfidence: z.number().min(0).max(1),           // P4
  decisionConfidence: z.number().min(0).max(1).optional(), // P4
  requiresClarification: z.boolean(),
  clarification: ClarificationSchema.optional(),
  originalText: z.string(),
  trace: ParseTraceSchema
});
```

**Factory Functions:**
```javascript
// Success - intent resolved
createSuccessEnvelope({
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
})

// Clarification needed
createClarificationEnvelope({
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
})

// P1: Outside allowlist
createOutsideAllowlistEnvelope({
  originalText: 'order pizza',
  message: 'Command not recognized.',
  trace: { parserUsed: 'rule-based', parseTimeMs: 3 }
})
```

### IntentConfirmEnvelope

```javascript
// Confirmation source
const ConfirmationSourceSchema = z.enum([
  'user_selection',    // User selected from options
  'user_typed',        // User typed confirmation
  'system_auto',       // Auto-confirmed (high confidence)
  'clinical_override'  // Clinician override
]);

// Confirmed parameter
const ConfirmedParameterSchema = z.object({
  name: z.string(),
  value: z.unknown(),
  userModified: z.boolean().default(false)
});

// Full payload
const IntentConfirmPayloadSchema = z.object({
  parseEnvelopeId: z.string().uuid(),  // Reference to original parse
  confirmedIntentId: z.string(),
  confirmedParameters: z.array(ConfirmedParameterSchema).default([]),
  userAcknowledged: z.boolean(),       // P3: explicit consent
  confirmationSource: ConfirmationSourceSchema.default('user_selection'),
  additionalContext: z.string().optional()
});
```

**Factory Functions:**
```javascript
// User confirmed from options
createUserConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440000',  // UUID
  confirmedIntentId: 'clinical.staging.readiness',
  confirmedParameters: [{
    name: 'patientId',
    value: 'P001',
    userModified: false
  }]
})

// System auto-confirmed
createAutoConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440001',
  confirmedIntentId: 'hc:help',
  confirmedParameters: [],
  additionalContext: 'Tier 1 match with 0.95 confidence'
})
```

---

## Rule Tables

### Rule Table Schema

```javascript
// Pattern rule for Tier 2
const PatternRuleSchema = z.object({
  regex: z.string(),                    // Regex with named capture groups
  weight: z.number().min(0).max(1),     // Confidence when matched
  tier: z.number().int().default(2)
});

// Parameter definition
const ParameterDefSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'date', 'patientId', 'medication', 'condition']),
  description: z.string().optional(),
  defaultValue: z.unknown().optional()
});

// Clinical safety level
const ClinicalSafetyLevelSchema = z.enum([
  'informational',   // Read-only
  'advisory',        // Recommendations
  'action_required', // Clinical action
  'critical'         // High-risk
]);

// Single intent definition
const ClinicalIntentRuleSchema = z.object({
  intentId: z.string().regex(/^(hc:|clinical\.)/),
  domain: z.enum(['staging', 'medication_safety', 'triage', 'care_gaps',
                  'patient_summary', 'treatment', 'administrative', 'system']),
  name: z.string(),
  description: z.string(),
  intentFamily: z.enum(['clinical', 'administrative', 'system']),
  triggers: z.array(z.string().startsWith('/')).min(1),  // Tier 1
  patterns: z.array(PatternRuleSchema).default([]),       // Tier 2
  synonyms: z.array(z.string()).default([]),
  requiredParameters: z.array(ParameterDefSchema).default([]),
  optionalParameters: z.array(ParameterDefSchema).default([]),
  recipe: z.string(),
  requiresConfirmation: z.boolean().default(false),
  clinicalSafetyLevel: ClinicalSafetyLevelSchema,
  examples: z.array(z.string()).default([])
});

// Full rule table
const RuleTableSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),  // Semver
  lastUpdated: z.string().datetime(),
  description: z.string().optional(),
  intents: z.array(ClinicalIntentRuleSchema).min(1)
});
```

### Example: clinical-intents.json

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-02-05T00:00:00.000Z",
  "description": "Clinical intent definitions",
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
        },
        {
          "regex": "(?:is|check)\\s+(?:patient\\s+)?(?<patientId>[\\w-]+)\\s+ready\\s+for\\s+staging",
          "weight": 0.8
        }
      ],
      "synonyms": ["staging assessment", "stage readiness"],
      "requiredParameters": [
        { "name": "patientId", "type": "patientId", "description": "Patient ID" }
      ],
      "optionalParameters": [
        { "name": "stagingType", "type": "string", "defaultValue": "general" }
      ],
      "recipe": "clinical-staging-readiness",
      "requiresConfirmation": false,
      "clinicalSafetyLevel": "advisory",
      "examples": [
        "/staging P001",
        "/staging-readiness MRN-12345",
        "staging readiness for patient P001"
      ]
    },
    {
      "intentId": "clinical.med_safety.check",
      "domain": "medication_safety",
      "name": "Medication Safety Check",
      "description": "Check for drug interactions",
      "intentFamily": "clinical",
      "triggers": ["/med-safety", "/drug-check", "/ddi", "/medication-check"],
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
      "synonyms": ["drug interaction", "DDI check"],
      "requiredParameters": [],
      "optionalParameters": [
        { "name": "patientId", "type": "patientId" },
        { "name": "medications", "type": "string" }
      ],
      "recipe": "medication-safety-check",
      "clinicalSafetyLevel": "advisory",
      "examples": ["/med-safety P001", "/ddi metformin, lisinopril"]
    }
  ]
}
```

### Rule Loader

```javascript
import { loadRuleTables, clearRuleCache, getCurrentVersion, getCachedRules } from './rules/index.js';

// Load with 5-minute cache
const rules = await loadRuleTables();

// Version for audit (P5)
rules.version  // "clinical-intents.json@1.0.0"

// Access methods
rules.getIntent('clinical.staging.readiness')
rules.getIntentsByDomain('medication_safety')
rules.getIntentsByFamily('clinical')
rules.isKnownIntent(intentId)  // P1
rules.getAllIntentIds()

// Cache management
clearRuleCache();  // Force reload
getCachedRules();  // Get cached or null
getCurrentVersion();  // Get version without reload
```

---

## IntentRegistry

Loads rule tables and provides Zod-validated intent operations.

```javascript
import { getIntentRegistry, getIntentRegistryAsync } from './IntentRegistry.js';

// Async (loads rule tables)
const registry = await getIntentRegistryAsync();

// Sync (uses cache or fallback)
const registry = getIntentRegistry();

// P1: Closed-world check
registry.isKnown('clinical.staging.readiness')  // true
registry.isKnown('fake.intent')                  // false

// Get intent
const intent = registry.getIntent('clinical.staging.readiness');
// {
//   intentId, name, description, intentFamily,
//   parameterSchema: ZodObject,  // Built from rule definition
//   requiredParameters: ['patientId'],
//   optionalParameters: ['stagingType'],
//   triggers: ['/staging-readiness', '/staging'],
//   patterns: [...],
//   recipe: 'clinical-staging-readiness',
//   clinicalSafetyLevel: 'advisory'
// }

// Get by trigger (Tier 1 lookup)
registry.getIntentByTrigger('/staging')

// Get collections
registry.getAllIntents()
registry.getAllIntentIds()
registry.getIntentsByFamily('clinical')
registry.getIntentsByDomain('staging')

// P5: Version for audit
registry.getRuleTableVersion()  // "clinical-intents.json@1.0.0"

// Zod parameter validation
registry.validateParameters('clinical.staging.readiness', [
  { name: 'patientId', value: 'P001' }
])
// { isValid: true, value: { patientId: 'P001', stagingType: 'general' } }

registry.validateParameters('clinical.staging.readiness', [])
// { isValid: false, error: '...', missingFields: ['patientId'] }

// Get missing required
registry.getMissingRequired('clinical.staging.readiness', [])
// ['patientId']

// Reload from rule tables
await registry.reload();
```

---

## File Structure

```
src/healthcare/nls/
├── index.js                          # Module exports
├── IntentRegistry.js                 # Registry + Zod parameter validation
├── NaturalLanguageService.js         # Main NLS service (uses this system)
│
├── contracts/zod/
│   ├── IntentParseRequestEnvelope.js # Input schema + factories
│   ├── IntentParseEnvelope.js        # Output schema + factories
│   └── IntentConfirmEnvelope.js      # Confirmation schema + factories
│
├── rules/
│   ├── index.js                      # Rule loader (5-min cache)
│   ├── rule-schema.js                # Zod schema for rule JSON
│   └── clinical-intents.json         # Intent definitions
│
├── parsers/
│   ├── RuleBasedParser.js            # Tier 1-2 (deterministic)
│   └── LLMParser.js                  # Tier 3 (optional)
│
└── extractors/
    └── EntityExtractor.js            # Parameter extraction
```

---

## Testing

```bash
node src/healthcare/nls/test-all.mjs
```

**26 tests verify:**
- Rule table Zod validation (load, validate, reject invalid)
- IntentRegistry (init, isKnown, getByTrigger, validateParameters)
- IntentParseRequestEnvelope (createSimple, createDeterministic, createConfirmation)
- IntentParseEnvelope (createSuccess, createClarification, createOutsideAllowlist)
- IntentConfirmEnvelope (createUserConfirm, createAutoConfirm)
- P1-P5 enforcement

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-05 | Initial Zod implementation with P1-P5 |
