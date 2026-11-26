---
name: expansion-radar
description: Find healthy accounts that are ready for an upgrade and have none in the pipeline. Scored on support health, feature requests, ARR per employee (room to grow) and past upgrades, from the Salesforce data in Databricks. Use for "expansion", "upsell", "who should we upsell", "growth targets", or /expansion-radar [segment] [region].
---

# Expansion Radar

**Load `trifecta-metrics` first.** The query is in
`.claude/skills/data-dashboard-builder/kit/build_pages.py` (`EXP_CTE`).

Live dashboard: https://claude.ai/artifact/D5GE7thnBMZjshkbBd4ktX

## Definition
- **Candidates:** no open `Existing Customer - Upgrade` opportunity, plus healthy support:
  either a risk score under 40, or fewer than 5 cases in 90 days ("quiet").
- **Expansion score (0–100):**
  - **Health, up to 40:** `40 × (1 − risk/100)`, or 30 for quiet accounts
  - **Demand, up to 20:** `20 × min(feature_requests_90d / 3, 1)`
  - **Room to grow, up to 20:** `20 × (1 − percentile rank of ARR per employee within the segment)`
  - **Momentum, 20:** a won upgrade in the last 12 months
- **Bands:** Strong ≥ 70 · Good 55–69 · Possible < 55
- **Upgrade potential** = the median won upgrade in the segment over 12 months, summed
  over Strong candidates. It's a rough sizing, not a forecast. Say so.
- There is no product usage data, so usage growth isn't scored.

## Output
- **Chat:** headline (Strong count + potential), then the top 10 with their signals, then
  one line on where to focus (segment or region).
- **Dashboard:** open the link above.
