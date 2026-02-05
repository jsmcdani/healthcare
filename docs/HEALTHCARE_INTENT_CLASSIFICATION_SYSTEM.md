# Healthcare Intent Classification System

## Overview

A closed-world, deterministic-first intent classification system for healthcare using **Zod** for type-safe, deterministic validation. The system parses natural language input into structured intents that can be executed by the healthcare platform.

### Why Zod?

1. **Deterministic validation** - Same input always produces same output (critical for healthcare)
2. **Type inference** - TypeScript types generated from schemas
3. **Composable schemas** - Build complex types from simple ones
4. **Parse, don't validate** - Returns typed data, not just boolean
5. **Rich error messages** - Detailed validation errors with paths
6. **No runtime surprises** - Fails fast with clear error messages

---

## Core Principles

| ID | Principle | Description | Implementation |
|----|-----------|-------------|----------------|
| **P1** | Closed-world | Only intents in the allowlist are valid | `isKnown()` check, `OUTSIDE_ALLOWLIST` reason |
| **P2** | Deterministic-first | Tier 1 triggers → Tier 2 patterns → Tier 3 LLM | `allowLLMParse` constraint, `tier` in trace |
| **P3** | Clarify, don't guess | Ask user when uncertain | `requiresClarification`, `forceConfirm` |
| **P4** | Dual confidence | Separate classification from clinical judgment | `parseConfidence` vs `decisionConfidence` |
| **P5** | Auditability | Version pinning, trace logging | `ruleTableVersion`, `ParseTraceSchema` |

### P1: Closed-World Intent Universe

The system only recognizes intents defined in the rule tables. Any unrecognized intent returns `OUTSIDE_ALLOWLIST`:

```javascript
if (!registry.isKnown(intentId)) {
  return createOutsideAllowlistEnvelope({
    originalText: userInput,
    message: 'Command not recognized. Use /help for available commands.'
  });
}
```

### P2: Deterministic-First Resolution

Intent resolution follows a strict tier hierarchy:

| Tier | Method | Confidence | When Used |
|------|--------|------------|-----------|
| **1** | Slash commands | 1.0 | `/staging P001` - exact match |
| **2** | Regex patterns | 0.7-0.95 | "staging readiness for P001" - pattern match |
| **3** | LLM classification | 0.5-0.9 | "is the patient ready?" - semantic understanding |

LLM is only invoked if:
- Tier 1-2 fail to match
- `constraints.allowLLMParse === true`

### P3: Clarify, Don't Guess

When confidence is low or parameters are missing, the system asks for clarification rather than guessing:

```javascript
if (parseConfidence < CONFIDENCE_THRESHOLD) {
  return createClarificationEnvelope({
    clarification: {
      reason: ClarificationReason.LOW_CONFIDENCE,
      message: 'Did you mean...',
      options: [/* suggestions */]
    }
  });
}
```

### P4: Dual Confidence Model

Two separate confidence scores serve different purposes:

| Score | Range | Purpose |
|-------|-------|---------|
| `parseConfidence` | 0-1 | How confident we understood what the user meant |
| `decisionConfidence` | 0-1 | How appropriate this action is for the clinical context (optional) |

Example: "Give patient insulin" might have:
- `parseConfidence: 0.95` - We understood the intent
- `decisionConfidence: 0.3` - But insulin may not be appropriate for this patient

### P5: Auditability

Every parse includes a trace for reproducibility:

```javascript
trace: {
  parserUsed: 'rule-based',
  tier: 2,
  parseTimeMs: 12,
  ruleTableVersion: 'clinical-intents.json@1.0.0',
  ruleMatches: [{ pattern: '/staging', confidence: 0.95 }],
  llmInvoked: false
}
```

---

## Architecture

```
                          ┌─────────────────┐
                          │   User Input    │
                          │ "staging P001"  │
                          └────────┬────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│                 IntentParseRequestEnvelope                    │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ payload:                                                 │ │
│  │   rawText: "staging P001"                               │ │
│  │   context: { userId, orgId, patientId, clinicalMode }   │ │
│  │   constraints: { allowLLMParse, forceConfirm }          │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│                      IntentRegistry                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Rule Tables │→ │ Zod Schemas │→ │ Parameter Validation │  │
│  │   (JSON)    │  │  (Runtime)  │  │    (Deterministic)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                                                              │
│  Methods:                                                    │
│  - isKnown(intentId) → boolean           [P1: Closed-world] │
│  - validateParameters(id, params) → Zod result              │
│  - getRuleTableVersion() → string        [P5: Auditability] │
└──────────────────────────────────────────────────────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
            ▼                      ▼                      ▼
    ┌───────────────┐      ┌───────────────┐      ┌───────────────┐
    │    Tier 1     │      │    Tier 2     │      │    Tier 3     │
    │   Triggers    │      │   Patterns    │      │     LLM       │
    │  /staging     │      │   regex +     │      │  (optional)   │
    │  confidence=1 │      │   weights     │      │               │
    └───────┬───────┘      └───────┬───────┘      └───────┬───────┘
            │                      │                      │
            └──────────────────────┼──────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│                    IntentParseEnvelope                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ payload:                                                 │ │
│  │   intentId: "clinical.staging.readiness"                │ │
│  │   intentFamily: "clinical"                              │ │
│  │   parameters: [{ name, value, source, confidence }]     │ │
│  │   parseConfidence: 0.95          [P4: Classification]   │ │
│  │   decisionConfidence: 0.85       [P4: Clinical]         │ │
│  │   requiresClarification: false                          │ │
│  │   trace: { tier, ruleTableVersion, parseTimeMs }  [P5]  │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                                   │
                                   │ (if requiresClarification)
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│                   IntentConfirmEnvelope                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ payload:                                                 │ │
│  │   parseEnvelopeId: UUID (reference to parse)            │ │
│  │   confirmedIntentId: "clinical.staging.readiness"       │ │
│  │   confirmedParameters: [{ name, value, userModified }]  │ │
│  │   userAcknowledged: true         [P3: Explicit consent] │ │
│  │   confirmationSource: "user_selection"                  │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────┐
                          │ Recipe Executor │
                          │ (downstream)    │
                          └─────────────────┘
```

---

## File Structure

```
src/healthcare/nls/
├── index.js                          # Module exports
├── IntentRegistry.js                 # Central registry with Zod validation
├── NaturalLanguageService.js         # Main NLS service
│
├── contracts/zod/                    # Zod-based contracts
│   ├── IntentParseRequestEnvelope.js # Input envelope
│   ├── IntentParseEnvelope.js        # Output envelope (dual confidence)
│   └── IntentConfirmEnvelope.js      # User confirmation envelope
│
├── rules/                            # Rule table system
│   ├── index.js                      # Rule loader with 5-min cache
│   ├── rule-schema.js                # Zod validation for rule JSON
│   └── clinical-intents.json         # Clinical intent definitions
│
├── parsers/
│   ├── RuleBasedParser.js            # Tier 1-2 parsing
│   └── LLMParser.js                  # Tier 3 parsing
│
└── extractors/
    └── EntityExtractor.js            # Entity extraction utilities
```

---

## Module Exports (index.js)

```javascript
// Core service
export { NaturalLanguageService, getNaturalLanguageService } from './NaturalLanguageService.js';

// Intent registry
export { IntentRegistry, getIntentRegistry, getIntentRegistryAsync } from './IntentRegistry.js';

// Request envelope (input)
export {
  IntentParseRequestEnvelopeSchema,
  RequestContextSchema,
  RequestConstraintsSchema,
  ClinicalModeSchema,
  ClinicalMode,
  createIntentParseRequest,
  createSimpleRequest,
  createDeterministicRequest,
  createConfirmationRequest,
  validateRequest
} from './contracts/zod/IntentParseRequestEnvelope.js';

// Parse envelope (output)
export {
  IntentParseEnvelopeSchema,
  IntentParsePayloadSchema,
  ParseTraceSchema,
  ParameterSchema,
  ClarificationSchema,
  ParameterSource,
  ParameterSourceSchema,
  ClarificationReason,
  ClarificationReasonSchema,
  IntentFamily,
  IntentFamilySchema,
  ParseTier,
  ParseTierSchema,
  createIntentParseEnvelope,
  createClarificationEnvelope,
  createSuccessEnvelope,
  createOutsideAllowlistEnvelope,
  validateParseEnvelope
} from './contracts/zod/IntentParseEnvelope.js';

// Confirm envelope (user acknowledgment)
export {
  IntentConfirmEnvelopeSchema,
  IntentConfirmPayloadSchema,
  ConfirmedParameterSchema,
  ConfirmResponseSchema,
  ConfirmationSource,
  ConfirmationSourceSchema,
  createIntentConfirm,
  createUserConfirm,
  createAutoConfirm,
  createConfirmResponse,
  validateConfirmation,
  validateConfirmResponse
} from './contracts/zod/IntentConfirmEnvelope.js';

// Rule tables
export {
  loadRuleTables,
  clearRuleCache,
  getCurrentVersion,
  getCachedRules
} from './rules/index.js';

// Rule schema validation
export {
  RuleTableSchema,
  ClinicalIntentRuleSchema,
  validateRuleTable,
  validateIntentRule
} from './rules/rule-schema.js';

// Parsers
export { RuleBasedParser, getRuleBasedParser } from './parsers/RuleBasedParser.js';
export { LLMParser, createLLMParser } from './parsers/LLMParser.js';

// Entity extraction
export { EntityExtractor, getEntityExtractor } from './extractors/EntityExtractor.js';
```

---

## Zod Schemas

### 1. IntentParseRequestEnvelope

Input to the NLS parser.

#### Schema Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `header` | EnvelopeHeader | Yes | - | Standard envelope header |
| `payload.rawText` | string | Yes | - | User input (1-2000 chars) |
| `payload.context.userId` | string | No | - | User making request |
| `payload.context.orgId` | string | No | - | Organization context |
| `payload.context.patientId` | string | No | - | Patient context for clinical intents |
| `payload.context.sessionId` | string | No | - | Conversation session ID |
| `payload.context.previousIntentId` | string | No | - | Previous intent in conversation |
| `payload.context.clinicalMode` | ClinicalMode | No | 'standard' | Active clinical mode |
| `payload.context.timezone` | string | No | - | User timezone |
| `payload.context.locale` | string | No | 'en-US' | Language/region |
| `payload.constraints.allowLLMParse` | boolean | No | true | Allow Tier 3 LLM parsing |
| `payload.constraints.forceConfirm` | boolean | No | false | Always require confirmation |
| `payload.constraints.maxParseTimeMs` | number | No | 5000 | Parse timeout (100-30000) |

#### Clinical Modes

| Mode | Description |
|------|-------------|
| `standard` | Normal clinical operations |
| `emergency_triage` | Emergency department triage |
| `phi_protection` | PHI-sensitive context |
| `medication_safety` | Medication interaction checks |
| `staging_readiness` | Clinical staging assessments |

#### Factory Functions

```javascript
import {
  createIntentParseRequest,
  createSimpleRequest,
  createDeterministicRequest,
  createConfirmationRequest,
  ClinicalMode,
  validateRequest
} from './contracts/zod/IntentParseRequestEnvelope.js';

// Full control
const req = createIntentParseRequest({
  rawText: 'staging readiness for patient P001',
  context: {
    userId: 'clinician-123',
    orgId: 'hospital-abc',
    patientId: 'P001',
    clinicalMode: ClinicalMode.STAGING_READINESS
  },
  constraints: {
    allowLLMParse: true,
    forceConfirm: false,
    maxParseTimeMs: 5000
  }
});

// Simple shorthand: createSimpleRequest(rawText, context, constraints)
const simple = createSimpleRequest(
  'staging readiness for patient P001',
  { userId: 'clinician-123', orgId: 'hospital-abc' },
  { allowLLMParse: true }
);

// P2: Deterministic only (no LLM)
const deterministic = createDeterministicRequest(
  '/staging P001',
  { userId: 'clinician-123' }
);

// P3: Always require confirmation
const forceConfirm = createConfirmationRequest(
  'staging readiness for P001',
  { userId: 'clinician-123', clinicalMode: ClinicalMode.STAGING_READINESS }
);

// Validate without creating
const validation = validateRequest(someEnvelope);
if (!validation.success) {
  console.error(validation.error.errors);
}
```

---

### 2. IntentParseEnvelope

Output from the NLS parser.

#### Schema Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `header` | EnvelopeHeader | Yes | Standard envelope header |
| `payload.intentId` | string/null | Yes | Classified intent ID (null if clarification needed) |
| `payload.intentFamily` | IntentFamily | Yes | 'clinical', 'administrative', 'system' |
| `payload.parameters` | Parameter[] | Yes | Extracted parameters (default: []) |
| `payload.parseConfidence` | number | Yes | Classification certainty (0-1) |
| `payload.decisionConfidence` | number | No | Clinical appropriateness (0-1) |
| `payload.requiresClarification` | boolean | Yes | Whether user input needed |
| `payload.clarification` | Clarification | No | Clarification details |
| `payload.originalText` | string | Yes | Original user input |
| `payload.trace` | ParseTrace | Yes | Audit trace |

#### Parameter Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Parameter name |
| `value` | any | Yes | Parameter value |
| `source` | ParameterSource | Yes | Where value came from |
| `confidence` | number | Yes | Confidence in value (0-1) |

**Parameter Sources:**

| Source | Description |
|--------|-------------|
| `explicit` | User provided directly in input |
| `inferred` | Extracted by parser/LLM |
| `default` | System default value |
| `context` | From request context (e.g., patientId) |

#### Clarification Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | ClarificationReason | Yes | Why clarification needed |
| `message` | string | Yes | User-facing message |
| `options` | ClarificationOption[] | No | Suggested alternatives |
| `missingParameters` | string[] | No | Required params not found |

**Clarification Reasons:**

| Reason | Description |
|--------|-------------|
| `ambiguous_intent` | Multiple possible meanings |
| `missing_required_parameter` | Required param not found |
| `multiple_intent_matches` | Several intents match equally |
| `low_confidence` | Below threshold |
| `unknown_entity` | Entity not recognized |
| `outside_allowlist` | P1: Intent not in closed-world |

#### Parse Trace Schema (P5)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `parserUsed` | string | Yes | 'rule-based', 'llm', 'hybrid', 'confirmed' |
| `tier` | number | No | 1, 2, or 3 |
| `ruleMatches` | RuleMatch[] | No | All patterns that matched |
| `llmInvoked` | boolean | No | Whether LLM was used |
| `parseTimeMs` | number | Yes | Parse duration in ms |
| `ruleTableVersion` | string | No | Version for reproducibility |

#### Factory Functions

```javascript
import {
  createSuccessEnvelope,
  createClarificationEnvelope,
  createOutsideAllowlistEnvelope,
  ParameterSource,
  ClarificationReason,
  IntentFamily,
  ParseTier,
  validateParseEnvelope
} from './contracts/zod/IntentParseEnvelope.js';

// Success - intent resolved
const success = createSuccessEnvelope({
  intentId: 'clinical.staging.readiness',
  intentFamily: IntentFamily.CLINICAL,
  parameters: [{
    name: 'patientId',
    value: 'P001',
    source: ParameterSource.INFERRED,
    confidence: 0.95
  }],
  parseConfidence: 0.95,
  decisionConfidence: 0.85,  // Optional - clinical appropriateness
  originalText: 'staging readiness for patient P001',
  trace: {
    parserUsed: 'rule-based',
    tier: ParseTier.TIER_2_PATTERN,
    parseTimeMs: 12,
    ruleTableVersion: 'clinical-intents.json@1.0.0',
    ruleMatches: [{ pattern: 'staging\\s+readiness', confidence: 0.95, tier: 2 }],
    llmInvoked: false
  }
});

// Clarification needed - ambiguous
const ambiguous = createClarificationEnvelope({
  intentFamily: IntentFamily.CLINICAL,
  originalText: 'check patient',
  clarification: {
    reason: ClarificationReason.AMBIGUOUS_INTENT,
    message: 'What would you like to check?',
    options: [
      { label: 'Patient Summary', value: 'summary', intentId: 'hc:patient-summary' },
      { label: 'Care Gaps', value: 'gaps', intentId: 'hc:care-gaps' },
      { label: 'Medications', value: 'meds', intentId: 'clinical.med_safety.check' }
    ]
  },
  trace: {
    parserUsed: 'rule-based',
    parseTimeMs: 8
  }
});

// Clarification needed - missing parameter
const missingParam = createClarificationEnvelope({
  intentFamily: IntentFamily.CLINICAL,
  originalText: 'staging readiness',
  clarification: {
    reason: ClarificationReason.MISSING_REQUIRED_PARAMETER,
    message: 'Which patient would you like to check staging readiness for?',
    missingParameters: ['patientId']
  },
  trace: {
    parserUsed: 'rule-based',
    tier: 2,
    parseTimeMs: 5
  }
});

// P1: Intent not in allowlist
const unknown = createOutsideAllowlistEnvelope({
  originalText: 'schedule a pizza delivery',
  message: 'This action is not available. Use /help to see available commands.',
  suggestedIntents: [
    { label: 'Help', value: 'help', intentId: 'hc:help' }
  ],
  trace: {
    parserUsed: 'rule-based',
    parseTimeMs: 3
  }
});

// Validate an envelope
const validation = validateParseEnvelope(someEnvelope);
```

---

### 3. IntentConfirmEnvelope

User confirmation when clarification was needed.

#### Schema Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `header` | EnvelopeHeader | Yes | Standard envelope header |
| `payload.parseEnvelopeId` | string (UUID) | Yes | Reference to original parse envelope |
| `payload.confirmedIntentId` | string | Yes | Intent the user confirmed |
| `payload.confirmedParameters` | ConfirmedParameter[] | No | Confirmed parameters (default: []) |
| `payload.userAcknowledged` | boolean | Yes | Explicit user acknowledgment |
| `payload.confirmationSource` | ConfirmationSource | No | How confirmation was provided |
| `payload.additionalContext` | string | No | Optional user notes |

#### Confirmed Parameter Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Parameter name |
| `value` | any | Yes | Confirmed value |
| `userModified` | boolean | No | True if user changed the parsed value |

#### Confirmation Sources

| Source | Description |
|--------|-------------|
| `user_selection` | User selected from options |
| `user_typed` | User typed explicit confirmation |
| `system_auto` | Auto-confirmed (high confidence, non-clinical) |
| `clinical_override` | Clinician override with acknowledgment |

#### Factory Functions

```javascript
import {
  createIntentConfirm,
  createUserConfirm,
  createAutoConfirm,
  createConfirmResponse,
  ConfirmationSource,
  validateConfirmation,
  validateConfirmResponse
} from './contracts/zod/IntentConfirmEnvelope.js';

// User explicitly confirmed (from options)
const userConfirm = createUserConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440000',  // Must be valid UUID
  confirmedIntentId: 'clinical.staging.readiness',
  confirmedParameters: [{
    name: 'patientId',
    value: 'P001',
    userModified: false
  }]
});

// User typed a value (not from options)
const typedConfirm = createIntentConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440001',
  confirmedIntentId: 'clinical.staging.readiness',
  confirmedParameters: [{
    name: 'patientId',
    value: 'MRN-99999',
    userModified: true  // User typed this, not from parse
  }],
  userAcknowledged: true,
  confirmationSource: ConfirmationSource.USER_TYPED,
  additionalContext: 'Patient MRN corrected'
});

// System auto-confirmed (high confidence, non-clinical)
const autoConfirm = createAutoConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440002',
  confirmedIntentId: 'hc:help',
  confirmedParameters: [],
  additionalContext: 'High confidence tier 1 match'
});

// Clinician override
const override = createIntentConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440003',
  confirmedIntentId: 'clinical.med_safety.check',
  confirmedParameters: [{
    name: 'patientId',
    value: 'P001',
    userModified: false
  }],
  userAcknowledged: true,
  confirmationSource: ConfirmationSource.CLINICAL_OVERRIDE,
  additionalContext: 'Proceeding despite low confidence - clinical judgment'
});

// Create confirmation response (for downstream processing)
const response = createConfirmResponse({
  confirmed: true,
  routing: {
    intentId: 'clinical.staging.readiness',
    recipeId: 'clinical-staging-readiness',
    parameters: { patientId: 'P001' }
  },
  readyForExecution: true
});

// Validation
const confirmValid = validateConfirmation(someConfirmEnvelope);
const responseValid = validateConfirmResponse(someResponse);
```

---

## Rule Tables

### Rule Table Schema

```javascript
// From rules/rule-schema.js
import { z } from 'zod';

const PatternRuleSchema = z.object({
  regex: z.string(),           // Regular expression with named capture groups
  weight: z.number().min(0).max(1),  // Confidence weight when matched
  tier: z.number().int().default(2)  // Parse tier (default: 2)
});

const ParameterDefSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'date', 'patientId', 'medication', 'condition']),
  description: z.string().optional(),
  defaultValue: z.unknown().optional()
});

const ClinicalSafetyLevelSchema = z.enum([
  'informational',   // Read-only, no action
  'advisory',        // Recommendations
  'action_required', // Clinical action
  'critical'         // High-risk action
]);

const ClinicalIntentRuleSchema = z.object({
  intentId: z.string().regex(/^(hc:|clinical\.)/),  // Must start with hc: or clinical.
  domain: z.enum(['staging', 'medication_safety', 'triage', 'care_gaps',
                  'patient_summary', 'treatment', 'administrative', 'system']),
  name: z.string(),
  description: z.string(),
  intentFamily: z.enum(['clinical', 'administrative', 'system']),
  triggers: z.array(z.string().startsWith('/')).min(1),  // Tier 1 slash commands
  patterns: z.array(PatternRuleSchema).default([]),       // Tier 2 regex patterns
  synonyms: z.array(z.string()).default([]),
  requiredParameters: z.array(ParameterDefSchema).default([]),
  optionalParameters: z.array(ParameterDefSchema).default([]),
  recipe: z.string(),  // Recipe ID to execute
  requiresConfirmation: z.boolean().default(false),
  clinicalSafetyLevel: ClinicalSafetyLevelSchema,
  examples: z.array(z.string()).default([])
});

const RuleTableSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),  // Semantic version
  lastUpdated: z.string().datetime(),
  description: z.string().optional(),
  intents: z.array(ClinicalIntentRuleSchema).min(1)
});
```

### Clinical Safety Levels

| Level | Description | Example |
|-------|-------------|---------|
| `informational` | Read-only, no clinical action | Patient summary |
| `advisory` | Recommendations only | Care gap suggestions |
| `action_required` | Requires clinical action | Treatment orders |
| `critical` | High-risk, requires confirmation | Emergency triage |

### Example: clinical-intents.json

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-02-05T00:00:00.000Z",
  "description": "Clinical intent definitions for Healthcare Intent Classification System",
  "intents": [
    {
      "intentId": "clinical.staging.readiness",
      "domain": "staging",
      "name": "Staging Readiness Assessment",
      "description": "Assess whether a patient meets clinical staging readiness criteria",
      "intentFamily": "clinical",
      "triggers": ["/staging-readiness", "/staging", "/stage-check"],
      "patterns": [
        {
          "regex": "^/staging(?:-readiness)?\\s+(?<patientId>[\\w-]+)$",
          "weight": 0.95
        },
        {
          "regex": "staging\\s+readiness\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[A-Z]{2,3}-?\\d{3,10})",
          "weight": 0.85
        },
        {
          "regex": "(?:is|check\\s+if)\\s+(?:patient\\s+)?(?<patientId>[\\w-]+)\\s+ready\\s+for\\s+staging",
          "weight": 0.8
        }
      ],
      "synonyms": ["staging assessment", "stage readiness", "ready for staging"],
      "requiredParameters": [
        {
          "name": "patientId",
          "type": "patientId",
          "description": "Patient identifier (MRN, ID, or system ID)"
        }
      ],
      "optionalParameters": [
        {
          "name": "stagingType",
          "type": "string",
          "description": "Type of staging (e.g., cancer, kidney_disease)",
          "defaultValue": "general"
        }
      ],
      "recipe": "clinical-staging-readiness",
      "requiresConfirmation": false,
      "clinicalSafetyLevel": "advisory",
      "examples": [
        "/staging-readiness P001",
        "/staging MRN-12345",
        "staging readiness for patient P001",
        "is patient MRN-456 ready for staging"
      ]
    },
    {
      "intentId": "clinical.med_safety.check",
      "domain": "medication_safety",
      "name": "Medication Safety Check",
      "description": "Check for drug-drug interactions, contraindications, and allergies",
      "intentFamily": "clinical",
      "triggers": ["/med-safety", "/drug-check", "/ddi", "/medication-check"],
      "patterns": [
        {
          "regex": "^/(?:med-safety|drug-check|ddi)(?:\\s+(?<patientId>[\\w-]+))?(?:\\s+(?<medications>.+))?$",
          "weight": 0.95
        },
        {
          "regex": "drug\\s+(?:drug\\s+)?interaction(?:s)?\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[\\w-]+)?",
          "weight": 0.85
        },
        {
          "regex": "check\\s+(?:for\\s+)?(?:drug\\s+)?interactions?\\s+(?:between\\s+)?(?<medications>.+)",
          "weight": 0.8
        }
      ],
      "synonyms": ["drug interaction", "medication interaction", "DDI check"],
      "requiredParameters": [],
      "optionalParameters": [
        {
          "name": "patientId",
          "type": "patientId",
          "description": "Patient identifier for context-aware checking"
        },
        {
          "name": "medications",
          "type": "string",
          "description": "Medications to check (comma-separated or free text)"
        }
      ],
      "recipe": "medication-safety-check",
      "requiresConfirmation": false,
      "clinicalSafetyLevel": "advisory",
      "examples": [
        "/med-safety P001",
        "/ddi metformin, lisinopril",
        "drug interaction check for patient P001",
        "check for interactions between aspirin and warfarin"
      ]
    }
  ]
}
```

### Rule Loader

```javascript
import {
  loadRuleTables,
  clearRuleCache,
  getCurrentVersion,
  getCachedRules
} from './rules/index.js';

// Load rule tables (with 5-minute caching)
const rules = await loadRuleTables();
console.log(rules.version);         // "clinical-intents.json@1.0.0"
console.log(rules.intents.length);  // 2
console.log(rules.sources);         // [{ file, version, lastUpdated, intentCount }]

// Get specific intent
const stagingIntent = rules.getIntent('clinical.staging.readiness');

// Get intents by domain
const medIntents = rules.getIntentsByDomain('medication_safety');

// Get intents by family
const clinicalIntents = rules.getIntentsByFamily('clinical');

// Check if intent exists (P1)
const exists = rules.isKnownIntent('clinical.staging.readiness');  // true
const fake = rules.isKnownIntent('fake.intent');  // false

// Get all intent IDs
const allIds = rules.getAllIntentIds();

// Force reload (clears cache)
clearRuleCache();
const freshRules = await loadRuleTables();

// Get cached rules synchronously (null if not loaded)
const cached = getCachedRules();

// Get current version without reloading
const version = getCurrentVersion();  // "clinical-intents.json@1.0.0" or null
```

---

## IntentRegistry

The central registry that loads from rule tables and provides Zod-based parameter validation.

```javascript
import {
  IntentRegistry,
  getIntentRegistry,
  getIntentRegistryAsync
} from './IntentRegistry.js';

// Async initialization (recommended - loads rule tables)
const registry = await getIntentRegistryAsync();

// Sync initialization (uses cached rules or fallback)
const syncRegistry = getIntentRegistry();

// P1: Closed-world check
registry.isKnown('clinical.staging.readiness');  // true
registry.isKnown('fake.intent');                  // false

// Get intent definition
const intent = registry.getIntent('clinical.staging.readiness');
// {
//   intentId: 'clinical.staging.readiness',
//   name: 'Staging Readiness Assessment',
//   parameterSchema: ZodObject,
//   requiredParameters: ['patientId'],
//   optionalParameters: ['stagingType'],
//   triggers: ['/staging-readiness', '/staging'],
//   patterns: [...],
//   recipe: 'clinical-staging-readiness',
//   clinicalSafetyLevel: 'advisory',
//   ...
// }

// Get intent by slash command trigger
const byTrigger = registry.getIntentByTrigger('/staging');

// Get all intents
const allIntents = registry.getAllIntents();
const allIds = registry.getAllIntentIds();

// Filter by family or domain
const clinical = registry.getIntentsByFamily('clinical');
const staging = registry.getIntentsByDomain('staging');

// P5: Get rule table version for audit
const version = registry.getRuleTableVersion();  // "clinical-intents.json@1.0.0"

// Zod-based parameter validation
const validation = registry.validateParameters('clinical.staging.readiness', [
  { name: 'patientId', value: 'P001' }
]);
// { isValid: true, value: { patientId: 'P001', stagingType: 'general' } }

const invalid = registry.validateParameters('clinical.staging.readiness', []);
// { isValid: false, error: '...', missingFields: ['patientId'] }

// Get missing required parameters
const missing = registry.getMissingRequired('clinical.staging.readiness', []);
// ['patientId']

const notMissing = registry.getMissingRequired('clinical.staging.readiness', [
  { name: 'patientId', value: 'P001' }
]);
// []

// Get intent summary (for help display)
const summary = registry.getIntentSummary();
// [{ intentId, name, description, domain, requiredParameters, examples, clinicalSafetyLevel }]

// Reload from rule tables
await registry.reload();
```

---

## End-to-End Usage Example

```javascript
import {
  getNaturalLanguageService,
  createSimpleRequest,
  ClarificationReason,
  ParameterSource
} from './src/healthcare/nls/index.js';

async function handleUserInput(userText, context) {
  const nls = await getNaturalLanguageService();

  // 1. Create request envelope
  const request = createSimpleRequest(userText, {
    userId: context.userId,
    orgId: context.orgId,
    patientId: context.currentPatientId,
    clinicalMode: context.clinicalMode || 'standard'
  });

  // 2. Parse the intent
  const result = await nls.parse(request);

  // 3. Handle the result
  if (result.payload.requiresClarification) {
    const reason = result.payload.clarification.reason;

    switch (reason) {
      case ClarificationReason.OUTSIDE_ALLOWLIST:
        // P1: Unknown intent
        return {
          type: 'error',
          message: result.payload.clarification.message,
          showHelp: true
        };

      case ClarificationReason.AMBIGUOUS_INTENT:
        // P3: Multiple matches - ask user to choose
        return {
          type: 'clarification',
          message: result.payload.clarification.message,
          options: result.payload.clarification.options
        };

      case ClarificationReason.MISSING_REQUIRED_PARAMETER:
        // P3: Ask for missing parameter
        return {
          type: 'clarification',
          message: result.payload.clarification.message,
          missingFields: result.payload.clarification.missingParameters
        };

      case ClarificationReason.LOW_CONFIDENCE:
        // P3: Confirm understanding
        return {
          type: 'confirmation',
          message: `Did you mean: ${result.payload.clarification.options[0]?.label}?`,
          options: result.payload.clarification.options
        };

      default:
        return {
          type: 'error',
          message: 'Unable to understand request'
        };
    }
  }

  // 4. Success - intent resolved
  console.log('Intent:', result.payload.intentId);
  console.log('Parse Confidence:', result.payload.parseConfidence);
  console.log('Decision Confidence:', result.payload.decisionConfidence);
  console.log('Parameters:', result.payload.parameters);
  console.log('Tier:', result.payload.trace.tier);
  console.log('Rule Version:', result.payload.trace.ruleTableVersion);

  // 5. Route to recipe executor
  return {
    type: 'execute',
    intentId: result.payload.intentId,
    recipeId: getRecipeForIntent(result.payload.intentId),
    parameters: result.payload.parameters.reduce((acc, p) => {
      acc[p.name] = p.value;
      return acc;
    }, {})
  };
}

// Usage
const response = await handleUserInput('/staging P001', {
  userId: 'clinician-123',
  orgId: 'hospital-abc'
});
```

---

## Testing

### Run Test Suite

```bash
node src/healthcare/nls/test-all.mjs
```

### Expected Output

```
=== HEALTHCARE INTENT CLASSIFICATION SYSTEM TESTS ===

--- Rule Loader Tests ---
PASS: Rule tables load successfully
PASS: Rule version tracking (P5)
PASS: Rule table Zod validation
PASS: Rule table rejects invalid schema

--- IntentRegistry Tests ---
PASS: Registry initializes from rule tables
PASS: Registry has correct intent count
PASS: Registry tracks rule table version (P5)
PASS: P1: isKnown returns true for valid intent
PASS: P1: isKnown returns false for unknown intent
PASS: Get intent by trigger
PASS: Zod parameter validation - valid
PASS: Zod parameter validation - missing required

--- IntentParseRequestEnvelope Tests ---
PASS: Create simple request
PASS: Create deterministic request (P2: no LLM)
PASS: Create confirmation request (P3: always confirm)
PASS: Clinical modes
PASS: Request validation rejects empty rawText

--- IntentParseEnvelope Tests ---
PASS: Create success envelope
PASS: P4: Dual confidence in envelope
PASS: Create clarification envelope
PASS: P1: Create outside allowlist envelope
PASS: Parse tier tracking (P2)
PASS: Parameter source tracking

--- IntentConfirmEnvelope Tests ---
PASS: Create user confirmation
PASS: Create auto confirmation
PASS: Confirmation sources

=== TEST SUMMARY ===
Passed: 26
Failed: 0
Total: 26

All tests passed!
```

### Manual Verification

```javascript
// Quick verification script
import { loadRuleTables } from './src/healthcare/nls/rules/index.js';
import { getIntentRegistryAsync } from './src/healthcare/nls/IntentRegistry.js';
import { createSimpleRequest, createSuccessEnvelope, ParameterSource } from './src/healthcare/nls/index.js';

const rules = await loadRuleTables();
console.log('Rules version:', rules.version);
console.log('Intent count:', rules.intents.length);

const registry = await getIntentRegistryAsync();
console.log('Registry version:', registry.getRuleTableVersion());
console.log('Known intents:', registry.getAllIntentIds());

const request = createSimpleRequest('/staging P001', { userId: 'test' });
console.log('Request schema:', request.header.schemaId);

const envelope = createSuccessEnvelope({
  intentId: 'clinical.staging.readiness',
  intentFamily: 'clinical',
  parameters: [{ name: 'patientId', value: 'P001', source: ParameterSource.EXPLICIT, confidence: 1.0 }],
  parseConfidence: 1.0,
  originalText: '/staging P001',
  trace: { parserUsed: 'rule-based', tier: 1, parseTimeMs: 2 }
});
console.log('Envelope intent:', envelope.payload.intentId);
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-05 | Initial Zod-based implementation with P1-P5 principles |

---

*Healthcare Intent Classification System - Metalligent Healthcare Platform*
