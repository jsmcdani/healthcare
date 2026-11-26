---
name: account-360
description: Full picture of ONE customer account across revenue, renewal, pipeline, support cases, SLA, CSAT, platform incidents/outages and key contacts, from the Salesforce-shaped data in Databricks. Use when asked about a specific account ("how is Acme doing", "prep me for my call with X", "QBR for X", /account-360 <name>), or when drilling into an account from the risk radar.
---

# Account 360

**Load `trifecta-metrics` first.** Query through the Claude Databricks
connector, read-only.

Live dashboard: https://claude.ai/artifact/KdhtLFHSbCG5ehKxwP22Fr (built with `data-dashboard-builder`).
Open it when someone asks for the dashboard; rebuild it from the kit only when it needs changing.

## Step 1: Resolve the account
```sql
SELECT Id, Name, Customer_Segment__c, Hosting_Region__c, Industry, BillingCountry, Type,
       NumberOfEmployees, ARR__c, Contract_Renewal_Date__c, CreatedDate
FROM workspace.salesforce_synth.account
WHERE lower(Name) LIKE lower('%{{name}}%')
ORDER BY ARR__c DESC LIMIT 5
```
- **One match:** continue.
- **Several matches:** list them (name, segment, ARR) and ask which one. Don't guess.
- **No match:** say so, and suggest names that are close.

Use the resolved `Id` as `{{id}}` in every query below.

## Step 2: Pull the sections (tested; run them in one go)

**Health, last 90 days vs the 90 days before** (this is what gives you the trend):
```sql
WITH asof AS (SELECT CAST(max(CreatedDate) AS DATE) AS d FROM workspace.salesforce_synth.`case`)
SELECT CASE WHEN CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 90) THEN 'last_90d' ELSE 'prior_90d' END AS period,
  count(*) AS cases, count_if(cs.SLA_Breached__c) AS sla_breaches,
  round(count_if(cs.SLA_Breached__c) / count(*), 3) AS breach_rate,
  count(cs.CSAT__c) AS csat_responses, round(avg(cs.CSAT__c), 2) AS csat,
  count_if(cs.Priority IN ('Critical','High')) AS severe_cases,
  count_if(cs.Incident__c IS NOT NULL) AS outage_cases,
  round(avg(cs.Resolution_Hours__c), 1) AS avg_resolution_hours, asof.d AS data_as_of
FROM workspace.salesforce_synth.`case` cs CROSS JOIN asof
WHERE cs.AccountId = '{{id}}' AND CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 180)
GROUP BY ALL
```

**Monthly trend (12 months), for the chart:**
```sql
SELECT date_format(CreatedDate, 'yyyy-MM') AS month, count(*) AS cases,
  count_if(SLA_Breached__c) AS sla_breaches, round(avg(CSAT__c), 2) AS csat, count(CSAT__c) AS csat_responses
FROM workspace.salesforce_synth.`case` WHERE AccountId = '{{id}}'
GROUP BY 1 ORDER BY 1
```

**Incidents that hit this account:**
```sql
SELECT i.Name, i.Severity__c, i.Type__c, i.Component__c, i.Affected_Region__c, i.Start_Time__c, i.End_Time__c,
  i.Root_Cause__c, count(*) AS cases_linked
FROM workspace.salesforce_synth.`case` cs JOIN workspace.salesforce_synth.incident__c i ON i.Id = cs.Incident__c
WHERE cs.AccountId = '{{id}}' GROUP BY ALL ORDER BY i.Start_Time__c DESC
```

**Top case reasons (90d) and open cases:**
```sql
WITH asof AS (SELECT CAST(max(CreatedDate) AS DATE) AS d FROM workspace.salesforce_synth.`case`)
SELECT Reason, count(*) AS cases, count_if(SLA_Breached__c) AS breaches, count_if(NOT IsClosed) AS still_open
FROM workspace.salesforce_synth.`case` CROSS JOIN asof
WHERE AccountId = '{{id}}' AND CAST(CreatedDate AS DATE) > date_sub(asof.d, 90)
GROUP BY 1 ORDER BY cases DESC
```

**Pipeline and renewal:**
```sql
SELECT Type, StageName, Name, Amount, CloseDate, Probability, IsClosed, IsWon, Loss_Reason__c
FROM workspace.salesforce_synth.opportunity WHERE AccountId = '{{id}}'
ORDER BY IsClosed, CloseDate DESC LIMIT 25
```

**Key contacts** (prefer senior titles):
```sql
SELECT FirstName, LastName, Title, Department, Email FROM workspace.salesforce_synth.contact
WHERE AccountId = '{{id}}'
ORDER BY CASE WHEN Title RLIKE '(?i)chief|vp|vice president|head|director' THEN 0 ELSE 1 END, LastName
LIMIT 8
```

Compute the account's **risk score** using the formula in `trifecta-metrics`,
from the last-90-day row.

## Step 3: Output

### Briefing (default, in chat)
1. **Header:** name · segment · region · ARR · renews {date} ({n} days from the snapshot) · renewal stage · Data as of {date}
2. **Verdict, one sentence:** health band + the single biggest reason. Example: "Elevated
   risk: an Aug Sev1 Payments API outage (INC-0001) drove 7 SLA breaches, and the
   renewal is in Negotiation."
3. **Health:** last 90d vs prior 90d for cases, breach %, CSAT (with response count),
   severe cases, with arrows for direction.
4. **Incidents:** each incident's name, severity, component, root cause, and how many of this account's cases it caused.
5. **Commercial:** renewal opportunity status; open expansion pipeline (Upgrade) shown separately from closed history; recent losses and their reasons.
6. **Talking points:** three bullets the account owner can use on a call: acknowledge
   (the incident or breaches), reassure (the fix or trend), advance (renewal or expansion).
7. **Who to talk to:** the top three contacts.

### Dashboard (when asked)
Build it as a **Claude Data** dashboard on the Databricks connector.
- **KPI row:** ARR · days to renewal · risk score/band · CSAT (90d) · SLA breach % (90d)
- **Line chart:** monthly cases, with SLA breaches overlaid and incident start dates marked
- **Tables:** incidents · open opportunities · top case reasons
- **Contacts card**
- "Data as of" in the header

### QBR / story (when asked for a QBR, a deck or a story)
Use Scrollyteller (or a slide deck if they ask for one), in this order: partnership
snapshot → what went well → what went wrong and what we did (incidents, SLA) →
trend now → renewal and expansion path → asks. Keep it customer-safe: no internal
risk score or "ARR at risk" language in anything meant for the customer.

## Guardrails
- One account per run. For comparisons across accounts, use `risk-radar`.
- Write "n/a (low responses)" rather than a CSAT average built on fewer than 3 responses.
- Don't paste contact emails into customer-facing output.
