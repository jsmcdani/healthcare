# NLS Confidence System — Reset & Architecture

## Overview

The NLS confidence system was rewritten to eliminate all hardcoded confidence logic
and comply with the Metalligent Healthcare control plane architecture.

**Primary framework**: Mount Sinai InfEHR approach
- Deterministic scoring (0-1) from weighted factors
- Explainability (full factor breakdown in every result)
- Clinical gating (`canProceed` blocks action when confidence insufficient)
- "I don't know" safety (uncertainty triggers → refuse rather than guess)

**Core rule**: Confidence is computed centrally by the control plane, never
self-reported by the LLM. Same model applies regardless of parser tier.

---

## What Changed

### Before (broken)
`NLSConfidenceIntegration.js` contained:
- **Hardcoded `TIER_RELIABILITY` constant** — tier-to-reliability mapping baked into JS
- **Hardcoded `calculateQueryClarity()` function** — query length buckets in code
- **Silent fallback** — returned arbitrary `0.5` confidence if model failed to load
- **Direct `fs.readFileSync`** — loaded pack JSON bypassing registry infrastructure

This was a boundary violation: a shadow system outside the control plane.

### After (compliant)
- **All signal mappings in the pack** — `signalMappings.tierReliability` and
  `signalMappings.queryClarity` stored in `nls-intent-parsing.confidence.json`
- **No hardcoded values** in integration code
- **No silent fallback** — throws `CONFIGURATION ERROR: REQUIRES_REVIEW` if pack missing
- **Version pinning** — every result includes `packVersion`, `modelId`, `modelVersion`

### RuleBasedParser.js fix
- `_matchTrigger` now uses intent's own regex patterns (named groups) before
  falling back to generic entity extraction
- Fixed: `/drug-check metformin lisinopril` was extracting medications as `patientId`

---

## Architecture

```
User Query
    │
    ▼
┌─────────────────────┐
│  RuleBasedParser     │  Tier 1 (trigger), Tier 2 (pattern/synonym)
│  or LLMParser        │  Tier 3 (LLM fallback)
│                      │
│  Outputs: raw signals│  matchType, rawWeight, entityCompleteness,
│  (NOT confidence)    │  queryLength, hasAmbiguity, missingRequired
└─────────┬───────────┘
          │
          ▼
┌─────────────────────────────────────────────────┐
│  NLSConfidenceIntegration (Control Plane)        │
│                                                  │
│  1. Load pack: nls-intent-parsing@1.0.0          │
│  2. Map signals → factors via pack signalMappings│
│     - matchType → source_reliability (tierReliab)│
│     - rawWeight → model_certainty                │
│     - entityCompleteness → data_completeness     │
│     - queryLength → data_quality (clarity)       │
│  3. Build conditions from boolean signals        │
│  4. ConfidenceCalculator.calculate()             │
│  5. Pin version in result                        │
└─────────┬───────────────────────────────────────┘
          │
          ▼
┌─────────────────────┐
│  Confidence Result   │
│                      │
│  value: 0.0 - 1.0   │
│  level: HIGH|MOD|LOW|UNCERTAIN
│  canProceed: bool    │
│  safetyFlag: ...     │
│  packVersion: 1.0.0  │
│  modelId@version     │
│  factors: {...}      │  ← full explainability
│  penalties: [...]    │
│  boosts: [...]       │
└──────────────────────┘
```

---

## Pack Structure

**File**: `src/healthcare/packs/confidence/nls-intent-parsing.confidence.json`

### Factors (weighted scoring)

| Factor | Source | Weight | GRADE-adjacent concept |
|--------|--------|--------|----------------------|
| Parser Certainty | `model_certainty` | 0.35 | Evidence strength |
| Parser Tier Reliability | `source_reliability` | 0.30 | Provenance quality |
| Entity Completeness | `data_completeness` | 0.25 | Evidence sufficiency |
| Query Clarity | `data_quality` | 0.10 | Input quality |

### Signal Mappings (from pack, not hardcoded)

**Tier Reliability** — maps parser matchType to `source_reliability` factor:

| Match Type | Reliability | Rationale |
|------------|-------------|-----------|
| trigger | 1.0 | Exact slash command — deterministic |
| confirmed | 1.0 | User confirmed intent |
| pattern | 0.8 | Regex match — high but not certain |
| llm | 0.65 | LLM classification — overconfidence risk |
| synonym | 0.6 | Keyword match — lower specificity |
| none | 0.0 | No match |

**Query Clarity** — maps query length to `data_quality` factor:

| Query Length | Clarity | Rationale |
|-------------|---------|-----------|
| < 5 chars | 0.3 | Too short to disambiguate |
| < 15 chars | 0.6 | May be command or brief |
| < 50 chars | 0.8 | Adequate context |
| ≥ 50 chars | 0.9 | Rich context |
| default | 0.7 | When length unavailable |

### Penalties (multiplicative)

| Condition | Multiplier | Trigger |
|-----------|-----------|---------|
| ambiguousIntent | 0.70 | Multiple close-scoring intents |
| missingRequiredParams | 0.75 | Required entities not extracted |
| llmFallback | 0.85 | LLM used instead of rules |
| lowPatternMatch | 0.80 | Raw weight below 0.7 |
| partialEntityMatch | 0.90 | Some but not all entities found |

### Boosts (additive)

| Condition | Boost | Trigger |
|-----------|-------|---------|
| exactTriggerMatch | +0.10 | Tier 1 slash command |
| allEntitiesExtracted | +0.08 | All required entities found |
| highPatternWeight | +0.05 | Raw weight ≥ 0.9 |
| singleClearMatch | +0.10 | Only one intent matched |

### Thresholds

| Level | Threshold | Action |
|-------|-----------|--------|
| HIGH | ≥ 0.85 | Proceed |
| MODERATE | ≥ 0.65 | Proceed with caution |
| LOW | ≥ 0.40 | Proceed but flag |
| UNCERTAIN | < 0.20 | Block — "I don't know" |

### Uncertainty Triggers (Mount Sinai "I don't know")

When any of these fire, confidence = 0.0, `canProceed = false`:
- `no_intent_match` — no intent resolved
- `conflicting_intents` — contradictory evidence
- `insufficient_query_length` — not enough to work with
- `outside_intent_allowlist` — not in closed-world intent set

---

## Non-Negotiable Rules

1. **No hardcoded confidence** outside Confidence Pack + Registry
2. **LLM never computes confidence** — platform computes from signals
3. **Pack is source of truth** — factors, penalties, boosts, thresholds, signal mappings
4. **No silent fallbacks** — missing pack = `CONFIGURATION ERROR: REQUIRES_REVIEW`
5. **Version pinning** — `packVersion`, `modelId@version` in every artifact
6. **Same model regardless of parser** — Tier 1, 2, or 3 all use same confidence model

---

## Files Changed

| File | Change |
|------|--------|
| `src/healthcare/nls/NLSConfidenceIntegration.js` | Full rewrite — removed hardcoded values, loads from pack |
| `src/healthcare/nls/parsers/RuleBasedParser.js` | Fixed `_matchTrigger` — uses intent named groups first |
| `src/healthcare/packs/confidence/nls-intent-parsing.confidence.json` | Added `signalMappings` section |

---

## Test Verification

### Endpoints

- **Parse**: `POST /api/healthcare/nls/parse` — `{ text: "..." }`
- **Explain**: `POST /api/healthcare/nls/confidence/explain` — signal context
- **Model Info**: `GET /api/healthcare/nls/confidence/model`

### Expected Results

| Command | Intent | Key Param | Confidence |
|---------|--------|-----------|------------|
| `/drug-check aspirin warfarin` | `hc:drug-check` | `medications: "aspirin warfarin"` | HIGH |
| `/patient Alesha810` | `hc:patient-summary` | `patientId: "Alesha810"` | HIGH |
| `/care-gaps P001` | `hc:care-gaps` | `patientId: "P001"` | HIGH |

### Failure Cases

| Scenario | Expected |
|----------|----------|
| Pack JSON deleted | `CONFIGURATION ERROR: REQUIRES_REVIEW` — server fails to init |
| `signalMappings` removed from pack | `CONFIGURATION ERROR` — tier reliability missing |
| No intent match | confidence 0, UNCERTAIN, `canProceed: false` |
| LLM fallback + ambiguity + missing params | Heavy penalties, likely UNCERTAIN |

---

## References

- **Mount Sinai InfEHR** — scoring + explainability + clinical gating + "I don't know"
- **GRADE framework** — supporting context for evidence certainty language
- **PMC: LLM uncertainty proxies** — justification for platform-computed confidence
- **Architecture doc**: `docs/connfidenc.xml`
- **Platform doc**: `docs/METALLIGENT-HEALTHCARE-PLATFORM.md`
- **Glossary**: `docs/HEALTHCARE-GLOSSARY.md`
