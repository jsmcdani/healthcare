---
name: pipeline-health
description: Org-wide pipeline view from the Salesforce data in Databricks. Covers open and weighted pipeline, win rate, stages, loss reasons, quarterly won/lost/open, and open deals at High-risk accounts. Use for "pipeline health", "how's the pipeline", "win rate", "why are we losing", or /pipeline-health [segment] [region] [type]. For one rep's own pipeline in the live CRM, use crm-my-pipeline.
---

# Pipeline Health

**Load `trifecta-metrics` first.** Queries are in
`.claude/skills/data-dashboard-builder/kit/build_pages.py` (`PIPE_CTE`).

Live dashboard: https://claude.ai/artifact/XTcXboGewENJooF3DThh6r

## Definitions
- **Open pipeline:** `sum(Amount)` where `NOT IsClosed`
- **Weighted pipeline:** `sum(Amount × Probability / 100)`. Stage probabilities are
  Prospecting 10, Qualification 25, Proposal 50, Negotiation 75.
- **Win rate (12 months):** won deals ÷ closed deals, counted by deals, not dollars,
  with close dates in the 12 months before the snapshot
- **Pipeline at High-risk accounts:** open amount where the account's renewal risk band is
  High (see `risk-radar`). These deals may stall because the customer is unhappy.
- **Lost to Service Reliability:** closed-lost deals with
  `Loss_Reason__c = 'Service Reliability'`. This ties outages to lost revenue.

## Output
- **Chat:** open and weighted pipeline, win rate, the largest loss reason, the amount at
  High-risk accounts, and the biggest deals closing soon.
- **Dashboard:** open the link above. It has segment, region and deal-type filters.
