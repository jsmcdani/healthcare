WITH asof AS (SELECT CAST(max(CreatedDate) AS DATE) AS d FROM workspace.salesforce_synth.`case`),
c90 AS (
  SELECT cs.AccountId, count(*) AS cases_90d, count_if(cs.SLA_Breached__c) AS sla_breaches_90d,
    count_if(cs.Priority IN ('Critical','High')) AS crit_high_90d, count_if(cs.Incident__c IS NOT NULL) AS incident_cases_90d,
    count(cs.CSAT__c) AS csat_responses_90d, avg(cs.CSAT__c) AS csat_avg_raw
  FROM workspace.salesforce_synth.`case` cs CROSS JOIN asof
  WHERE CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 90)
  GROUP BY cs.AccountId),
inc AS (
  SELECT cs.AccountId, array_join(array_sort(collect_set(concat(i.Name, ' ', i.Severity__c, ' ', i.Component__c))), '; ') AS incidents
  FROM workspace.salesforce_synth.`case` cs CROSS JOIN asof
  JOIN workspace.salesforce_synth.incident__c i ON i.Id = cs.Incident__c
  WHERE CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 90)
  GROUP BY cs.AccountId),
openc AS (SELECT AccountId, count(*) AS open_cases FROM workspace.salesforce_synth.`case` WHERE NOT IsClosed GROUP BY AccountId),
ren AS (SELECT AccountId, max_by(StageName, CloseDate) AS renewal_stage FROM workspace.salesforce_synth.opportunity WHERE Type = 'Renewal' GROUP BY AccountId),
scored AS (
  SELECT a.Id AS account_id, a.Name AS account, a.Customer_Segment__c AS segment, a.Hosting_Region__c AS region,
    CAST(a.ARR__c AS DOUBLE) AS arr, CAST(a.Contract_Renewal_Date__c AS STRING) AS renewal_date,
    datediff(a.Contract_Renewal_Date__c, asof.d) AS days_to_renewal,
    a.Contract_Renewal_Date__c < current_date() AS renewal_date_passed,
    c.cases_90d, c.sla_breaches_90d, round(c.sla_breaches_90d / c.cases_90d, 3) AS sla_breach_rate,
    CASE WHEN c.csat_responses_90d >= 3 THEN round(c.csat_avg_raw, 2) END AS csat_90d, c.csat_responses_90d,
    round(c.crit_high_90d / c.cases_90d, 3) AS severe_share, c.incident_cases_90d, inc.incidents,
    coalesce(oc.open_cases, 0) AS open_cases, r.renewal_stage,
    35 * least(c.sla_breaches_90d / c.cases_90d / 0.40, 1) AS p_breach,
    30 * CASE WHEN c.csat_responses_90d >= 3 THEN (5 - c.csat_avg_raw) / 4 ELSE 0.5 END AS p_csat,
    20 * least(c.crit_high_90d / c.cases_90d / 0.50, 1) AS p_severe,
    15 * least(c.incident_cases_90d / 3.0, 1) AS p_outage,
    CAST(asof.d AS STRING) AS data_as_of
  FROM workspace.salesforce_synth.account a CROSS JOIN asof
  JOIN c90 c ON c.AccountId = a.Id
  LEFT JOIN inc ON inc.AccountId = a.Id
  LEFT JOIN openc oc ON oc.AccountId = a.Id
  LEFT JOIN ren r ON r.AccountId = a.Id
  WHERE c.cases_90d >= 5
    AND ('{{segment}}' = '' OR a.Customer_Segment__c = '{{segment}}')
    AND ('{{region}}' = '' OR a.Hosting_Region__c = '{{region}}')),
radar AS (
  SELECT *, round(p_breach + p_csat + p_severe + p_outage, 1) AS risk_score,
    round(arr * (p_breach + p_csat + p_severe + p_outage) / 100, 0) AS arr_at_risk,
    CASE WHEN p_breach + p_csat + p_severe + p_outage >= 60 THEN 'High'
         WHEN p_breach + p_csat + p_severe + p_outage >= 40 THEN 'Elevated' ELSE 'Watch' END AS risk_band,
    CASE greatest(p_breach, p_csat, p_severe, p_outage)
      WHEN p_breach THEN concat(CAST(round(sla_breach_rate * 100, 0) AS INT), '% SLA breaches')
      WHEN p_outage THEN concat(incident_cases_90d, ' outage-linked cases')
      WHEN p_severe THEN concat(CAST(round(severe_share * 100, 0) AS INT), '% Critical/High cases')
      ELSE CASE WHEN csat_90d IS NULL THEN 'CSAT unknown (few responses)' ELSE concat('CSAT ', csat_90d) END
    END AS top_driver
  FROM scored
  WHERE days_to_renewal BETWEEN 0 AND {{window_days}})
SELECT count(*) AS accounts, sum(arr) AS arr_renewing, sum(arr_at_risk) AS arr_at_risk,
  count_if(risk_band = 'High') AS high, count_if(risk_band = 'Elevated') AS elevated, count_if(risk_band = 'Watch') AS watch,
  CAST(percentile(days_to_renewal, 0.5) AS INT) AS median_days_to_renewal,
  count_if(incidents IS NOT NULL) AS accounts_hit_by_incidents,
  coalesce(sum(CASE WHEN incidents IS NOT NULL THEN arr_at_risk END), 0) AS arr_at_risk_incidents,
  max_by(account, arr_at_risk) AS top_account, max(arr_at_risk) AS top_account_arr_at_risk,
  (SELECT CAST(max(d) AS STRING) FROM asof) AS data_as_of,
  datediff(current_date(), (SELECT max(d) FROM asof)) AS days_since_data
FROM radar
