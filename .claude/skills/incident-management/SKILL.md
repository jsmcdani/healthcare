---
name: incident-management
description: Incident management (ITSM) view with incidents by severity and month, mean time to resolve, outage hours, change-induced incidents, root causes, components, customer and ARR impact, and support-case SLA by priority. Live ServiceNow through the Local Trifecta gateway when it returns rows, otherwise the ServiceNow-shaped incident data in Databricks. Use for "incidents", "MTTR", "outages", "change failure", "P1s", "ITSM dashboard", "ServiceNow dashboard", or /incident-management [severity] [region] [90|180|365].
---

# Incident Management

Live dashboard: https://claude.ai/artifact/4R3dgA9ndSksVwgebZGBZ4
Queries: `.claude/skills/data-dashboard-builder/kit/build_itsm.py`

## Sources, in order
1. **Live ServiceNow** through `Local Trifecta` → `ask`, for example `all incidents`, `open high priority incidents`,
   `my open P1 incidents`, `unassigned open incidents`. Answers carry a structured `table`
   (see `trifecta-command-center`). The dashboard shows a live table whenever this returns rows.
2. **Sample:** `workspace.salesforce_synth.incident__c` plus linked `case` rows in Databricks. These are
   ServiceNow-*shaped*, not ServiceNow records. Always label them as sample data.

## Definitions
- **MTTR (hours)** = avg(End_Time__c − Start_Time__c). Show it by severity; a single Sev1 skews the overall average.
- **Outage hours** = sum of incident durations.
- **Change-induced** = the root cause names a configuration push or a deployment (`RLIKE '(?i)config|deploy'`).
  Report it as a share of incidents. It's the change-failure signal.
- **Customer impact:**
  - cases linked through `case.Incident__c`
  - distinct accounts
  - **ARR affected**, the sum of ARR over distinct affected accounts. This only works on the Databricks sample, where incidents and accounts share keys.
- **Case SLA:** breach rate, average resolution hours and still-open cases, by priority. SLA targets: Critical 4h, High 8h, Medium 24h, Low 48h.
- **Windows** are 90, 180 or 365 days, counted back from the latest case in the data.

## Chat answer
Lead with:
1. Count and Sev1/Sev2.
2. The change-induced share.
3. The worst incident: severity, hours, accounts and ARR hit.
4. The root cause to fix first.

Then MTTR by severity, then case SLA.

## When ServiceNow returns nothing
Every ITSM answer "No incidents matched that filter" with `off_context.raw: 0` means the gateway
reached its ServiceNow step and got **zero rows back**. It is not a phrasing problem. Check, in this order:
1. **The ServiceNow trial or developer instance is asleep.** Trial instances hibernate when idle. Wake it from
   the developer portal, then ask again.
2. **The gateway's ServiceNow credentials** (OAuth token or integration user) expired, or point at another instance.
3. **Run-as mapping:** the signed-in user has no matching ServiceNow user or role, so ACLs hide every incident.
4. **Query scope:** the gateway's incident query filters on something (for example "assigned to me" or "active")
   that excludes the trial's demo records.
