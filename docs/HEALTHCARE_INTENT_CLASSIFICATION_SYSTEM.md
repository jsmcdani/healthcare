# Healthcare Intent Classification System

## Overview

A closed-world, deterministic-first intent classification system for healthcare applications using **Zod** for type-safe, deterministic validation.

## Core Principles

| Principle | Description |
|-----------|-------------|
| **P1** | Closed-world intent universe (allowlist only) |
| **P2** | Deterministic-first (explicit → rules → optional LLM) |
| **P3** | Clarify, don't guess |
| **P4** | Dual confidence (parseConfidence vs decisionConfidence) |
| **P5** | Auditability + version pinning |

## Architecture

```
User Input
    │
    ▼
┌─────────────────────────────────┐
│  IntentParseRequestEnvelope     │  ← Zod-validated request
│  (rawText, context, constraints)│
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│       IntentRegistry            │  ← Loads from rule tables
│  (closed-world allowlist)       │
└─────────────────────────────────┘
    │
    ├── Tier 1: Slash command triggers (/staging, /med-safety)
    ├── Tier 2: Regex pattern matching
    └── Tier 3: LLM classification (if allowed)
    │
    ▼
┌─────────────────────────────────┐
│    IntentParseEnvelope          │  ← Zod-validated result
│  (dual confidence, audit trace) │
└─────────────────────────────────┘
    │
    ▼ (if requiresClarification)
┌─────────────────────────────────┐
│   IntentConfirmEnvelope         │  ← User acknowledgment
│  (confirmed params, source)     │
└─────────────────────────────────┘
```

## File Structure

```
src/healthcare/nls/
├── index.js                          # Module exports (Zod schemas)
├── IntentRegistry.js                 # Intent registry with Zod validation
├── NaturalLanguageService.js         # Main NLS service
│
├── contracts/zod/                    # Zod-based contracts
│   ├── IntentParseRequestEnvelope.js # Request with clinical modes
│   ├── IntentParseEnvelope.js        # Result with dual confidence
│   └── IntentConfirmEnvelope.js      # User confirmation
│
├── rules/                            # Rule table system
│   ├── index.js                      # Rule loader with caching
│   ├── rule-schema.js                # Zod validation for rules
│   └── clinical-intents.json         # Clinical intent definitions
│
├── parsers/
│   ├── RuleBasedParser.js            # Tier 1-2 parsing
│   └── LLMParser.js                  # Tier 3 parsing
│
└── extractors/
    └── EntityExtractor.js            # Entity extraction
```

## Zod Schemas

### IntentParseRequestEnvelope

Request envelope for intent parsing with clinical context.

```javascript
import { createSimpleRequest, ClinicalMode } from './contracts/zod/IntentParseRequestEnvelope.js';

const request = createSimpleRequest('staging readiness for patient P001', {
  userId: 'clinician-123',
  orgId: 'hospital-abc',
  patientId: 'P001',
  clinicalMode: ClinicalMode.STAGING_READINESS
}, {
  allowLLMParse: true,      // Allow Tier 3 if needed
  forceConfirm: false,      // Don't force confirmation
  maxParseTimeMs: 5000      // 5 second timeout
});
```

**Clinical Modes:**
- `standard` - Normal clinical operations
- `emergency_triage` - Emergency department triage
- `phi_protection` - PHI-sensitive context
- `medication_safety` - Medication interaction checks
- `staging_readiness` - Clinical staging assessments

### IntentParseEnvelope

Result envelope with dual confidence and audit trail.

```javascript
import {
  createSuccessEnvelope,
  ParameterSource,
  ParseTier
} from './contracts/zod/IntentParseEnvelope.js';

const result = createSuccessEnvelope({
  intentId: 'clinical.staging.readiness',
  intentFamily: 'clinical',
  parameters: [{
    name: 'patientId',
    value: 'P001',
    source: ParameterSource.INFERRED,  // Extracted from text
    confidence: 0.95
  }],
  parseConfidence: 0.95,      // P4: Classification certainty
  decisionConfidence: 0.85,   // P4: Clinical appropriateness
  originalText: 'staging readiness for patient P001',
  trace: {
    parserUsed: 'rule-based',
    tier: ParseTier.TIER_2_PATTERN,
    parseTimeMs: 12,
    ruleTableVersion: 'clinical-intents.json@1.0.0'  // P5: Auditability
  }
});
```

**Dual Confidence (P4):**
- `parseConfidence` - How confident the system understood the intent
- `decisionConfidence` - How appropriate this action is clinically (optional)

**Clarification Reasons (P1, P3):**
- `ambiguous_intent` - Multiple possible meanings
- `missing_required_parameter` - Required param not found
- `multiple_intent_matches` - Several intents match equally
- `low_confidence` - Below threshold
- `unknown_entity` - Entity not recognized
- `outside_allowlist` - **P1: Intent not in closed-world allowlist**

### IntentConfirmEnvelope

User acknowledgment when clarification was needed.

```javascript
import {
  createUserConfirm,
  ConfirmationSource
} from './contracts/zod/IntentConfirmEnvelope.js';

const confirmation = createUserConfirm({
  parseEnvelopeId: 'parse-123',
  intentId: 'clinical.staging.readiness',
  parameters: [{
    name: 'patientId',
    value: 'P001',
    originalValue: 'patient P001',
    source: ConfirmationSource.USER_SELECTION
  }]
});
```

**Confirmation Sources:**
- `user_selection` - User selected from options
- `user_typed` - User typed a value
- `system_auto` - System auto-confirmed (high confidence)
- `clinical_override` - Clinician override

## Rule Tables

### Schema (rule-schema.js)

```javascript
import { validateRuleTable, validateIntentRule } from './rules/rule-schema.js';

// Validates entire rule table JSON
const result = validateRuleTable(jsonData);
if (!result.success) {
  console.error('Validation errors:', result.error.errors);
}
```

### Clinical Intents (clinical-intents.json)

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

// Load with 5-minute caching
const rules = await loadRuleTables();
console.log('Version:', rules.version);  // "clinical-intents.json@1.0.0"

// Get specific intent
const intent = rules.getIntent('clinical.staging.readiness');

// Clear cache to force reload
clearRuleCache();
```

## IntentRegistry

Central registry that loads from rule tables with Zod parameter validation.

```javascript
import { getIntentRegistryAsync } from './IntentRegistry.js';

const registry = await getIntentRegistryAsync();

// P1: Closed-world check
if (!registry.isKnown(intentId)) {
  // Return OUTSIDE_ALLOWLIST clarification
}

// Get intent definition
const intent = registry.getIntent('clinical.staging.readiness');

// Zod-based parameter validation
const validation = registry.validateParameters(intentId, [
  { name: 'patientId', value: 'P001' }
]);

if (!validation.isValid) {
  console.error('Missing:', validation.missingFields);
}

// P5: Get rule table version for audit
const version = registry.getRuleTableVersion();
```

## Parse Tiers (P2)

| Tier | Method | Confidence | Example |
|------|--------|------------|---------|
| **1** | Slash commands | 1.0 | `/staging P001` |
| **2** | Regex patterns | 0.7-0.95 | "staging readiness for patient P001" |
| **3** | LLM classification | 0.5-0.9 | "is the patient ready to be staged?" |

Deterministic-first: Always try Tier 1-2 before Tier 3.

## Usage Example

```javascript
import {
  getNaturalLanguageService,
  createSimpleRequest,
  ClarificationReason
} from './src/healthcare/nls/index.js';

const nls = await getNaturalLanguageService();

// Parse user input
const request = createSimpleRequest('staging readiness for patient P001', {
  userId: 'clinician-123',
  orgId: 'hospital-abc'
});

const result = await nls.parse(request);

if (result.payload.requiresClarification) {
  if (result.payload.clarification.reason === ClarificationReason.OUTSIDE_ALLOWLIST) {
    // P1: Intent not recognized
    console.log('Unknown command. Use /help for available commands.');
  } else {
    // P3: Clarify, don't guess
    console.log(result.payload.clarification.message);
  }
} else {
  // Execute the intent
  console.log('Intent:', result.payload.intentId);
  console.log('Confidence:', result.payload.parseConfidence);
  console.log('Tier:', result.payload.trace.tier);
}
```

## Why Zod?

1. **Deterministic validation** - Same input always produces same output
2. **Type inference** - TypeScript types generated from schemas
3. **Composable schemas** - Build complex types from simple ones
4. **Parse, don't validate** - Returns typed data, not just boolean
5. **Rich error messages** - Detailed validation errors with paths

## Testing

```bash
# Run comprehensive test
node --input-type=module -e "
import { loadRuleTables } from './src/healthcare/nls/rules/index.js';
import { getIntentRegistryAsync } from './src/healthcare/nls/IntentRegistry.js';
import { createSimpleRequest, createSuccessEnvelope, ParameterSource } from './src/healthcare/nls/index.js';

const rules = await loadRuleTables();
const registry = await getIntentRegistryAsync();

console.log('Rule version:', rules.version);
console.log('Total intents:', registry.getAllIntentIds().length);
console.log('Test passed!');
"
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-05 | Initial Zod-based implementation |

---

*Generated for Metalligent Healthcare Platform*
