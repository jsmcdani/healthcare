---
name: crm-top-accounts
description: Top accounts by revenue from the live Salesforce CRM, with a click-through Coworker briefing on any account. Use for "top accounts", "biggest customers", "brief me on <account>", "prep me for <account>", or /crm-top-accounts [N] [account], when the answer should come from the real CRM.
---

# CRM Top Accounts

**Load `crm-gateway` first.**

Live dashboard: https://claude.ai/artifact/HETfVogcbMN4rMddCK77Lb

## Quick answer (in chat)
1. Call `ask` with `top {N} accounts by revenue` (default N = 20).
2. Show the agent's table as returned. Revenue here is **average monthly commissionable
   revenue, based on 90 days of collections**. Say that, since it isn't ARR.
3. If an account is named, call `coworker_search` with `brief me on {ACCOUNT}` and
   summarise it in this order: owner and branch → key metrics (machine count, LTM revenue,
   contract expiration) → opportunities → service trend → risk flags → recommended actions.
   Leave out contact emails and phone numbers unless the user asks for them.

## Dashboard (when asked for one, or "make it live")
Open the live dashboard above, or rebuild it with
`.claude/skills/data-dashboard-builder/kit/build_crm.py` (the `crm_top` section):
- **Datasets:** `top` (ask, `{{n}}` ∈ 10/20/50) and `brief` (coworker_search, `{{account}}`).
- **Layout:** bar chart of average monthly revenue (click a bar to brief on that account),
  the agent's one-line take, a ranked table with Salesforce links, then the briefing
  with metric tiles.

## Notes
- Each viewer sees accounts through **their own** CRM access.
- Briefings take 20–60 seconds, because the agent assembles them live.
- Names containing quotes or apostrophes can't be passed to a briefing on the dashboard
  (the filter rule blocks them for safety). Ask in chat instead.
