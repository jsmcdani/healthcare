---
name: risk-radar
description: Build the Renewal Risk Radar, a ranked list or dashboard of accounts whose renewal is at risk, scored on SLA breaches, CSAT, severe cases and outage exposure and weighted by ARR. Use when asked for at-risk accounts, churn risk, renewal risk, a risk dashboard, "who should we worry about", or /risk-radar, optionally filtered by segment, region or renewal window.
---

# Renewal Risk Radar

**Load `trifecta-metrics` first.** It holds the definitions this skill relies
on. Query through the Claude Databricks connector, read-only.

## Inputs (all optional; fall back to the defaults)

| Input | Default |
|---|---|
| Renewal window | 0–180 days from the data snapshot date |
| Segment | all (`SMB`, `Mid-Market`, `Enterprise`) |
| Region | all (`US-East`, `US-West`, `EU`, `APAC`) |
| Top N | 15 |

## The query (tested)

Fill in the `{{ }}` filters. To drop a filter, delete its line. Leave the
scoring untouched; it implements the definitions in trifecta-metrics.

```sql
WITH asof AS (SELECT CAST(max(CreatedDate) AS DATE) AS d FROM workspace.salesforce_synth.`case`),
c90 AS (
  SELECT cs.AccountId,
    count(*) AS cases_90d,
    count_if(cs.SLA_Breached__c) AS sla_breaches_90d,
    count_if(cs.Priority IN ('Critical','High')) AS crit_high_90d,
    count_if(cs.Incident__c IS NOT NULL) AS incident_cases_90d,
    count(cs.CSAT__c) AS csat_responses_90d,
    avg(cs.CSAT__c) AS csat_avg_raw
  FROM workspace.salesforce_synth.`case` cs CROSS JOIN asof
  WHERE CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 90)
  GROUP BY cs.AccountId),
openc AS (SELECT AccountId, count(*) AS open_cases FROM workspace.salesforce_synth.`case` WHERE NOT IsClosed GROUP BY AccountId),
ren AS (SELECT AccountId, max_by(StageName, CloseDate) AS renewal_opp_stage
        FROM workspace.salesforce_synth.opportunity WHERE Type = 'Renewal' GROUP BY AccountId),
scored AS (
  SELECT a.Id AS account_id, a.Name AS account, a.Customer_Segment__c AS segment, a.Hosting_Region__c AS region,
    a.ARR__c AS arr, a.Contract_Renewal_Date__c AS renewal_date,
    datediff(a.Contract_Renewal_Date__c, asof.d) AS days_to_renewal,
    c.cases_90d, c.sla_breaches_90d, round(c.sla_breaches_90d / c.cases_90d, 3) AS sla_breach_rate,
    CASE WHEN c.csat_responses_90d >= 3 THEN round(c.csat_avg_raw, 2) END AS csat_90d, c.csat_responses_90d,
    c.crit_high_90d, c.incident_cases_90d, coalesce(oc.open_cases, 0) AS open_cases, r.renewal_opp_stage,
    round(
        35 * least(c.sla_breaches_90d / c.cases_90d / 0.40, 1)
      + 30 * CASE WHEN c.csat_responses_90d >= 3 THEN (5 - c.csat_avg_raw) / 4 ELSE 0.5 END
      + 20 * least(c.crit_high_90d / c.cases_90d / 0.50, 1)
      + 15 * least(c.incident_cases_90d / 3.0, 1), 1) AS risk_score,
    asof.d AS data_as_of
  FROM workspace.salesforce_synth.account a CROSS JOIN asof
  JOIN c90 c ON c.AccountId = a.Id
  LEFT JOIN openc oc ON oc.AccountId = a.Id
  LEFT JOIN ren r ON r.AccountId = a.Id
  WHERE c.cases_90d >= 5
    AND a.Customer_Segment__c IN ({{segments}})      -- optional
    AND a.Hosting_Region__c IN ({{regions}})         -- optional
)
SELECT *, round(arr * risk_score / 100, 0) AS arr_at_risk,
  CASE WHEN risk_score >= 60 THEN 'High' WHEN risk_score >= 40 THEN 'Elevated' ELSE 'Watch' END AS risk_band
FROM scored
WHERE days_to_renewal BETWEEN {{min_days|0}} AND {{max_days|180}}
ORDER BY arr_at_risk DESC
LIMIT {{top_n|15}}
```

For the outage detail on the accounts that made the list, run this as a
follow-up query:

```sql
SELECT cs.AccountId, i.Name, i.Severity__c, i.Type__c, i.Component__c, i.Root_Cause__c, i.Start_Time__c, count(*) AS cases
FROM workspace.salesforce_synth.`case` cs
JOIN workspace.salesforce_synth.incident__c i ON i.Id = cs.Incident__c
WHERE cs.AccountId IN ({{account_ids}})
GROUP BY ALL ORDER BY cs.AccountId, i.Start_Time__c DESC
```

## Output

### Quick answer (in chat)
1. One line with the data date, and a stale note if it's older than 2 days.
2. **Headline:** total ARR at risk across the list, and how many accounts are in the High band.
3. A table: Account · Segment · ARR · Renews in · Risk (score + band) · Top driver · Renewal stage.
   The **top driver** is the score component that contributes the most points,
   written in plain words, e.g. "41% SLA breaches", "CSAT 1.5", "hit by INC-0001 Sev1 Payments API outage".
4. Three bullets of "so what": who to call first, and any shared cause (for
   example, several accounts hit by the same incident).

### Dashboard (when they ask for a dashboard, or say "make it live")
Build it as a **Claude Data** dashboard on the Databricks connector, with the
query above as the source of each chart.
- **Header:** "Renewal Risk Radar" · "Data as of {date}" · window and filters in use
- **KPI row:** ARR at risk · # High · # Elevated · median days to renewal
- **Main chart:** scatter, x = days to renewal, y = risk score, bubble size = ARR, colour = band
- **Table:** the ranked list described above, sortable
- **Breakdown:** ARR at risk by region and by segment (bars)
- **Outage panel:** the incidents behind at-risk accounts: incident, severity, component, # accounts affected
- **Colours:** red = High, amber = Elevated, grey = Watch. No other alarm colours.

### Story (when they ask for a summary, an exec update or a video)
Use a Claude Data story format: **Visual analysis** for a written summary,
**Scrollyteller** for a scrolling story, **Visual short** for a short narrated
video. Structure: what's at stake (ARR at risk) → the three accounts that matter
most and why → any shared cause → the ask (who acts, by when).

## Guardrails
- Never show a score without its drivers.
- Never compute renewal timing from `current_date()`.
- If fewer than 5 accounts qualify, say so and offer to widen the window.
