# Contract-First Architecture v2.0

## Overview

The Contract-First Architecture introduces **runtime schema validation** using Zod to enforce data contracts at system boundaries. This is an **additive enhancement** that works alongside the existing JSON contract system - it does not replace or modify how intent recipes, steps, or existing contracts function.

---

## Key Principle: Augmentation, Not Replacement

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXISTING SYSTEM (Unchanged)                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Intent JSON  │───▶│ Recipe Steps │───▶│ Step Outputs │      │
│  │  Contracts   │    │  (execute)   │    │   (JSON)     │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ NEW: Optional validation layer
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CONTRACT ENFORCEMENT (New)                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Zod Schema   │───▶│  Validate    │───▶│ Pass/Fail    │      │
│  │ (optional)   │    │  at Boundary │    │ + Audit      │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### What Stays the Same

| Component | Status | Notes |
|-----------|--------|-------|
| Intent JSON contracts | **Unchanged** | Still define recipe structure |
| Recipe step execution | **Unchanged** | Steps execute exactly as before |
| Step input/output format | **Unchanged** | JSON payloads work the same |
| RecipeEngine orchestration | **Unchanged** | Recipe flow unchanged |
| Existing adapters | **Unchanged** | Haven, AQL, all adapters work |

### What's New (Additive Only)

| Component | Purpose | Impact on Existing |
|-----------|---------|-------------------|
| Zod schemas | Define expected shapes | None - schemas are separate files |
| ContractEnforcer | Optional validation | Disabled by default |
| Envelope headers | Audit/trace metadata | Added to outputs, doesn't break readers |
| Publication gates | Governance rules | Only affects new artifact types |
| Version registry | Track artifact versions | Parallel system, doesn't modify existing |

---

## Architecture Layers

### Layer 1: Core Contracts (`src/core/contracts/`)

Defines the **schema vocabulary** for validation. These are Zod schemas that describe expected data shapes.

```
src/core/contracts/
├── EnvelopeHeader.js      # Standard header (envelopeId, timestamp, audit)
├── validation.js          # validate(), wrapEnvelope(), unwrapEnvelope()
├── registry.js            # Schema version registry
├── ContractEnforcer.js    # Integration with RecipeExecutor
└── envelopes/
    ├── StepInputEnvelope.js    # Step input validation
    ├── StepOutputEnvelope.js   # Step output validation
    ├── ErrorEnvelope.js        # Structured errors
    ├── RequestEnvelope.js      # API request validation
    └── ResponseEnvelope.js     # API response validation
```

**Key point**: These schemas exist independently. They don't modify any existing JSON contract files.

### Layer 2: Artifacts (`src/core/artifacts/`)

Defines **new artifact types** for healthcare-specific governance. These are additions to the system.

```
src/core/artifacts/
├── BaseArtifact.js                   # Common fields
├── DeterminantProfileEnvelope.js     # PHI/compliance profiles
├── FeaturePackEnvelope.js            # Computed feature packs
├── ProposalEnvelope.js               # Change proposals
└── packs/
    ├── HotspotPack.js
    ├── DomainCoveragePack.js
    └── AffinityPack.js
```

### Layer 3: Publication & Governance (`src/core/publication/`)

Controls **what can be published automatically** vs. what requires approval.

```javascript
// Publication gate types
AUTO_PUBLISH_ALLOWED   // Low-risk derived data (feature packs)
APPROVAL_REQUIRED      // Profile changes, policy updates
FORBIDDEN              // Direct SoT mutation (never allowed)
```

### Layer 4: Version Control (`src/core/versioning/`)

Tracks artifact versions and supports **version pinning** for reproducibility.

```javascript
// Resolution order
1. Explicit pin (if provided)     → Use exactly this version
2. Active version (from registry) → Use current approved version
3. Latest (fallback)              → Use most recent
```

---

## How Validation Works

### Contract Classes

| Class | Enforcement | When Used |
|-------|-------------|-----------|
| `BOUNDARY` | **Required** - rejects on failure | API requests, step I/O |
| `STORAGE` | **Required** - no write without validation | Profiles, packs, proposals |
| `INTERNAL` | **Recommended** - logs warnings | Events, telemetry |

### Validation Flow

```javascript
// Example: Step output validation (optional, off by default)

// 1. Step executes normally (unchanged)
const result = await adapter.execute(stepInput);

// 2. NEW: If enforcement enabled, validate output
if (enforcementEnabled) {
  const validation = contractEnforcer.validateStepOutput(
    stepId,
    stepType,
    result
  );

  if (!validation.valid) {
    // Log warning or throw based on contract class
  }
}

// 3. Return result (same as before)
return result;
```

### Enabling/Disabling Enforcement

Contract enforcement is **disabled by default** to ensure backward compatibility:

```javascript
// In RecipeExecutor - enforcement is opt-in
constructor(options = {}) {
  this.enforcementEnabled = options.enableContractEnforcement || false;
}

// To enable for new recipes:
const executor = new RecipeExecutor({
  enableContractEnforcement: true
});
```

---

## Envelope Structure

When validation is enabled, data is wrapped in envelopes:

```javascript
{
  // Standard header (added by contract system)
  header: {
    envelopeId: "uuid-v4",
    schemaId: "step.output.v1",
    schemaVersion: "1.0.0",
    timestamp: "2026-02-01T...",
    traceId: "correlation-id",
    auditTrace: {
      userId: "user123",
      action: "execute_step",
      source: "RecipeExecutor"
    }
  },

  // Actual data (your existing JSON)
  payload: {
    // ... step output, unchanged from before
  },

  // Validation metadata
  _meta: {
    validated: true,
    validatedAt: "2026-02-01T..."
  }
}
```

**Important**: Systems that don't understand envelopes can still read `payload` directly. The envelope is additive metadata.

---

## Offline Recipe Family

New recipe namespace for scheduled, deterministic computations:

```
offline.*
```

### Offline Recipe Rules

**MAY:**
- Read graph metadata via adapters
- Compute deterministic metrics
- Build derived indexes
- Emit proposals for review

**MAY NOT:**
- Change runtime behavior directly
- Auto-modify policies without approval
- Use LLMs for control decisions
- Learn dynamically during execution

### Example Offline Recipes

```
offline.determinants.build.v1    # Build compliance profiles
offline.hotspots.compute.v1      # Compute field hotspots
offline.affinity.analyze.v1      # Analyze field relationships
```

---

## Integration with Existing System

### RecipeExecutor Changes

The RecipeExecutor has **optional** contract enforcement hooks:

```javascript
// Before (still works exactly the same):
async executeStep(step, context) {
  const result = await this.executeStepLogic(step, context);
  return result;
}

// After (with optional enforcement):
async executeStep(step, context) {
  // Optional: Validate input
  if (this.enforcementEnabled) {
    this.contractEnforcer?.validateStepInput(step);
  }

  const result = await this.executeStepLogic(step, context);

  // Optional: Validate output
  if (this.enforcementEnabled) {
    this.contractEnforcer?.validateStepOutput(step, result);
  }

  return result;
}
```

### RecipeEngine Changes

Similarly optional integration:

```javascript
// Contract validation is lazy-loaded and optional
let contracts = null;
try {
  contracts = await import('../../core/contracts/index.js');
} catch (e) {
  // Contracts not available - continue without
}
```

---

## File Summary

### New Files (31 total)

| Directory | Count | Purpose |
|-----------|-------|---------|
| `src/core/contracts/` | 11 | Schema definitions, validation |
| `src/core/artifacts/` | 8 | Artifact type definitions |
| `src/core/publication/` | 3 | Publication gates, approval |
| `src/core/versioning/` | 3 | Version registry, resolver |
| `src/healthcare/packs/recipe/offline/` | 5 | Offline recipe runner |
| `scripts/` | 1 | Verification tests |

### Modified Files (2 total)

| File | Change | Impact |
|------|--------|--------|
| `RecipeExecutor.js` | Added optional enforcement hooks | None if disabled |
| `RecipeEngine.js` | Added optional contract imports | None if not used |

---

## Migration Path

### Phase 1: Coexistence (Current)
- New contract system installed alongside existing
- Enforcement disabled by default
- All existing recipes work unchanged

### Phase 2: Gradual Adoption
- Enable enforcement for new recipes
- Add schemas for critical boundaries
- Monitor validation failures in logs

### Phase 3: Full Enforcement
- Enable enforcement globally
- All boundaries validated
- Invalid data rejected at boundaries

---

## Verification

Run the verification script to confirm all components work:

```bash
cd C:\Users\jsmcd\MCP\Metalligent-Healthcare
node scripts/verify-contracts.js
```

Expected output:
```
========================================
Contract-First Architecture Verification
========================================

1. Testing Contract Validation...
2. Testing Envelope Schemas...
3. Testing Artifact Schemas...
4. Testing Publication Gate...
5. Testing Version Registry...
6. Testing Offline Recipe Runner...
7. Testing Schema Registry...

========================================
Results: 15 passed, 0 failed
========================================
```

---

## Summary

The Contract-First Architecture is a **validation and governance layer** that:

1. **Does NOT change** how existing JSON contracts, intent recipes, or steps work
2. **Adds optional** runtime validation at system boundaries
3. **Introduces** new artifact types for healthcare governance
4. **Provides** publication gates for controlled changes
5. **Supports** version pinning for reproducibility

All existing functionality remains intact. The new system is purely additive.
