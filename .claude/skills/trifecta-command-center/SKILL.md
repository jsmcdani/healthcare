---
name: trifecta-command-center
description: Cross-system dashboards across Salesforce CRM, ServiceNow ITSM and the Databricks warehouse through the Local Trifecta gateway. Covers routing, the structured table each answer carries, how to keep the three data sets apart, the shared account key a real join needs, and the hypothetical dashboard designs (Account Health, Incident Revenue Impact, Change Risk, Exec Brief). Use for any question or dashboard that spans two or more of CRM, ServiceNow and the warehouse, "the trifecta", "command center", "incidents for my top accounts", or /trifecta.
---

# Trifecta Command Center (prototype)

The **Local Trifecta** connector is one gateway over three systems. Its `ask` tool reads the intent
of a question and routes it to Salesforce, ServiceNow ITSM, the Databricks warehouse, or more than one.
When more than one answers, the gateway reconciles them itself. Every call runs as the signed-in user.

Prototype dashboard: https://claude.ai/artifact/ELxMoZA76SFCgTrrNQ6M1P

> **Status, Nov 2026.** Salesforce answers. It's the **full sandbox** org
> (`cscsw--full.sandbox`), so its numbers differ a little from production. ServiceNow ("my open
> incidents", "all incidents", "P1 incidents") and the warehouse ("total ARR", "ARR by industry",
> "ARR by country") route correctly but **return no rows** for this user. Treat every cross-system
> design below as hypothetical until they return data.

## Tools

| Tool | Use |
|---|---|
| `ask` | Anything analytic. It routes by intent: CRM ("top accounts by revenue", "who owns X"), ITSM ("my open incidents", "open high priority incidents", "unassigned open incidents", "recent change requests"), or warehouse ("ARR by industry", "ARR by country", "total ARR") |
| `coworker_search` | A briefing on one named account |
| `pipeline_my` | The signed-in rep's own pipeline |
| `export_xls` | A warehouse analytic as an .xlsx download, single-use link |

Pass requests through **verbatim**. The ITSM agent offers its own follow-up chips; reuse those exact wordings.

## The answer card, now structured
Trifecta cards carry a **`table`** field, so there's no Markdown to parse:

```json
"table": { "columns": [{"key": "account", "label": "Account", "type": "string"},
                       {"key": "avg_commissionable_revenue", "type": "currency"}],
           "rows": [[1, "PURDUE UNIVERSITY", 225792, 677376]],
           "ids": ["/lightning/r/Account/<id>/view"], "source": "salesforce", "truncated": false }
```

- When a system has nothing, `table` is `null` and `answer` says why ("No incidents matched…").
  Show that message, and never show it as a zero.
- `routed` lists the systems consulted: `crm`, `itsm`, `warehouse`.
- Loader: `table_loader()` in `.claude/skills/data-dashboard-builder/kit/build_trifecta.py`.
  It maps `columns[].key` to row objects, turns `ids` into Salesforce links, and puts "Agent said"
  and "Routed to" in `meta`.
- When the user asks for a **sheet**, fill a Claude Sheet from `table` (the gateway's own instruction).

## The three data sets are different. Keep them apart.
- **Salesforce:** Laundry (record type Route, `Branch__c`) and Air (record type Air,
  `Air_Area_Branch__c`). Revenue is Average Commissionable Revenue, monthly, from 90 days of collections.
  See `crm-revenue-by-branch`.
- **ServiceNow:** incidents, change requests, problems. Its customer field isn't known yet.
- **Warehouse:** ARR-based analytics. The Databricks trial (`workspace.salesforce_synth`) is a
  **synthetic** Salesforce-shaped copy. Its accounts don't exist in the CRM (see `trifecta-metrics`).

Rules:
1. **Never add, average or rank across systems.** Show them side by side, each labeled with its source.
2. **A cross-system number needs a shared key.** Matching on account names doesn't count.
   The design assumes the **Salesforce Account Id** on the ServiceNow company/customer record and in the
   warehouse account table. Until that exists, any join comes out at zero matches, which is correct.
3. **Stand-ins are labeled.** When a live system returns nothing, a panel may show Databricks trial
   data, with a "Stand-in" pill and a line saying it isn't that system's data.
4. **Revenue isn't ARR.** CRM revenue is monthly commissionable revenue; warehouse ARR is annual.
   Never put them on one axis.

## Hypothetical dashboards, ready once the systems return data

| Dashboard | Questions to ask (`ask`) | Join | What it answers |
|---|---|---|---|
| **Account Health 360** | `top 20 accounts by revenue`; `open incidents for <account>`; `ARR for <account>` | Account Id | Is a top account healthy? Revenue, open P1/P2s and the ARR trend together |
| **Incident Revenue Impact** | `open high priority incidents`; `top accounts by revenue` | ServiceNow company → Account Id | How much monthly revenue sits with accounts that have an open P1/P2? |
| **Change Risk Calendar** | `recent change requests`; `top accounts by revenue` | Configuration item → account, or branch | Which top accounts or branches are exposed to upcoming changes? |
| **Exec Cross-System Brief** | All of the above | — | One page: revenue, service health and ARR, each labeled by source, with the gateway's reconciled one-liners |

For each, the prototype pattern is:
- one Trifecta dataset per question
- a status strip showing what each system returned
- a live panel that switches to a labeled stand-in when its system is empty
- a "can we join yet?" check that counts matches by key

## Output in chat
For a cross-system question:
1. Give each system's answer under its own heading.
2. Say which systems returned nothing.
3. Only reconcile when the gateway reconciled it (`routed` names more than one system and the card says so).
