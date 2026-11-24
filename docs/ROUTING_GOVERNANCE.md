# Routing Governance

Gate every routable item before it is saved or shared, so builders without an
engineering background can't ship something that misroutes.

## Why

Coworker-style hosts route by description, and the list they route from is flat.

- Every item's name and description is in context on every turn. The body loads
  only after the model picks it.
- There is no classifier in front. The model reads the descriptions and picks.
- Stacking layers multiplies misses. Coworker picks a skill or an agent, the agent
  picks a topic or skill, then an action. At 95% per hop, four hops land right
  about 81% of the time, and a wrong route still answers confidently.
- Skills inside agents add a contender: topics and skills answer the same question
  ("what handles this?") from the same list.

The fix is structural (one job per layer) plus enforcement at build time.

## Model

A **routable** is anything a model picks by description:

| kind | job |
|---|---|
| `orchestrator_skill` | Coworker-level playbook that controls orchestration: which agent, in what order, what comes back |
| `agent` | chosen by its description; owns topics and actions |
| `topic` | routes inside an agent: scope, guardrails, allowed actions |
| `skill` | know-how for one topic: playbooks, procedures, processes, templates, domain knowledge. It doesn't route. |
| `action` | deterministic: writes, scores, scope checks |

```json
{
  "id": "sk-pipe-team",
  "name": "pipeline-review-team",
  "kind": "orchestrator_skill",
  "parentId": null,
  "description": "Rolls up pipeline coverage … Use when a manager asks about my team's pipeline … Not for a single rep's deals: use pipeline-review-my.",
  "triggers": { "should": ["…"], "shouldNot": ["…"] }
}
```

`parentId` defines the **routing list**: everything with the same parent competes
in one flat list, whatever its kind. `null` is Coworker's own list, where its
skills compete with the agents it can delegate to.

## Checks

Rules and thresholds live in `src/healthcare/packs/policy/routing-governance.policy.json`.
Every finding has a `fix` written for the builder.

### Creation-time check (`lintRoutable`)

| rule | severity | catches |
|---|---|---|
| `NAME_FORMAT` | error | names that aren't lowercase-hyphenated (domain-verb-scope) |
| `DESC_TOO_SHORT` | error | too little for the router to tell items apart |
| `DESC_TOO_LONG` | warning | descriptions cost tokens on every turn |
| `DESC_MISSING_USE_WHEN` | error | no trigger clause |
| `DESC_MISSING_NOT_FOR` | error | no clause naming the nearest neighbour (actions exempt) |
| `NOT_FOR_NO_NEIGHBOUR` | warning | not-for clause names nothing that exists |
| `DESC_VAGUE_TERMS` | warning | "helps with", "anything", "various", … |
| `DESC_MULTI_SCOPE` | error | one description claiming my / team / org at once |
| `SKILL_NOT_UNDER_TOPIC` | warning (configurable) | a skill beside topics instead of under one |
| `TRIGGERS_*_TOO_FEW` | warning at create, error at share | fewer than 3 should / 2 should-not prompts |

### Collision check (`checkCollisions`)

| rule | severity | catches |
|---|---|---|
| `NAME_DUPLICATE` / `NAME_REUSED` | error / warning | same name in the list / elsewhere in the org |
| `DESC_COLLISION` / `DESC_OVERLAP` | error / warning | sibling description similarity ≥ 0.6 / ≥ 0.35 |
| `CROSS_LAYER_OVERLAP` | warning | two layers claiming the same work (one owner per domain) |
| `PROMPT_ROUTES_ELSEWHERE` | warning at create, error at share | a should-prompt lands on a sibling |
| `PROMPT_FALSE_TRIGGER` | same | a should-not prompt lands here |
| `PROMPT_NEAR_TIE` | warning | the win margin is under 0.05 |
| `PROMPT_NO_MATCH` | same as routes-elsewhere | the prompt shares no words with the description |
| `STEALS_EXISTING_PROMPT` | error | adding this item moves a prompt that routes to a sibling today |
| `LIST_OVER_BUDGET` | warning | the list's descriptions total more than 4,000 tokens |

The not-for clause is removed before similarity scoring. It names neighbours on
purpose and would otherwise inflate the overlap it exists to prevent.

### Gate and audit

- `governRoutable({ candidate, catalog, stage })` returns `pass | warn | block`,
  counts, findings, simulated routes and metrics. `stage: 'share'` makes untested
  or misrouting items blocking.
- `auditCatalog({ catalog })` covers every list: sibling pairs over the warning
  threshold, token totals, every test prompt routed in its list, misroutes and a
  confusion table. Run it on an existing skill set before turning the gate on, and in CI.

## Builder tools

Registered in `HealthcareBuilderAgent` under **Routing Governance**:

- `check_routable_description`: the creation-time check only; no catalog needed.
- `gate_routable`: the full gate, run before save and before share.
- `audit_routing_catalog`: the whole catalog.

The catalog comes from `input.catalog`, or from the org's `routables` collection.
`healthcare_builder` and `healthcare_admin` get all three tools. `developer` gets
the description check and the audit.

## Limits

- Similarity is lexical (TF-IDF cosine). It catches shared vocabulary and misses
  paraphrase. Pass `similarity(a, b)` to plug in embeddings. The thresholds may
  then need retuning.
- Simulated routing is a pre-filter. It doesn't replace live route tests through
  the real host, which should log the full route taken
  (skill → agent → topic → skill → action) in the trace.
- Coworker doesn't expose an API for its skills yet. Until it does, run the gate
  where skills are generated (from the KA playbooks) and when they are pasted in.

## Next

1. Route tests through the live host: expected full path per prompt, a confusion
   table for each hop and end to end, and a build that fails when confusion
   increases.
2. Pass the routing decision downstream (intent, entities, confidence) so each hop
   doesn't re-classify from scratch.
3. Deterministic shortlisting: scope the catalog by role and tenant, and let the
   intent classifier choose the 5–10 candidates the model sees.
4. Record a content hash and version for each routable in decision artifacts.
