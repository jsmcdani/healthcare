---
name: crm-exec-scorecard
description: Executive scorecard of the top CRM accounts from live Salesforce, covering revenue, owner, branch, contract expiration (expired or expiring soon), machine count, service calls and calls per machine, owner concentration, and the CRM agent's observations, with a click-through briefing. Use for "exec scorecard", "executive view of top accounts", "which big contracts are expired", "board/QBR prep on top accounts", or /crm-exec-scorecard [10|20].
---

# CRM Executive Scorecard

**Load `crm-gateway` first.**

Live dashboard: https://claude.ai/artifact/C1Qy57MDHyPy9GcTxfiATF

## The one question that powers it
Send this to `ask`, word for word, with N = 10 or 20:

> top {N} accounts by revenue with account owner, branch, contract expiration date, machine count and LTM service calls

It returns one table plus the agent's observations. Everything else is worked out from it:
- **Contract status:** Expired if the end date is before today. Within 12 months if it ends in the next 365 days. Otherwise Active.
- **Calls per machine** = LTM service calls ÷ machines. Flag at 1.5 or more.
- **Owner concentration:** the owner holding the most accounts shown.
- **Revenue** is **average monthly commissionable revenue (90-day collections)**, not ARR.

## Chat answer
Lead with the exposure:
1. How many top accounts are on expired contracts, and the monthly revenue at stake.
2. Contracts expiring within 12 months.
3. The account with the heaviest service load.
4. Owner concentration.

Then the table. Offer a `coworker_search` briefing on any account.

## Don't build on these (yet)
These questions were tried and aren't reliable enough for executives:
- **"revenue by vertical":** the agent stops partway and asks to continue. It needs a gateway skill or report that aggregates by `Account.Industry`.
- **"contracts expiring in the next 12 months, ranked by revenue":** the agent samples 46K+ accounts instead of ranking all of them. It needs a server-side report.

Both are good candidates for the gateway team to expose as governed tools that return `records`.
