# Healthcare Intent Classification System

## Overview

A closed-world, deterministic-first intent classification system for healthcare using **Zod** for type-safe validation.

## Core Principles

| ID | Principle | Description |
|----|-----------|-------------|
| P1 | Closed-world | Only intents in the allowlist are valid |
| P2 | Deterministic-first | Tier 1 triggers → Tier 2 patterns → Tier 3 LLM |
| P3 | Clarify, don't guess | Ask user when uncertain |
| P4 | Dual confidence | parseConfidence (classification) vs decisionConfidence (clinical) |
| P5 | Auditability | Version pinning, trace logging |

---

## Architecture

```
User Input
    │
    ▼
┌─────────────────────────────────┐
│  IntentParseRequestEnvelope     │
│  - rawText                      │
│  - context (userId, orgId, etc) │
│  - constraints (allowLLMParse)  │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│       IntentRegistry            │
│  - Loads from rule tables       │
│  - Zod parameter validation     │
│  - P1: isKnown() check          │
└─────────────────────────────────┘
    │
    ├── Tier 1: /staging P001 → confidence 1.0
    ├── Tier 2: "staging readiness for P001" → pattern match
    └── Tier 3: LLM (if allowed)
    │
    ▼
┌─────────────────────────────────┐
│    IntentParseEnvelope          │
│  - intentId                     │
│  - parseConfidence              │
│  - decisionConfidence (P4)      │
│  - trace.ruleTableVersion (P5)  │
└─────────────────────────────────┘
    │
    ▼ (if requiresClarification)
┌─────────────────────────────────┐
│   IntentConfirmEnvelope         │
│  - parseEnvelopeId (UUID)       │
│  - confirmedIntentId            │
│  - confirmedParameters          │
│  - userAcknowledged             │
└─────────────────────────────────┘
```

---

## File Structure

```
src/healthcare/nls/
├── index.js                      # Exports
├── IntentRegistry.js             # Registry with Zod validation
├── NaturalLanguageService.js     # Main service
│
├── contracts/zod/
│   ├── IntentParseRequestEnvelope.js
│   ├── IntentParseEnvelope.js
│   └── IntentConfirmEnvelope.js
│
├── rules/
│   ├── index.js                  # Rule loader
│   ├── rule-schema.js            # Zod validation for rules
│   └── clinical-intents.json     # Intent definitions
│
└── parsers/
    ├── RuleBasedParser.js
    └── LLMParser.js
```

---

## Zod Schemas

### 1. IntentParseRequestEnvelope

Input to the NLS parser.

**Schema Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.rawText` | string | Yes | User input (1-2000 chars) |
| `payload.context.userId` | string | No | User making request |
| `payload.context.orgId` | string | No | Organization |
| `payload.context.patientId` | string | No | Patient context |
| `payload.context.clinicalMode` | enum | No | Default: 'standard' |
| `payload.constraints.allowLLMParse` | boolean | No | Default: true |
| `payload.constraints.forceConfirm` | boolean | No | Default: false |
| `payload.constraints.maxParseTimeMs` | number | No | Default: 5000 |

**Clinical Modes:**
- `standard`
- `emergency_triage`
- `phi_protection`
- `medication_safety`
- `staging_readiness`

**Factory Functions:**

```javascript
import {
  createSimpleRequest,
  createDeterministicRequest,
  createConfirmationRequest,
  ClinicalMode
} from './contracts/zod/IntentParseRequestEnvelope.js';

// Basic request
const req = createSimpleRequest(
  'staging readiness for patient P001',  // rawText
  { userId: 'user-123', orgId: 'org-456' },  // context
  { allowLLMParse: true }  // constraints
);

// P2: Deterministic only (no LLM)
const detReq = createDeterministicRequest(
  '/staging P001',
  { userId: 'user-123' }
);

// P3: Always require confirmation
const confReq = createConfirmationRequest(
  'staging readiness for P001',
  { userId: 'user-123', clinicalMode: ClinicalMode.STAGING_READINESS }
);
```

---

### 2. IntentParseEnvelope

Output from the NLS parser.

**Schema Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.intentId` | string/null | Yes | Classified intent (null if clarification needed) |
| `payload.intentFamily` | enum | Yes | 'clinical', 'administrative', 'system' |
| `payload.parameters` | array | Yes | Extracted parameters |
| `payload.parseConfidence` | number | Yes | P4: Classification certainty (0-1) |
| `payload.decisionConfidence` | number | No | P4: Clinical appropriateness (0-1) |
| `payload.requiresClarification` | boolean | Yes | Whether user input needed |
| `payload.clarification` | object | No | Clarification details |
| `payload.originalText` | string | Yes | Original user input |
| `payload.trace` | object | Yes | P5: Audit trace |

**Parameter Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Parameter name |
| `value` | any | Yes | Parameter value |
| `source` | enum | Yes | 'explicit', 'inferred', 'default', 'context' |
| `confidence` | number | Yes | Confidence in value (0-1) |

**Trace Schema (P5):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `parserUsed` | enum | Yes | 'rule-based', 'llm', 'hybrid', 'confirmed' |
| `tier` | number | No | 1, 2, or 3 |
| `parseTimeMs` | number | Yes | Parse duration |
| `ruleTableVersion` | string | No | Version for reproducibility |
| `llmInvoked` | boolean | No | Whether LLM was used |

**Clarification Reasons (P1, P3):**
- `ambiguous_intent`
- `missing_required_parameter`
- `multiple_intent_matches`
- `low_confidence`
- `unknown_entity`
- `outside_allowlist` (P1: not in closed-world)

**Factory Functions:**

```javascript
import {
  createSuccessEnvelope,
  createClarificationEnvelope,
  createOutsideAllowlistEnvelope,
  ParameterSource,
  ClarificationReason
} from './contracts/zod/IntentParseEnvelope.js';

// Success - intent resolved
const success = createSuccessEnvelope({
  intentId: 'clinical.staging.readiness',
  intentFamily: 'clinical',
  parameters: [{
    name: 'patientId',
    value: 'P001',
    source: ParameterSource.INFERRED,
    confidence: 0.95
  }],
  parseConfidence: 0.95,
  decisionConfidence: 0.85,  // Optional, clinical only
  originalText: 'staging readiness for patient P001',
  trace: {
    parserUsed: 'rule-based',
    tier: 2,
    parseTimeMs: 12,
    ruleTableVersion: 'clinical-intents.json@1.0.0'
  }
});

// Clarification needed
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
  trace: {
    parserUsed: 'rule-based',
    parseTimeMs: 5
  }
});

// P1: Intent not in allowlist
const unknown = createOutsideAllowlistEnvelope({
  originalText: 'do something unknown',
  message: 'Command not recognized. Use /help for available commands.',
  trace: {
    parserUsed: 'rule-based',
    parseTimeMs: 3
  }
});
```

---

### 3. IntentConfirmEnvelope

User confirmation when clarification was needed.

**Schema Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload.parseEnvelopeId` | string (UUID) | Yes | Reference to original parse |
| `payload.confirmedIntentId` | string | Yes | Intent user confirmed |
| `payload.confirmedParameters` | array | No | Confirmed parameters |
| `payload.userAcknowledged` | boolean | Yes | Explicit user consent |
| `payload.confirmationSource` | enum | No | How confirmed |
| `payload.additionalContext` | string | No | User notes |

**Confirmed Parameter Schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Parameter name |
| `value` | any | Yes | Confirmed value |
| `userModified` | boolean | No | True if user changed it |

**Confirmation Sources:**
- `user_selection` - User picked from options
- `user_typed` - User typed explicit input
- `system_auto` - Auto-confirmed (high confidence)
- `clinical_override` - Clinician override

**Factory Functions:**

```javascript
import {
  createUserConfirm,
  createAutoConfirm,
  ConfirmationSource
} from './contracts/zod/IntentConfirmEnvelope.js';

// User explicitly confirmed
const confirm = createUserConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440000',  // Must be valid UUID
  confirmedIntentId: 'clinical.staging.readiness',
  confirmedParameters: [{
    name: 'patientId',
    value: 'P001',
    userModified: false
  }]
});

// System auto-confirmed (high confidence, non-clinical)
const auto = createAutoConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440001',
  confirmedIntentId: 'hc:help',
  confirmedParameters: [],
  additionalContext: 'High confidence tier 1 match'
});
```

---

## Rule Tables

### clinical-intents.json

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-02-05T00:00:00.000Z",
  "intents": [
    {
      "intentId": "clinical.staging.readiness",
      "domain": "staging",
      "name": "Staging Readiness Assessment",
      "intentFamily": "clinical",
      "triggers": ["/staging-readiness", "/staging"],
      "patterns": [
        {
          "regex": "staging\\s+readiness\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[A-Z]{2,3}-?\\d{3,10})",
          "weight": 0.85
        }
      ],
      "requiredParameters": [
        { "name": "patientId", "type": "patientId" }
      ],
      "recipe": "clinical-staging-readiness",
      "clinicalSafetyLevel": "advisory"
    }
  ]
}
```

### Rule Loader

```javascript
import { loadRuleTables, getCurrentVersion, clearRuleCache } from './rules/index.js';

const rules = await loadRuleTables();
console.log(rules.version);  // "clinical-intents.json@1.0.0"
console.log(rules.intents.length);  // 2

// Check if intent exists
const found = rules.isKnownIntent('clinical.staging.readiness');  // true
```

---

## IntentRegistry

```javascript
import { getIntentRegistryAsync } from './IntentRegistry.js';

const registry = await getIntentRegistryAsync();

// P1: Closed-world check
registry.isKnown('clinical.staging.readiness');  // true
registry.isKnown('fake.intent');  // false

// Get by trigger
const intent = registry.getIntentByTrigger('/staging');

// P5: Version tracking
registry.getRuleTableVersion();  // "clinical-intents.json@1.0.0"

// Zod parameter validation
const result = registry.validateParameters('clinical.staging.readiness', [
  { name: 'patientId', value: 'P001' }
]);
// { isValid: true, value: { patientId: 'P001' } }

// Check missing required
const missing = registry.getMissingRequired('clinical.staging.readiness', []);
// ['patientId']
```

---

## Parse Tiers (P2)

| Tier | Method | Confidence | Example |
|------|--------|------------|---------|
| 1 | Slash commands | 1.0 | `/staging P001` |
| 2 | Regex patterns | 0.7-0.95 | "staging readiness for patient P001" |
| 3 | LLM | 0.5-0.9 | "is the patient ready to be staged?" |

Always try Tier 1-2 before Tier 3.

---

## Testing

```bash
node src/healthcare/nls/test-all.mjs
```

Expected output:
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

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-05 | Initial Zod implementation |
