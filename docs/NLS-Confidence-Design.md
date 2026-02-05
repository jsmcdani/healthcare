# Healthcare Confidence System - Design Document

## Overview

The Metalligent Healthcare platform uses **central confidence computation** following the architecture spec (`connfidenc.xml`). Confidence is computed by the **control plane** (platform), never self-reported by the LLM.

### Two Levels of Confidence

1. **Clinical Response Confidence** (PRIMARY) - Confidence in the clinical decision/insight/recommendation returned to patient or provider
2. **Parse Confidence** (SECONDARY) - Confidence in NLS intent classification

**Both use the same central confidence computation architecture - same model applies whether LLM or deterministic execution was used.**

### Core Principle

> "Confidence is computed centrally (registry-driven) and pinned by version across deterministic execution and AI expert consultation — never self-reported by the LLM."

---

# Part 1: Clinical Response Confidence (PRIMARY)

This is the MAIN confidence system - computes confidence for clinical decisions, insights, and recommendations returned to patients and providers.

## Clinical Confidence Models

Located in `src/healthcare/confidence/config/default-models.js`:

| Model | Domain | Use Case | Higher Thresholds? |
|-------|--------|----------|-------------------|
| `clinical_readiness_v1` | General | Default clinical decisions | No |
| `drug_interaction_v1` | Pharmacy | Drug interaction safety | Yes (0.90 for HIGH) |
| `care_gap_v1` | Quality | Care gap detection | No |
| `diagnostic_assessment_v1` | Diagnostic | Diagnosis support | No |

## Model Selection (By Intent, NOT by LLM Usage)

The confidence model is selected based on **intent/mode**, NOT based on whether LLM was used:

```
Intent: drug-interaction-check
Mode: PHARMACY
         ↓
Registry selects: drug_interaction_v1
         ↓
Recipe executes (may use LLM or not)
         ↓
SAME model computes confidence regardless of path
```

**Example - Same intent with and without LLM:**
```
Patient Summary (no LLM):  Model=clinical_readiness_v1, Confidence=0.87 (HIGH)
Patient Summary (with LLM): Model=clinical_readiness_v1, Confidence=0.87 (HIGH)
                            ↑ SAME MODEL, SAME CONFIDENCE
```

## Clinical Confidence Factors

| Factor | Weight | Description |
|--------|--------|-------------|
| `data_completeness` | 25% | How complete is the patient data |
| `data_quality` | 20% | Quality/freshness of data |
| `source_reliability` | 20% | Reliability of data sources |
| `model_certainty` | 20% | Certainty of underlying calculations |
| `evidence_level` | 15% | Strength of clinical evidence |

## Clinical Penalties

- `missingCriticalData` - 30% penalty
- `hasDataConflict` - 15% penalty
- `guidelinesOutdated` - 10% penalty
- `llmFallback` - 20% penalty (when LLM failed, using fallback)
- `syntheticData` - 40% penalty (demo/test data)

## Clinical Boosts

- `hasMultipleSources` - +10% boost
- `recentlyValidated` - +5% boost
- `expertReviewed` - +15% boost

## Safety Flags

| Flag | Trigger | Meaning |
|------|---------|---------|
| `MISSING_CRITICAL` | Critical data missing | Cannot provide reliable clinical guidance |
| `CONFLICTING_DATA` | Contradictory data | Evidence conflicts, uncertain conclusion |
| `I_DONT_KNOW` | Insufficient evidence | System cannot make determination |
| `OUTDATED_SOURCE` | Old reference data | May not reflect current guidelines |

## Integration Point

**File:** `src/healthcare/confidence/ClinicalConfidenceIntegration.js`

```javascript
import { calculateClinicalConfidence } from './ClinicalConfidenceIntegration.js';

// After recipe execution
const confidence = calculateClinicalConfidence(
  { intentId: 'patient-summary', intentMode: 'CLINICAL_DECISION_SUPPORT', recipeId: 'recipe-v1' },
  { dataCompleteness: 0.9, sourceReliability: 0.8, llmUsed: true, multipleSources: true }
);

// Result:
// { value: 0.87, level: 'HIGH', canProceed: true, modelId: 'clinical_readiness_v1' }
```

---

# Part 2: NLS Parse Confidence (SECONDARY)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Input                                      │
│                     "/patient MRN-12345" or "show patient"                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NaturalLanguageService                             │
│                         (Orchestrator / Control Plane)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
┌───────────────────────────────┐     ┌───────────────────────────────┐
│       RuleBasedParser         │     │         LLMParser             │
│      (Tier 1, 2 matching)     │     │      (Tier 3 fallback)        │
│                               │     │                               │
│  Outputs: RAW SIGNALS ONLY    │     │  Outputs: RAW SIGNALS ONLY    │
│  - matchType: 'trigger'       │     │  - matchType: 'llm'           │
│  - rawWeight: 0.95            │     │  - llmRawConfidence: 0.8      │
│  - entityCompleteness: 1.0    │     │  - llmReasoning: "..."        │
│  - hasAmbiguity: false        │     │  - hasAmbiguity: true         │
│                               │     │                               │
│  DOES NOT OUTPUT CONFIDENCE   │     │  DOES NOT OUTPUT CONFIDENCE   │
└───────────────────────────────┘     └───────────────────────────────┘
                    │                                   │
                    └─────────────────┬─────────────────┘
                                      │ raw signals
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     NLSConfidenceIntegration                                 │
│                    (Central Confidence Computation)                          │
│                                                                             │
│  1. Maps parser tier to source_reliability:                                 │
│     - trigger: 1.0 (highest)                                               │
│     - pattern: 0.8                                                         │
│     - synonym: 0.6                                                         │
│     - llm: 0.65                                                            │
│     - confirmed: 1.0 (user confirmed)                                      │
│     - none: 0.0                                                            │
│                                                                             │
│  2. Builds factors for ConfidenceCalculator                                │
│  3. Builds conditions for penalties/boosts                                 │
│  4. Calls ConfidenceCalculator.calculate()                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ConfidenceCalculator                                 │
│                    (Pluggable Model-Based Engine)                           │
│                                                                             │
│  Uses: nls-intent-parsing.confidence.json                                  │
│  Model ID: nls_intent_parsing_v1 @ 1.0.0                                   │
│                                                                             │
│  1. Check uncertainty triggers (Mount Sinai "I don't know")                │
│  2. Calculate weighted factor scores                                       │
│  3. Apply penalties (multiplicative)                                       │
│  4. Apply boosts (additive)                                                │
│  5. Classify level (HIGH/MODERATE/LOW/UNCERTAIN)                           │
│  6. Return calibrated confidence with audit trail                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         IntentParseEnvelope                                  │
│                        (Output with Audit Trail)                            │
│                                                                             │
│  {                                                                          │
│    payload: {                                                               │
│      intentId: "hc:patient-summary",                                       │
│      parseConfidence: 1.0,           // FROM CONTROL PLANE                 │
│      trace: {                                                              │
│        confidenceModel: "nls_intent_parsing_v1",                           │
│        confidenceModelVersion: "1.0.0",                                    │
│        confidenceLevel: "HIGH",                                            │
│        confidenceBoosts: ["exact_trigger", "all_entities_found"],          │
│        canProceed: true,                                                   │
│        safetyFlag: null                                                    │
│      }                                                                      │
│    }                                                                        │
│  }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Confidence Pack: `nls-intent-parsing.confidence.json`

**Location:** `src/healthcare/packs/confidence/nls-intent-parsing.confidence.json`

This is the confidence model definition used by NLS. It follows the Metalligent confidence pack format.

### Model Identity

```json
{
  "modelId": "nls_intent_parsing_v1",
  "modelVersion": "1.0.0",
  "name": "NLS Intent Parsing Confidence Model",
  "description": "Confidence model for Natural Language Service intent classification..."
}
```

### Factors (Weighted Inputs)

The model uses 4 weighted factors that sum to 1.0:

| Factor | Weight | Source | Description |
|--------|--------|--------|-------------|
| `parser_certainty` | 0.35 | `model_certainty` | Raw parser output (pattern weight or LLM raw score) |
| `parser_tier_reliability` | 0.30 | `source_reliability` | Tier-based reliability (trigger=1.0, pattern=0.8, llm=0.65) |
| `entity_completeness` | 0.25 | `data_completeness` | Ratio of extracted vs required entities |
| `query_clarity` | 0.10 | `data_quality` | Query length-based clarity score |

### Penalties (Multiplicative)

Applied when negative conditions are detected:

| Penalty | Condition | Multiplier | Effect |
|---------|-----------|------------|--------|
| `ambiguous_intent` | `ambiguousIntent` | 0.70 | -30% when multiple intents match |
| `missing_required_params` | `missingRequiredParams` | 0.75 | -25% when required params missing |
| `llm_fallback` | `llmFallback` | 0.85 | -15% when LLM fallback was needed |
| `low_pattern_match` | `lowPatternMatch` | 0.80 | -20% when pattern confidence < 0.7 |
| `partial_entity_match` | `partialEntityMatch` | 0.90 | -10% for partial entity extraction |

### Boosts (Additive)

Applied when positive conditions are detected:

| Boost | Condition | Value | Effect |
|-------|-----------|-------|--------|
| `exact_trigger` | `exactTriggerMatch` | +0.10 | +10% for slash command match |
| `all_entities_found` | `allEntitiesExtracted` | +0.08 | +8% when all entities extracted |
| `high_pattern_weight` | `highPatternWeight` | +0.05 | +5% for pattern weight > 0.9 |
| `single_clear_match` | `singleClearMatch` | +0.10 | +10% for unambiguous single match |

### Thresholds

| Level | Threshold | Meaning |
|-------|-----------|---------|
| HIGH | ≥ 0.85 | Safe to proceed automatically |
| MODERATE | ≥ 0.65 | Proceed with caution |
| LOW | ≥ 0.40 | May proceed but warn user |
| UNCERTAIN | < 0.40 | Cannot proceed, clarification required |

### Uncertainty Triggers (Mount Sinai Safety Feature)

These conditions immediately return confidence=0 with `safetyFlag: "I_DONT_KNOW"`:

- `no_intent_match` - No intent matched the query
- `conflicting_intents` - Multiple conflicting intents detected
- `insufficient_query_length` - Query too short to parse reliably
- `outside_intent_allowlist` - Intent not in closed-world allowlist

## Why This Architecture?

### 1. Separation of Concerns

**Parsers** (RuleBasedParser, LLMParser) focus on:
- Pattern matching
- Entity extraction
- Intent identification

**Control Plane** (NLSConfidenceIntegration) focuses on:
- Calibrating confidence
- Applying business rules
- Safety checks

### 2. Consistency

The same confidence model applies whether the intent was parsed by:
- Tier 1 (trigger/slash command)
- Tier 2 (regex pattern)
- Tier 3 (LLM)
- User confirmation

### 3. Auditability (P5 Compliance)

Every decision includes:
- Model ID and version
- Factor breakdown
- Applied penalties/boosts
- Safety flags

### 4. Mount Sinai "I Don't Know" Safety

Inspired by Mount Sinai's InfEHR approach:
- When evidence is insufficient, the system says "I don't know"
- Prevents false confidence in uncertain situations
- Critical for healthcare applications

## Data Flow Example

**Input:** `/patient MRN-12345`

**Step 1: RuleBasedParser outputs raw signals**
```javascript
{
  intentId: "hc:patient-summary",
  signals: {
    matchType: "trigger",
    tier: 1,
    rawWeight: 0.95,
    queryLength: 18,
    hasAmbiguity: false,
    closeMatchCount: 0,
    entityCompleteness: 1.0,
    missingRequired: 0
  }
}
```

**Step 2: NLSConfidenceIntegration builds factors**
```javascript
{
  model_certainty: 0.95,        // from rawWeight
  source_reliability: 1.0,      // trigger tier = 1.0
  data_completeness: 1.0,       // all entities found
  data_quality: 0.8             // query length > 15 chars
}
```

**Step 3: NLSConfidenceIntegration builds conditions**
```javascript
["exactTriggerMatch", "allEntitiesExtracted", "highPatternWeight", "singleClearMatch"]
```

**Step 4: ConfidenceCalculator computes**
```
Base score: (0.95 × 0.35) + (1.0 × 0.30) + (1.0 × 0.25) + (0.8 × 0.10) = 0.9625
Penalties: none
Boosts: +0.10 + 0.08 + 0.05 + 0.10 = +0.33
Final: min(1.0, 0.9625 + 0.33) = 1.0
Level: HIGH
```

**Step 5: Output envelope**
```javascript
{
  payload: {
    intentId: "hc:patient-summary",
    parseConfidence: 1.0,
    trace: {
      confidenceModel: "nls_intent_parsing_v1",
      confidenceLevel: "HIGH",
      confidenceBoosts: ["exact_trigger", "all_entities_found", "high_pattern_weight", "single_clear_match"],
      canProceed: true
    }
  }
}
```

## Files

| File | Purpose |
|------|---------|
| `src/healthcare/nls/NLSConfidenceIntegration.js` | Control plane integration - maps parser signals to confidence factors |
| `src/healthcare/nls/NaturalLanguageService.js` | Orchestrator - coordinates parsing and confidence computation |
| `src/healthcare/nls/parsers/RuleBasedParser.js` | Tier 1/2 parser - outputs raw signals only |
| `src/healthcare/nls/parsers/LLMParser.js` | Tier 3 parser - outputs raw signals only |
| `src/healthcare/confidence/core/ConfidenceCalculator.js` | Generic confidence calculation engine |
| `src/healthcare/packs/confidence/nls-intent-parsing.confidence.json` | NLS confidence model definition |
| `src/healthcare/nls/contracts/IntentParseEnvelope.js` | Output envelope schema with confidence audit trail |

## Origin

The confidence pack system was built following:

1. **Metalligent Architecture Spec** (`connfidenc.xml`) - Defines the control plane approach
2. **Mount Sinai InfEHR Paper** - "I don't know" uncertainty quantification
3. **Healthcare Compliance Requirements** - HIPAA audit trail needs

The `nls-intent-parsing.confidence.json` model was specifically designed for NLS intent classification, with factors tuned for the 4-tier parsing system (triggers → patterns → synonyms → LLM).

## Test Results

```
/patient MRN-12345
  Intent: hc:patient-summary
  Confidence: 1 (HIGH)
  Boosts: exact_trigger, all_entities_found, high_pattern_weight, single_clear_match

show patient info
  Intent: hc:patient-summary
  Confidence: 1 (HIGH)

gibberish xyz
  Intent: null
  Confidence: 0 (UNCERTAIN)
  SafetyFlag: I_DONT_KNOW
  Clarification: true
```
