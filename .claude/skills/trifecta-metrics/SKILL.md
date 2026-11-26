---
name: trifecta-metrics
description: Table map, join paths and the one agreed definition of every account metric (ARR, SLA breach rate, CSAT, risk score, ARR at risk, open pipeline, outage exposure, data freshness) for the Salesforce-shaped data in Databricks (workspace.salesforce_synth). Load this before writing ANY SQL, chart, dashboard or narrative about accounts, cases, SLAs, CSAT, incidents/outages, renewals or pipeline, and before the risk-radar or account-360 skills.
---

# Trifecta metrics: the shared definitions

Every account question goes through these definitions. Don't invent new
formulas: if a question needs a metric that isn't here, say so, propose a
definition, and label it **non-standard** in the output.

Query via the **Claude Databricks** connector (`execute_sql`), always with
fully-qualified names. All access is **read-only**: never issue INSERT,
UPDATE, DELETE, CREATE or DROP against these tables.

## Tables (`workspace.salesforce_synth`)

| Table | Grain | Key columns |
|---|---|---|
| `account` | 1 row per customer (~5,000) | `Id`, `Name`, `Customer_Segment__c` (SMB / Mid-Market / Enterprise), `Hosting_Region__c` (US-East / US-West / EU / APAC), `Type` (Customer - Direct / Channel), `ARR__c`, `Contract_Renewal_Date__c`, `Industry`, `BillingCountry`, `NumberOfEmployees` |
| `opportunity` | 1 row per deal (~30,000) | `AccountId`, `Type` (New Customer / Existing Customer - Upgrade / Renewal), `StageName`, `Amount`, `CloseDate`, `IsClosed`, `IsWon`, `Probability`, `Loss_Reason__c` |
| `case` (backtick it: `` `case` ``) | 1 row per support case (~120,000) | `AccountId`, `ContactId`, `Incident__c`, `Priority` (Critical / High / Medium / Low), `Status`, `IsClosed`, `Reason`, `Origin`, `CreatedDate`, `ClosedDate`, `SLA_Target_Hours__c`, `Resolution_Hours__c`, `SLA_Breached__c`, `CSAT__c` (1–5, often NULL) |
| `incident__c` | 1 row per platform incident (~40; the ServiceNow-style data) | `Id`, `Name` (INC-####), `Severity__c` (Sev1–Sev4), `Type__c` (Outage / Degradation / Failed Deployment), `Component__c`, `Affected_Region__c`, `Start_Time__c`, `End_Time__c`, `Root_Cause__c` |
| `contact` | 1 row per person (~20,000) | `AccountId`, `FirstName`, `LastName`, `Email`, `Title`, `Department` |

## Join paths
- `opportunity.AccountId`, `case.AccountId` and `contact.AccountId` join to `account.Id`
- `case.Incident__c` joins to `incident__c.Id` (only ~3% of cases link to an incident; use LEFT JOIN)
- Account to incident always goes **through cases**. There is no direct link.

## Data freshness (always show it)
The data is a snapshot, not live. Anchor every time window on the snapshot date,
**not** on `current_date()`:

```sql
WITH asof AS (SELECT CAST(max(CreatedDate) AS DATE) AS d FROM workspace.salesforce_synth.`case`)
```

- Every chart, table and story shows **"Data as of {asof}"**.
- If `asof` is more than 2 days before today, add a visible **stale data** note.
- When you report days to a renewal, compute them from `asof`. If the renewal
  date is before today, say "renewal date passed".

## Metric definitions

| Metric | Definition |
|---|---|
| **ARR** | `account.ARR__c`. Never sum opportunity amounts to get ARR. |
| **Window** | Default 90 days: `CAST(CreatedDate AS DATE) > date_sub(asof.d, 90)` |
| **Cases (90d)** | Count of cases created in the window |
| **SLA breach rate** | `count_if(SLA_Breached__c) / count(*)` over cases in the window. Show it as a %. Only report it when cases ≥ 5; otherwise show "low volume". |
| **CSAT** | `avg(CSAT__c)` over **non-null** responses in the window. Only report it when there are ≥ 3 responses; otherwise NULL, shown as "n/a (low responses)". Always show the response count next to it. |
| **Severe case share** | `count_if(Priority IN ('Critical','High')) / count(*)` |
| **Outage exposure** | Count of window cases with `Incident__c IS NOT NULL`, plus the distinct incidents behind them (name, severity, component) |
| **Open cases** | `count_if(NOT IsClosed)`, all time |
| **Renewal stage** | `max_by(StageName, CloseDate)` over opportunities with `Type = 'Renewal'` |
| **Expansion pipeline** | `sum(Amount)` over open opportunities (`NOT IsClosed`) with `Type = 'Existing Customer - Upgrade'` |
| **New-logo pipeline** | The same, with `Type = 'New Customer'`. Keep it separate; never mix it into account health. |
| **Win rate** | `count_if(IsWon) / count_if(IsClosed)` |

### Risk score (0–100, higher = worse)
Only scored when cases (90d) ≥ 5:

```
35 × min(breach_rate / 0.40, 1)
+ 30 × ((5 − csat) / 4)          -- use 0.5 in place of this term when CSAT is n/a
+ 20 × min(severe_share / 0.50, 1)
+ 15 × min(outage_cases / 3, 1)
```

- **Bands:** ≥ 60 High · 40–59.9 Elevated · < 40 Watch
- **ARR at risk** = `ARR × risk_score / 100`. This is the default ranking for any "risk" list.
- **Always show the drivers** behind a score (breach %, CSAT, severe share,
  outages). A score on its own is not an explanation.

## Presentation rules
- Currency in $K or $M with one decimal place. Percentages to one decimal place.
- Name the window ("last 90 days") on every metric.
- When a chart or dashboard is built in Claude Data, the chart's query must be
  the SQL from these definitions, so the numbers match everywhere.
