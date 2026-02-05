# Healthcare Intent Classification System

## Purpose

Classify healthcare user requests into structured intents using a closed-world, deterministic-first approach with Zod validation.

**What this does:**
- Takes user input like "/staging P001" or "check drug interactions"
- Classifies it into a known healthcare intent
- Extracts parameters (patientId, medications, etc.)
- Returns structured envelope for downstream processing

**What this is NOT:**
- Not the NLS service itself (that uses this)
- Not the recipe executor
- Not the UI layer

---

## Core Principles

| ID | Principle | Implementation |
|----|-----------|----------------|
| **P1** | Closed-world intent allowlist | Only intents in rule tables are valid. Unknown = `OUTSIDE_ALLOWLIST` |
| **P2** | Deterministic-first | Tier 1 (triggers) → Tier 2 (patterns) → Tier 3 (LLM optional) |
| **P3** | Clarify, don't guess | When uncertain, ask user via clarification envelope |
| **P4** | Dual confidence | `parseConfidence` (did we understand?) vs `decisionConfidence` (is it appropriate?) |
| **P5** | Auditability | `ruleTableVersion` in trace for reproducibility |

---

## Classification Flow

```
User Input: "staging readiness for patient P001"
                    │
                    ▼
            ┌───────────────┐
            │ Tier 1 Check  │  Exact trigger match?
            │ /staging      │  No match
            └───────┬───────┘
                    │
                    ▼
            ┌───────────────┐
            │ Tier 2 Check  │  Pattern match?
            │ regex + weight│  MATCH: "staging readiness...patient P001"
            └───────┬───────┘
                    │
                    ▼
            ┌───────────────────────────────┐
            │ Result:                       │
            │   intentId: clinical.staging  │
            │   patientId: P001 (extracted) │
            │   parseConfidence: 0.85       │
            │   tier: 2                     │
            └───────────────────────────────┘
```

---

## Zod Contracts

### 1. IntentParseRequestEnvelope (Input)

What goes IN to classification.

```javascript
import { createSimpleRequest } from './contracts/zod/IntentParseRequestEnvelope.js';

const request = createSimpleRequest(
  'staging readiness for patient P001',   // rawText
  { userId: 'doc-123', patientId: 'P001' }, // context
  { allowLLMParse: false }                  // constraints (P2: no LLM)
);
```

**Key Fields:**
| Field | Description |
|-------|-------------|
| `payload.rawText` | User input text |
| `payload.context.userId` | Who is asking |
| `payload.context.patientId` | Patient context |
| `payload.context.clinicalMode` | standard, emergency_triage, medication_safety, etc. |
| `payload.constraints.allowLLMParse` | P2: Allow Tier 3? |
| `payload.constraints.forceConfirm` | P3: Always ask for confirmation? |

---

### 2. IntentParseEnvelope (Output)

What comes OUT of classification.

```javascript
import { createSuccessEnvelope, ParameterSource } from './contracts/zod/IntentParseEnvelope.js';

const result = createSuccessEnvelope({
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
```

**Key Fields:**
| Field | Description |
|-------|-------------|
| `payload.intentId` | Classified intent (null if needs clarification) |
| `payload.intentFamily` | clinical, administrative, system |
| `payload.parameters[]` | Extracted params with source + confidence |
| `payload.parseConfidence` | P4: How sure we understood (0-1) |
| `payload.decisionConfidence` | P4: How appropriate for patient (0-1, optional) |
| `payload.requiresClarification` | P3: Need user input? |
| `payload.trace.tier` | P2: Which tier resolved it |
| `payload.trace.ruleTableVersion` | P5: For audit |

**Parameter Sources:**
- `explicit` - User typed it directly ("/staging P001")
- `inferred` - Extracted from natural language
- `default` - System default
- `context` - From request context

**Clarification Reasons:**
- `ambiguous_intent` - Multiple matches
- `missing_required_parameter` - Need more info
- `low_confidence` - Below threshold
- `outside_allowlist` - P1: Unknown intent

---

### 3. IntentConfirmEnvelope (Confirmation)

When user confirms after clarification.

```javascript
import { createUserConfirm } from './contracts/zod/IntentConfirmEnvelope.js';

const confirm = createUserConfirm({
  parseEnvelopeId: '550e8400-e29b-41d4-a716-446655440000',  // UUID reference
  confirmedIntentId: 'clinical.staging.readiness',
  confirmedParameters: [{
    name: 'patientId',
    value: 'P001',
    userModified: false
  }]
});
```

**Key Fields:**
| Field | Description |
|-------|-------------|
| `payload.parseEnvelopeId` | UUID reference to original parse |
| `payload.confirmedIntentId` | What user confirmed |
| `payload.confirmedParameters[]` | Params with `userModified` flag |
| `payload.userAcknowledged` | P3: Explicit consent |
| `payload.confirmationSource` | user_selection, user_typed, system_auto, clinical_override |

---

## Rule Tables

Intent definitions loaded from JSON. P1: Only these intents are valid.

### Schema

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
          "regex": "staging\\s+readiness\\s+(?:for\\s+)?(?:patient\\s+)?(?<patientId>[A-Z0-9-]+)",
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

### Current Clinical Intents

| Intent ID | Domain | Triggers | Required Params |
|-----------|--------|----------|-----------------|
| `clinical.staging.readiness` | staging | /staging, /staging-readiness | patientId |
| `clinical.med_safety.check` | medication_safety | /med-safety, /ddi, /drug-check | (none) |

### Clinical Safety Levels

| Level | Description |
|-------|-------------|
| `informational` | Read-only display |
| `advisory` | Recommendations |
| `action_required` | Needs clinical action |
| `critical` | High-risk, requires confirmation |

---

## IntentRegistry

Central registry for intent lookup and validation.

```javascript
import { getIntentRegistryAsync } from './IntentRegistry.js';

const registry = await getIntentRegistryAsync();

// P1: Is this a known intent?
registry.isKnown('clinical.staging.readiness');  // true
registry.isKnown('unknown.intent');               // false

// Get by trigger
registry.getIntentByTrigger('/staging');

// P5: Version for audit
registry.getRuleTableVersion();  // "clinical-intents.json@1.0.0"

// Zod parameter validation
registry.validateParameters('clinical.staging.readiness', [
  { name: 'patientId', value: 'P001' }
]);
// { isValid: true, value: { patientId: 'P001' } }
```

---

## Files

```
src/healthcare/nls/
├── contracts/zod/
│   ├── IntentParseRequestEnvelope.js   # Input
│   ├── IntentParseEnvelope.js          # Output
│   └── IntentConfirmEnvelope.js        # Confirmation
│
├── rules/
│   ├── index.js                        # Rule loader (5-min cache)
│   ├── rule-schema.js                  # Zod validation for JSON
│   └── clinical-intents.json           # Intent definitions
│
└── IntentRegistry.js                   # Registry with Zod validation
```

---

## Testing

```bash
node src/healthcare/nls/test-all.mjs
```

**26 tests covering:**
- Rule loading and validation
- Registry initialization
- All three envelope factories
- P1-P5 principle enforcement

---

## Version

| Version | Date | Notes |
|---------|------|-------|
| 1.0.0 | 2026-02-05 | Initial Zod implementation |
