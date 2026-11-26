# ---------------------------------------------------------------- Account 360
A_ID = "a.Id = '{{account_id}}'"
ACCT_RULES = {"account_id": {"pattern": "^001SY[0-9A-Za-z]{13}$", "description": "Any account in the Salesforce copy"}}

a360 = {
 "account_list": ds("Account list", "Every account's name, segment and ARR, for the account picker.",
  f"SELECT a.Id AS account_id, a.Name AS account, a.Customer_Segment__c AS segment, CAST(a.ARR__c AS DOUBLE) AS arr FROM {T}.account a ORDER BY a.Name", {}),
 "acct": ds("Account profile", "The chosen account's profile, renewal, renewal opportunity stage and current risk score.", f"""
WITH {ASOF}, {C90}, {RISK},
ren AS (SELECT AccountId, max_by(StageName, CloseDate) AS renewal_stage, max_by(CAST(Amount AS DOUBLE), CloseDate) AS renewal_amount FROM {T}.opportunity WHERE Type = 'Renewal' GROUP BY AccountId)
SELECT a.Id AS account_id, a.Name AS account, a.Customer_Segment__c AS segment, a.Hosting_Region__c AS region,
  a.Industry AS industry, a.BillingCountry AS country, a.Type AS account_type, a.NumberOfEmployees AS employees,
  CAST(a.ARR__c AS DOUBLE) AS arr, CAST(a.Contract_Renewal_Date__c AS STRING) AS renewal_date,
  datediff(a.Contract_Renewal_Date__c, asof.d) AS days_to_renewal, a.Contract_Renewal_Date__c < current_date() AS renewal_date_passed,
  ren.renewal_stage, ren.renewal_amount,
  CASE WHEN r.cases_90d >= 5 THEN r.risk_score END AS risk_score, {BAND} AS risk_band,
  coalesce(r.cases_90d, 0) AS cases_90d,
  CAST(asof.d AS STRING) AS data_as_of, datediff(current_date(), asof.d) AS days_since_data
FROM {T}.account a CROSS JOIN asof
LEFT JOIN risk r ON r.AccountId = a.Id
LEFT JOIN ren ON ren.AccountId = a.Id
WHERE {A_ID}""", ACCT_RULES),
 "health": ds("Support health, last 90 days vs prior 90", "Cases, SLA breaches, CSAT, severe cases, incident-linked cases and resolution time in two 90-day periods.", f"""
WITH {ASOF}
SELECT CASE WHEN CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 90) THEN 'last_90d' ELSE 'prior_90d' END AS period,
  count(*) AS cases, count_if(cs.SLA_Breached__c) AS sla_breaches,
  round(count_if(cs.SLA_Breached__c) / count(*), 3) AS breach_rate,
  count(cs.CSAT__c) AS csat_responses, round(avg(cs.CSAT__c), 2) AS csat,
  count_if(cs.Priority IN ('Critical','High')) AS severe_cases,
  count_if(cs.Incident__c IS NOT NULL) AS incident_cases,
  round(avg(cs.Resolution_Hours__c), 1) AS avg_resolution_hours
FROM {T}.`case` cs CROSS JOIN asof JOIN {T}.account a ON a.Id = cs.AccountId
WHERE {A_ID} AND CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 180)
GROUP BY 1 ORDER BY 1""", ACCT_RULES),
 "monthly": ds("Cases by month", "Cases, SLA breaches and CSAT per month over the 12 months to the snapshot date.", f"""
WITH {ASOF}
SELECT date_format(cs.CreatedDate, 'yyyy-MM') AS month, count(*) AS cases, count_if(cs.SLA_Breached__c) AS sla_breaches,
  round(avg(cs.CSAT__c), 2) AS csat, count(cs.CSAT__c) AS csat_responses
FROM {T}.`case` cs CROSS JOIN asof JOIN {T}.account a ON a.Id = cs.AccountId
WHERE {A_ID} AND CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 365)
GROUP BY 1 ORDER BY 1""", ACCT_RULES),
 "acct_incidents": ds("Incidents that hit this account", "Platform incidents linked to the account's cases, all time.", f"""
SELECT i.Name AS incident, i.Severity__c AS severity, i.Type__c AS type, i.Component__c AS component,
  i.Root_Cause__c AS root_cause, CAST(CAST(i.Start_Time__c AS DATE) AS STRING) AS started,
  round((unix_timestamp(i.End_Time__c) - unix_timestamp(i.Start_Time__c)) / 3600, 1) AS duration_hours,
  count(*) AS cases, count_if(cs.SLA_Breached__c) AS sla_breaches
FROM {T}.`case` cs JOIN {T}.incident__c i ON i.Id = cs.Incident__c JOIN {T}.account a ON a.Id = cs.AccountId
WHERE {A_ID}
GROUP BY ALL ORDER BY started DESC""", ACCT_RULES),
 "reasons": ds("Case reasons, last 90 days", "Why the account opened cases in the last 90 days.", f"""
WITH {ASOF}
SELECT cs.Reason AS reason, count(*) AS cases, count_if(cs.SLA_Breached__c) AS sla_breaches, count_if(NOT cs.IsClosed) AS still_open
FROM {T}.`case` cs CROSS JOIN asof JOIN {T}.account a ON a.Id = cs.AccountId
WHERE {A_ID} AND CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 90)
GROUP BY 1 ORDER BY cases DESC""", ACCT_RULES),
 "opps": ds("Opportunities", "The account's open and recent opportunities.", f"""
SELECT o.Id AS opp_id, o.Name AS opportunity, o.Type AS type, o.StageName AS stage, CAST(o.Amount AS DOUBLE) AS amount,
  CAST(o.CloseDate AS STRING) AS close_date, o.Probability AS probability, o.IsClosed AS is_closed, o.Loss_Reason__c AS loss_reason
FROM {T}.opportunity o JOIN {T}.account a ON a.Id = o.AccountId
WHERE {A_ID}
ORDER BY o.IsClosed, o.CloseDate DESC LIMIT 25""", ACCT_RULES),
 "contacts": ds("Key contacts", "Up to 8 contacts at the account, senior titles first. Emails are left out.", f"""
SELECT c.Id AS contact_id, concat_ws(' ', c.FirstName, c.LastName) AS name, c.Title AS title, c.Department AS department
FROM {T}.contact c JOIN {T}.account a ON a.Id = c.AccountId
WHERE {A_ID}
ORDER BY CASE WHEN c.Title RLIKE '(?i)chief|vp|vice president|head|director' THEN 0 ELSE 1 END, c.LastName
LIMIT 8""", ACCT_RULES),
}

a360_body = """<div class="rr">
  <header class="rr-head" id="header">
    <label class="rr-search" for="acct-search">Find an account
      <input id="acct-search" type="search" list="acct-options" autocomplete="off" placeholder="Type an account name">
      <datalist id="acct-options" data-draw="acctoptions" data-source="account_list"></datalist>
    </label>
    <h1 class="rr-title" data-draw="num" data-source="acct" data-field="account" data-row="0">—</h1>
    <p class="rr-facts" id="facts">
      <span data-draw="num" data-source="acct" data-field="segment" data-row="0">—</span>
      <span data-draw="num" data-source="acct" data-field="region" data-row="0">—</span>
      <span data-draw="num" data-source="acct" data-field="industry" data-row="0">—</span>
      <span data-draw="num" data-source="acct" data-field="country" data-row="0">—</span>
      <span><span data-draw="num" data-source="acct" data-field="employees" data-row="0" data-fmt="int">—</span> employees</span>
    </p>
    <p class="rr-meta">Data as of <span data-draw="num" data-source="acct" data-field="data_as_of" data-row="0" data-fmt="date">—</span> · support figures cover the 90 days before that date</p>
    <p class="rr-stale" id="stale" hidden>This snapshot is <span data-draw="num" data-source="acct" data-field="days_since_data" data-row="0" data-fmt="int">—</span> days old.</p>
    <p class="rr-stale" id="passed" hidden>The renewal date in the data has already passed as of today.</p>
  </header>

  <div class="rr-kpis" id="kpis">
    <div class="rr-card" id="kpi-arr"><span class="rr-kpi-label">ARR</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="acct" data-field="arr" data-row="0" data-fmt="money">—</span></div>
    <div class="rr-card" id="kpi-renewal"><span class="rr-kpi-label">Renews in</span>
      <span class="rr-kpi-value dash-skeleton"><span data-draw="num" data-source="acct" data-field="days_to_renewal" data-row="0" data-fmt="int">—</span> days</span>
      <span class="rr-kpi-note"><span data-draw="num" data-source="acct" data-field="renewal_date" data-row="0" data-fmt="date">—</span> · <span data-draw="num" data-source="acct" data-field="renewal_stage" data-row="0">—</span></span></div>
    <div class="rr-card" id="kpi-risk"><span class="rr-kpi-label">Risk score</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="acct" data-field="risk_score" data-row="0" data-fmt="num1">—</span>
      <span class="rr-kpi-note" data-draw="num" data-source="acct" data-field="risk_band" data-row="0">—</span></div>
    <div class="rr-card" id="kpi-breach"><span class="rr-kpi-label">SLA breach rate, last 90 days</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="health" data-field="breach_rate" data-where="period=last_90d" data-fmt="pct">—</span>
      <span class="rr-kpi-note">prior 90 days <span data-draw="num" data-source="health" data-field="breach_rate" data-where="period=prior_90d" data-fmt="pct">—</span></span></div>
    <div class="rr-card" id="kpi-csat"><span class="rr-kpi-label">CSAT, last 90 days</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="health" data-field="csat" data-where="period=last_90d" data-fmt="num1">—</span>
      <span class="rr-kpi-note"><span data-draw="num" data-source="health" data-field="csat_responses" data-where="period=last_90d" data-fmt="int">—</span> ratings · prior 90 days <span data-draw="num" data-source="health" data-field="csat" data-where="period=prior_90d" data-fmt="num1">—</span></span></div>
  </div>

  <section class="rr-section" id="trend">
    <h2>Cases and SLA breaches by month</h2>
    <p class="rr-sub">Bars are cases opened each month. Red is the part that breached SLA. Dashed lines mark incident start dates.</p>
    <ul class="rr-legend" aria-hidden="true">
      <li><span class="rr-sw" style="background: var(--cds-chart-muted)"></span>Cases within SLA</li>
      <li><span class="rr-sw" style="background: var(--color-bad)"></span>SLA breached</li>
    </ul>
    <div class="rr-chart dash-skeleton" data-draw="monthly" data-source="monthly acct_incidents"></div>
  </section>

  <section class="rr-section" id="health">
    <h2>Support health</h2>
    <div class="rr-tablewrap">
      <table class="rr-cmp">
        <thead><tr><th>Measure</th><th>Last 90 days</th><th>Prior 90 days</th></tr></thead>
        <tbody>
          <tr><td>Cases</td><td data-draw="num" data-source="health" data-field="cases" data-where="period=last_90d" data-fmt="int">—</td><td data-draw="num" data-source="health" data-field="cases" data-where="period=prior_90d" data-fmt="int">—</td></tr>
          <tr><td>SLA breaches</td><td data-draw="num" data-source="health" data-field="sla_breaches" data-where="period=last_90d" data-fmt="int">—</td><td data-draw="num" data-source="health" data-field="sla_breaches" data-where="period=prior_90d" data-fmt="int">—</td></tr>
          <tr><td>Critical or High priority cases</td><td data-draw="num" data-source="health" data-field="severe_cases" data-where="period=last_90d" data-fmt="int">—</td><td data-draw="num" data-source="health" data-field="severe_cases" data-where="period=prior_90d" data-fmt="int">—</td></tr>
          <tr><td>Cases linked to an incident</td><td data-draw="num" data-source="health" data-field="incident_cases" data-where="period=last_90d" data-fmt="int">—</td><td data-draw="num" data-source="health" data-field="incident_cases" data-where="period=prior_90d" data-fmt="int">—</td></tr>
          <tr><td>Average hours to resolve</td><td data-draw="num" data-source="health" data-field="avg_resolution_hours" data-where="period=last_90d" data-fmt="num1">—</td><td data-draw="num" data-source="health" data-field="avg_resolution_hours" data-where="period=prior_90d" data-fmt="num1">—</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <div class="rr-twocol">
    <section class="rr-section" id="incidents">
      <h2>Incidents that hit this account</h2>
      <div class="rr-tablewrap"><table class="rr-table" data-source="acct_incidents" data-row-key="incident">
        <thead><tr><th data-field="incident">Incident</th><th data-field="severity">Severity</th><th data-field="component">Component</th><th data-field="root_cause">Root cause</th><th data-field="started">Started</th><th data-field="cases" class="num">Cases</th></tr></thead>
        <tbody data-draw="incrows"></tbody></table></div>
      <p class="rr-msg" data-draw="incmsg"></p>
    </section>
    <section class="rr-section" id="reasons">
      <h2>Why they opened cases, last 90 days</h2>
      <div class="rr-bars dash-skeleton" data-draw="reasonbars" data-source="reasons"></div>
    </section>
  </div>

  <section class="rr-section" id="pipeline">
    <h2>Opportunities</h2>
    <p class="rr-sub">Open deals first, then the most recent closed ones.</p>
    <div class="rr-tablewrap"><table class="rr-table" data-source="opps" data-row-key="opp_id">
      <thead><tr><th data-field="opportunity">Opportunity</th><th data-field="type">Type</th><th data-field="stage">Stage</th><th data-field="amount" class="num">Amount</th><th data-field="close_date">Close date</th><th data-field="loss_reason">Loss reason</th></tr></thead>
      <tbody data-draw="opprows"></tbody></table></div>
    <p class="rr-msg" data-draw="oppmsg"></p>
  </section>

  <section class="rr-section" id="contacts">
    <h2>Who to talk to</h2>
    <div class="rr-tablewrap"><table class="rr-table" data-source="contacts" data-row-key="contact_id">
      <thead><tr><th data-field="name">Name</th><th data-field="title">Title</th><th data-field="department">Department</th></tr></thead>
      <tbody data-draw="contactrows"></tbody></table></div>
    <p class="rr-msg" data-draw="contactmsg"></p>
  </section>

  <details class="rr-notes" id="method">
    <summary>How these numbers work</summary>
    <ul>
      <li>All figures come from the Salesforce data in Databricks (workspace.salesforce_synth). Time windows count back from the latest case in the data, not from today.</li>
      <li>The risk score uses the same definition as the Renewal Risk Radar. It is only given when the account had at least 5 cases in the last 90 days.</li>
      <li>CSAT is the average of the ratings customers gave. With fewer than 3 ratings in a period it is too thin to read much into.</li>
    </ul>
  </details>
</div>"""

a360_js = """<script>
const search = document.querySelectorAll('#acct-search');
search.forEach((el) => el.addEventListener('change', () => {
  const s = dash.data('account_list');
  if (s.status !== 'ok') return;
  const v = el.value.trim().toLowerCase();
  const hit = s.data.find((d) => d.account.toLowerCase() === v) || s.data.find((d) => d.account.toLowerCase().startsWith(v));
  if (hit) { dash.setParams({ account_id: hit.account_id }); el.value = ''; el.blur(); }
}));
dash.onData(() => {
  const a = dash.data('acct');
  const row = a.status === 'ok' ? a.data[0] : null;
  document.querySelectorAll('#stale').forEach((el) => { el.hidden = !(row && Number(row.days_since_data) > 2); });
  document.querySelectorAll('#passed').forEach((el) => { el.hidden = !(row && (row.renewal_date_passed === true || row.renewal_date_passed === 'true')); });
});
dash.draw('acctoptions', (el) => {
  const s = dash.data('account_list');
  el.replaceChildren(...(s.status === 'ok' ? s.data : []).map((d) => { const o = document.createElement('option'); o.value = d.account; o.label = `${d.segment} · ${window.rr.money(d.arr)} ARR`; return o; }));
});
dash.draw('monthly', (el) => {
  const s = dash.data('monthly'), inc = dash.data('acct_incidents');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  const rows = s.data.map((d) => ({ ...d, c: Number(d.cases), b: Number(d.sla_breaches) }));
  if (!rows.length) { const p = document.createElement('p'); p.className = 'rr-msg'; p.textContent = 'No cases in the last 12 months.'; el.append(p); return; }
  const W = Math.max(280, el.clientWidth), H = 300, m = { t: 12, r: 12, b: 36, l: 34 };
  const x = d3.scaleBand().domain(rows.map((d) => d.month)).range([m.l, W - m.r]).padding(0.25);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.c) || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', 'Monthly cases with SLA breaches highlighted');
  svg.append('g').attr('class', 'rr-grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  const fmtM = (k) => d3.utcFormat(W < 480 ? '%b' : '%b %y')(new Date(k + '-01T00:00:00Z'));
  const every = W < 480 ? 2 : 1;
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(x.domain().filter((d, i) => i % every === 0)).tickFormat(fmtM).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSizeOuter(0));
  const tip = d3.select(el).append('div').attr('class', 'rr-tip').style('display', 'none');
  const g = svg.append('g').selectAll('g').data(rows).join('g');
  g.append('rect').attr('x', (d) => x(d.month)).attr('width', x.bandwidth()).attr('y', (d) => y(d.c)).attr('height', (d) => y(0) - y(d.c)).style('fill', 'var(--cds-chart-muted)');
  g.append('rect').attr('x', (d) => x(d.month)).attr('width', x.bandwidth()).attr('y', (d) => y(d.b)).attr('height', (d) => y(0) - y(d.b)).style('fill', 'var(--color-bad)');
  g.on('pointerenter pointermove', (event, d) => {
    const [px, py] = d3.pointer(event, el);
    tip.style('display', 'block').html('');
    tip.append('strong').text(fmtM(d.month));
    tip.append('span').text(`${d.c} cases · ${d.b} breached SLA`);
    tip.append('span').text(Number(d.csat_responses) >= 3 ? `CSAT ${Number(d.csat).toFixed(1)} from ${d.csat_responses} ratings` : `${d.csat_responses} CSAT ratings`);
    tip.style('left', Math.min(Math.max(0, px + 12), el.clientWidth - 220) + 'px').style('top', Math.max(0, py - 60) + 'px');
  }).on('pointerleave', () => tip.style('display', 'none'));
  if (inc.status === 'ok') inc.data.forEach((d) => {
    const k = String(d.started).slice(0, 7);
    if (!x.domain().includes(k)) return;
    const cx = x(k) + x.bandwidth() / 2;
    svg.append('line').attr('class', 'rr-ref').attr('x1', cx).attr('x2', cx).attr('y1', m.t).attr('y2', H - m.b);
    svg.append('text').attr('class', 'rr-ref-label').attr('x', cx + 4).attr('y', m.t + 10).text(`${d.incident} ${d.severity}`);
  });
});
dash.draw('reasonbars', (el) => {
  const s = dash.data('reasons');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.reason, value: (d) => Number(d.cases), valueText: (d) => `${d.cases} · ${d.sla_breaches} breached`, aria: 'Case reasons in the last 90 days', empty: 'No cases in the last 90 days.' });
});
dash.draw('incrows', (el) => window.rr.tbody(el, 'acct_incidents', 'incident', [
  { f: 'incident' }, { f: 'severity' }, { f: 'component' }, { f: 'root_cause' }, { f: 'started', fmt: 'date' }, { f: 'cases', fmt: 'int', num: true }]));
dash.draw('incmsg', (el) => window.rr.msg(el, 'acct_incidents', 'No incidents linked to this account.'));
dash.draw('opprows', (el) => window.rr.tbody(el, 'opps', 'opp_id', [
  { f: 'opportunity' }, { f: 'type' }, { f: 'stage' }, { f: 'amount', fmt: 'money', num: true }, { f: 'close_date', fmt: 'date' }, { f: 'loss_reason' }]));
dash.draw('oppmsg', (el) => window.rr.msg(el, 'opps', 'No opportunities on this account.'));
dash.draw('contactrows', (el) => window.rr.tbody(el, 'contacts', 'contact_id', [{ f: 'name' }, { f: 'title' }, { f: 'department' }]));
dash.draw('contactmsg', (el) => window.rr.msg(el, 'contacts', 'No contacts on this account.'));
</script>"""

write("a360", "https://claude.ai/artifact/KdhtLFHSbCG5ehKxwP22Fr", {"title": "Account 360"},
      {"account_id": "001SY000000000004L"}, a360, page(a360_body, a360_js, list(a360)))

# ---------------------------------------------------------------- Expansion Radar
EXP_CTE = f"""WITH {ASOF}, {C90}, {RISK},
won_up AS (SELECT AccountId, count(*) AS upgrades_won_12m FROM {T}.opportunity CROSS JOIN asof
  WHERE Type = 'Existing Customer - Upgrade' AND IsWon AND CloseDate > date_sub(asof.d, 365) GROUP BY AccountId),
open_up AS (SELECT DISTINCT AccountId FROM {T}.opportunity WHERE Type = 'Existing Customer - Upgrade' AND NOT IsClosed),
typical AS (SELECT a.Customer_Segment__c AS segment, percentile(CAST(o.Amount AS DOUBLE), 0.5) AS typical_upgrade
  FROM {T}.opportunity o JOIN {T}.account a ON a.Id = o.AccountId CROSS JOIN asof
  WHERE o.Type = 'Existing Customer - Upgrade' AND o.IsWon AND o.CloseDate > date_sub(asof.d, 365) GROUP BY 1),
base AS (
  SELECT a.Id AS account_id, a.Name AS account, a.Customer_Segment__c AS segment, a.Hosting_Region__c AS region,
    CAST(a.ARR__c AS DOUBLE) AS arr, a.NumberOfEmployees AS employees,
    round(a.ARR__c / greatest(a.NumberOfEmployees, 1), 0) AS arr_per_employee,
    percent_rank() OVER (PARTITION BY a.Customer_Segment__c ORDER BY a.ARR__c / greatest(a.NumberOfEmployees, 1)) AS ape_pct,
    coalesce(r.cases_90d, 0) AS cases_90d, r.risk_score, r.csat_90d, coalesce(r.feature_requests_90d, 0) AS feature_requests_90d,
    coalesce(w.upgrades_won_12m, 0) AS upgrades_won_12m, t.typical_upgrade,
    datediff(a.Contract_Renewal_Date__c, asof.d) AS days_to_renewal, CAST(asof.d AS STRING) AS data_as_of,
    datediff(current_date(), asof.d) AS days_since_data, ou.AccountId IS NOT NULL AS has_open_upgrade
  FROM {T}.account a CROSS JOIN asof
  LEFT JOIN risk r ON r.AccountId = a.Id
  LEFT JOIN won_up w ON w.AccountId = a.Id
  LEFT JOIN open_up ou ON ou.AccountId = a.Id
  LEFT JOIN typical t ON t.segment = a.Customer_Segment__c),
cand AS (
  SELECT *,
    CASE WHEN cases_90d >= 5 THEN 40 * (1 - risk_score / 100) ELSE 30 END AS p_health,
    20 * least(feature_requests_90d / 3.0, 1) AS p_demand,
    20 * (1 - ape_pct) AS p_whitespace,
    CASE WHEN upgrades_won_12m > 0 THEN 20 ELSE 0 END AS p_momentum
  FROM base
  WHERE NOT has_open_upgrade AND (cases_90d < 5 OR risk_score < 40)
    AND ('{{{{segment}}}}' = '' OR segment = '{{{{segment}}}}') AND ('{{{{region}}}}' = '' OR region = '{{{{region}}}}')),
exp AS (
  SELECT *, round(p_health + p_demand + p_whitespace + p_momentum, 1) AS expansion_score,
    CASE WHEN p_health + p_demand + p_whitespace + p_momentum >= 70 THEN 'Strong'
         WHEN p_health + p_demand + p_whitespace + p_momentum >= 55 THEN 'Good' ELSE 'Possible' END AS expansion_band,
    concat_ws(' · ',
      CASE WHEN cases_90d < 5 THEN 'Quiet support' WHEN risk_score < 20 THEN 'Very healthy support' ELSE 'Healthy support' END,
      CASE WHEN csat_90d >= 4.3 THEN concat('CSAT ', csat_90d) END,
      CASE WHEN feature_requests_90d > 0 THEN concat(feature_requests_90d, ' feature request', CASE WHEN feature_requests_90d > 1 THEN 's' ELSE '' END) END,
      CASE WHEN upgrades_won_12m > 0 THEN concat('Upgraded ', upgrades_won_12m, 'x in 12 months') END,
      CASE WHEN ape_pct < 0.25 THEN 'Low ARR per employee' END) AS signals
  FROM cand)"""
EXP_RULES = {"segment": SEG_RULE, "region": REG_RULE}

exp = {
 "exp": ds("Expansion candidates", "Healthy accounts with no open upgrade, scored on support health, feature requests, ARR per employee and past upgrades.", EXP_CTE + """
SELECT account_id, account, segment, region, arr, employees, arr_per_employee, cases_90d, risk_score, csat_90d,
  feature_requests_90d, upgrades_won_12m, typical_upgrade, expansion_score, expansion_band, signals, days_to_renewal, data_as_of
FROM exp ORDER BY expansion_score DESC, arr DESC LIMIT 300""", EXP_RULES),
 "exp_summary": ds("Expansion totals", "Candidate counts, their ARR, and what one segment-median upgrade per Strong candidate would add.", EXP_CTE + """
SELECT count(*) AS candidates, count_if(expansion_band = 'Strong') AS strong, count_if(expansion_band = 'Good') AS good,
  sum(arr) AS candidate_arr,
  coalesce(sum(CASE WHEN expansion_band = 'Strong' THEN typical_upgrade END), 0) AS strong_potential,
  count_if(feature_requests_90d > 0) AS with_feature_requests,
  max(data_as_of) AS data_as_of, max(days_since_data) AS days_since_data
FROM exp""", EXP_RULES),
 "exp_by_region": ds("Strong candidates by region", "Strong candidates and their upgrade potential per region.", EXP_CTE + """
SELECT region, count(*) AS candidates, count_if(expansion_band = 'Strong') AS strong,
  coalesce(sum(CASE WHEN expansion_band = 'Strong' THEN typical_upgrade END), 0) AS strong_potential
FROM exp GROUP BY region ORDER BY strong_potential DESC""", EXP_RULES),
}

exp_body = """<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">Expansion Radar</h1>
    <p class="rr-lede" id="takeaway"><b data-draw="num" data-source="exp_summary" data-field="strong" data-row="0" data-fmt="int" class="dash-skeleton">—</b> healthy accounts look ready for an upgrade and have none in the pipeline. One typical upgrade each would add <b data-draw="num" data-source="exp_summary" data-field="strong_potential" data-row="0" data-fmt="money" class="dash-skeleton">—</b>.</p>
    <p class="rr-meta">Data as of <span data-draw="num" data-source="exp_summary" data-field="data_as_of" data-row="0" data-fmt="date">—</span> · support signals over the 90 days before that date</p>
    <p class="rr-stale" id="stale" hidden>This snapshot is <span data-draw="num" data-source="exp_summary" data-field="days_since_data" data-row="0" data-fmt="int">—</span> days old.</p>
  </header>
  <div class="rr-filters" id="filters">
    <label>Segment<select class="dash-select" id="f-segment" aria-label="Segment"><option value="">All segments</option><option value="Enterprise">Enterprise</option><option value="Mid-Market">Mid-Market</option><option value="SMB">SMB</option></select></label>
    <label>Region<select class="dash-select" id="f-region" aria-label="Region"><option value="">All regions</option><option value="US-East">US-East</option><option value="US-West">US-West</option><option value="EU">EU</option><option value="APAC">APAC</option></select></label>
  </div>
  <div class="rr-kpis" id="kpis">
    <div class="rr-card" id="kpi-strong"><span class="rr-kpi-label">Strong candidates</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="exp_summary" data-field="strong" data-row="0" data-fmt="int">—</span><span class="rr-kpi-note">score 70 or more</span></div>
    <div class="rr-card" id="kpi-good"><span class="rr-kpi-label">Good candidates</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="exp_summary" data-field="good" data-row="0" data-fmt="int">—</span><span class="rr-kpi-note">score 55 to 69</span></div>
    <div class="rr-card" id="kpi-potential"><span class="rr-kpi-label">Upgrade potential, Strong</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="exp_summary" data-field="strong_potential" data-row="0" data-fmt="money">—</span><span class="rr-kpi-note">one segment-median upgrade each</span></div>
    <div class="rr-card" id="kpi-fr"><span class="rr-kpi-label">Asking for features</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="exp_summary" data-field="with_feature_requests" data-row="0" data-fmt="int">—</span><span class="rr-kpi-note">candidates with a feature request, last 90 days</span></div>
    <div class="rr-card" id="kpi-all"><span class="rr-kpi-label">All candidates</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="exp_summary" data-field="candidates" data-row="0" data-fmt="int">—</span><span class="rr-kpi-note"><span data-draw="num" data-source="exp_summary" data-field="candidate_arr" data-row="0" data-fmt="money">—</span> ARR</span></div>
  </div>
  <section class="rr-section" id="regions">
    <h2>Upgrade potential by region</h2>
    <p class="rr-sub">Strong candidates only. Click a bar to filter the page to that region.</p>
    <div class="rr-bars dash-skeleton" data-draw="regionbars" data-source="exp_by_region"></div>
  </section>
  <section class="rr-section" id="accounts">
    <h2>Top 30 candidates</h2>
    <p class="rr-sub">Ranked by expansion score. Signals say why each account made the list.</p>
    <div class="rr-tablewrap"><table class="rr-table" data-source="exp" data-row-key="account_id">
      <thead><tr><th data-field="account">Account</th><th data-field="segment">Segment</th><th data-field="region">Region</th><th data-field="arr" class="num">ARR</th><th data-field="expansion_score" class="num">Score</th><th data-field="signals">Signals</th><th data-field="typical_upgrade" class="num">Typical upgrade</th></tr></thead>
      <tbody data-draw="exprows"></tbody></table></div>
    <p class="rr-msg" data-draw="expmsg"></p>
  </section>
  <details class="rr-notes" id="method">
    <summary>How the expansion score works</summary>
    <ul>
      <li>Candidates are accounts with no open upgrade opportunity and healthy support: a risk score under 40, or fewer than 5 cases in the last 90 days.</li>
      <li>Support health gives up to 40 points: 40 minus 40% of the risk score, or 30 points for accounts with few cases. Feature requests in the last 90 days give up to 20 (full at 3). Low ARR per employee compared with others in the same segment gives up to 20, as a sign of room to grow. A won upgrade in the last 12 months gives 20.</li>
      <li>Bands: Strong is 70 or more, Good is 55 to 69, Possible is below 55.</li>
      <li>Typical upgrade is the median won upgrade in the account's segment over the last 12 months. Upgrade potential is a rough sizing, not a forecast.</li>
      <li>There is no product usage data in this source, so usage growth is not part of the score.</li>
    </ul>
  </details>
</div>"""

FILTER_JS = """<script>
const fSeg = document.querySelectorAll('#f-segment'), fReg = document.querySelectorAll('#f-region'), fType = document.querySelectorAll('#f-type');
fSeg.forEach((el) => el.addEventListener('change', () => dash.setParams({ segment: el.value })));
fReg.forEach((el) => el.addEventListener('change', () => dash.setParams({ region: el.value })));
fType.forEach((el) => el.addEventListener('change', () => dash.setParams({ opp_type: el.value })));
dash.onData(() => {
  const p = dash.params();
  fSeg.forEach((el) => { if (document.activeElement !== el) el.value = p.segment ?? ''; });
  fReg.forEach((el) => { if (document.activeElement !== el) el.value = p.region ?? ''; });
  fType.forEach((el) => { if (document.activeElement !== el) el.value = p.opp_type ?? ''; });
  const s = dash.data(window.rr.summaryId);
  const days = s.status === 'ok' && s.data[0] ? Number(s.data[0].days_since_data) : 0;
  document.querySelectorAll('#stale').forEach((el) => { el.hidden = !(days > 2); });
});
</script>"""

exp_js = """<script>window.rr.summaryId = 'exp_summary';</script>""" + FILTER_JS + """<script>
dash.draw('regionbars', (el) => {
  const s = dash.data('exp_by_region');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.region, value: (d) => Number(d.strong_potential), right: 120,
    valueText: (d) => `${window.rr.money(d.strong_potential)} · ${d.strong} strong`, aria: 'Upgrade potential by region',
    onClick: (d) => dash.setParams({ region: dash.params().region === d.region ? '' : d.region }), empty: 'No candidates match these filters.' });
});
dash.draw('exprows', (el) => window.rr.tbody(el, 'exp', 'account_id', [
  { f: 'account' }, { f: 'segment' }, { f: 'region' }, { f: 'arr', fmt: 'money', num: true },
  { f: 'expansion_score', num: true, render: (td, d) => { td.textContent = Number(d.expansion_score).toFixed(0); window.rr.pill(td, d.expansion_band); } },
  { f: 'signals' }, { f: 'typical_upgrade', fmt: 'money', num: true }], 30));
dash.draw('expmsg', (el) => window.rr.msg(el, 'exp', 'No candidates match these filters.'));
</script>
<style>.rr-pill-Strong { color: var(--color-ok); } .rr-pill-Good { color: var(--color-fg); } .rr-pill-Possible { color: var(--color-fg-muted); }</style>"""

write("expansion", "https://claude.ai/artifact/D5GE7thnBMZjshkbBd4ktX", {"title": "Expansion Radar"},
      {"segment": "", "region": ""}, exp, page(exp_body, exp_js, list(exp)))

# ---------------------------------------------------------------- Pipeline Health
TYPE_RULE = {"enum": ["", "New Customer", "Existing Customer - Upgrade", "Renewal"]}
PIPE_RULES = {"segment": SEG_RULE, "region": REG_RULE, "opp_type": TYPE_RULE}
PIPE_CTE = f"""WITH {ASOF}, {C90}, {RISK},
opps AS (
  SELECT o.Id AS opp_id, o.Name AS opportunity, o.Type AS type, o.StageName AS stage, CAST(o.Amount AS DOUBLE) AS amount,
    o.Probability AS probability, o.CloseDate AS close_date, o.IsClosed AS is_closed, o.IsWon AS is_won, o.Loss_Reason__c AS loss_reason,
    a.Id AS account_id, a.Name AS account, a.Customer_Segment__c AS segment, a.Hosting_Region__c AS region,
    {BAND} AS risk_band, asof.d AS asof_d
  FROM {T}.opportunity o JOIN {T}.account a ON a.Id = o.AccountId CROSS JOIN asof
  LEFT JOIN risk r ON r.AccountId = a.Id
  WHERE {SEGREG} AND ('{{{{opp_type}}}}' = '' OR o.Type = '{{{{opp_type}}}}'))"""

pipe = {
 "pipe_summary": ds("Pipeline totals", "Open and weighted pipeline, trailing 12-month wins and win rate, and pipeline at High-risk accounts.", PIPE_CTE + """
SELECT coalesce(sum(CASE WHEN NOT is_closed THEN amount END), 0) AS open_amount,
  coalesce(sum(CASE WHEN NOT is_closed THEN amount * probability / 100 END), 0) AS weighted_amount,
  count_if(NOT is_closed) AS open_deals,
  coalesce(sum(CASE WHEN NOT is_closed AND close_date <= date_add(asof_d, 90) THEN amount END), 0) AS closing_90d,
  coalesce(sum(CASE WHEN is_won AND close_date > date_sub(asof_d, 365) THEN amount END), 0) AS won_12m,
  round(count_if(is_won AND close_date > date_sub(asof_d, 365)) / nullif(count_if(is_closed AND close_date > date_sub(asof_d, 365)), 0), 3) AS win_rate_12m,
  avg(CASE WHEN is_won AND close_date > date_sub(asof_d, 365) THEN amount END) AS avg_won_12m,
  coalesce(sum(CASE WHEN NOT is_closed AND risk_band = 'High' THEN amount END), 0) AS open_at_high_risk,
  count_if(NOT is_closed AND risk_band = 'High') AS open_deals_high_risk,
  coalesce(sum(CASE WHEN loss_reason = 'Service Reliability' AND close_date > date_sub(asof_d, 365) THEN amount END), 0) AS lost_reliability_12m,
  count_if(loss_reason = 'Service Reliability' AND close_date > date_sub(asof_d, 365)) AS lost_reliability_deals_12m,
  CAST(max(asof_d) AS STRING) AS data_as_of, datediff(current_date(), max(asof_d)) AS days_since_data
FROM opps""", PIPE_RULES),
 "pipe_stage": ds("Open pipeline by stage", "Open deals, amount and probability-weighted amount per stage.", PIPE_CTE + """
SELECT stage, CASE stage WHEN 'Prospecting' THEN 1 WHEN 'Qualification' THEN 2 WHEN 'Proposal/Price Quote' THEN 3 WHEN 'Negotiation/Review' THEN 4 ELSE 5 END AS stage_order,
  count(*) AS deals, sum(amount) AS amount, sum(amount * probability / 100) AS weighted
FROM opps WHERE NOT is_closed GROUP BY stage ORDER BY stage_order""", PIPE_RULES),
 "pipe_quarters": ds("Won, lost and open by quarter", "Closed-won, closed-lost and open amounts by close quarter, from 12 months before the snapshot onward.", PIPE_CTE + """
SELECT concat(year(close_date), ' Q', quarter(close_date)) AS quarter,
  coalesce(sum(CASE WHEN is_won THEN amount END), 0) AS won,
  coalesce(sum(CASE WHEN is_closed AND NOT is_won THEN amount END), 0) AS lost,
  coalesce(sum(CASE WHEN NOT is_closed THEN amount END), 0) AS open,
  coalesce(sum(CASE WHEN NOT is_closed THEN amount * probability / 100 END), 0) AS open_weighted
FROM opps WHERE close_date > date_sub(asof_d, 365) GROUP BY 1 ORDER BY 1""", PIPE_RULES),
 "loss_reasons": ds("Why deals were lost, last 12 months", "Closed-lost deals and amount by loss reason.", PIPE_CTE + """
SELECT coalesce(loss_reason, 'Not given') AS loss_reason, count(*) AS deals, sum(amount) AS amount
FROM opps WHERE is_closed AND NOT is_won AND close_date > date_sub(asof_d, 365)
GROUP BY 1 ORDER BY amount DESC""", PIPE_RULES),
 "win_by_type": ds("Win rate by deal type, last 12 months", "Closed deals, wins, win rate and average won amount per opportunity type.", PIPE_CTE + """
SELECT type, count(*) AS closed_deals, count_if(is_won) AS won_deals, round(count_if(is_won) / count(*), 3) AS win_rate,
  avg(CASE WHEN is_won THEN amount END) AS avg_won
FROM opps WHERE is_closed AND close_date > date_sub(asof_d, 365) GROUP BY type ORDER BY type""", PIPE_RULES),
 "top_open": ds("Biggest deals closing in the next 90 days", "The 25 largest open deals with a close date within 90 days of the snapshot, with the account's risk band.", PIPE_CTE + """
SELECT opp_id, account, opportunity, type, stage, amount, probability, CAST(close_date AS STRING) AS close_date, risk_band
FROM opps WHERE NOT is_closed AND close_date <= date_add(asof_d, 90)
ORDER BY amount DESC LIMIT 25""", PIPE_RULES),
}

pipe_body = """<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">Pipeline Health</h1>
    <p class="rr-lede" id="takeaway"><b data-draw="num" data-source="pipe_summary" data-field="open_amount" data-row="0" data-fmt="money" class="dash-skeleton">—</b> is open in the pipeline, <b data-draw="num" data-source="pipe_summary" data-field="weighted_amount" data-row="0" data-fmt="money" class="dash-skeleton">—</b> weighted by stage. <b data-draw="num" data-source="pipe_summary" data-field="open_at_high_risk" data-row="0" data-fmt="money" class="dash-skeleton">—</b> of it sits with accounts whose renewal risk is High.</p>
    <p class="rr-meta">Data as of <span data-draw="num" data-source="pipe_summary" data-field="data_as_of" data-row="0" data-fmt="date">—</span> · trailing figures cover the 12 months before that date</p>
    <p class="rr-stale" id="stale" hidden>This snapshot is <span data-draw="num" data-source="pipe_summary" data-field="days_since_data" data-row="0" data-fmt="int">—</span> days old.</p>
  </header>
  <div class="rr-filters" id="filters">
    <label>Segment<select class="dash-select" id="f-segment" aria-label="Segment"><option value="">All segments</option><option value="Enterprise">Enterprise</option><option value="Mid-Market">Mid-Market</option><option value="SMB">SMB</option></select></label>
    <label>Region<select class="dash-select" id="f-region" aria-label="Region"><option value="">All regions</option><option value="US-East">US-East</option><option value="US-West">US-West</option><option value="EU">EU</option><option value="APAC">APAC</option></select></label>
    <label>Deal type<select class="dash-select" id="f-type" aria-label="Deal type"><option value="">All types</option><option value="New Customer">New Customer</option><option value="Existing Customer - Upgrade">Upgrade</option><option value="Renewal">Renewal</option></select></label>
  </div>
  <div class="rr-kpis" id="kpis">
    <div class="rr-card" id="kpi-open"><span class="rr-kpi-label">Open pipeline</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="pipe_summary" data-field="open_amount" data-row="0" data-fmt="money">—</span><span class="rr-kpi-note"><span data-draw="num" data-source="pipe_summary" data-field="open_deals" data-row="0" data-fmt="int">—</span> deals</span></div>
    <div class="rr-card" id="kpi-90"><span class="rr-kpi-label">Closing in 90 days</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="pipe_summary" data-field="closing_90d" data-row="0" data-fmt="money">—</span><span class="rr-kpi-note">from the snapshot date</span></div>
    <div class="rr-card" id="kpi-won"><span class="rr-kpi-label">Won, last 12 months</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="pipe_summary" data-field="won_12m" data-row="0" data-fmt="money">—</span><span class="rr-kpi-note">average deal <span data-draw="num" data-source="pipe_summary" data-field="avg_won_12m" data-row="0" data-fmt="money">—</span></span></div>
    <div class="rr-card" id="kpi-winrate"><span class="rr-kpi-label">Win rate, last 12 months</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="pipe_summary" data-field="win_rate_12m" data-row="0" data-fmt="pct">—</span><span class="rr-kpi-note">won as a share of closed deals</span></div>
    <div class="rr-card" id="kpi-reliability"><span class="rr-kpi-label">Lost to service reliability</span><span class="rr-kpi-value rr-bad dash-skeleton" data-draw="num" data-source="pipe_summary" data-field="lost_reliability_12m" data-row="0" data-fmt="money">—</span><span class="rr-kpi-note"><span data-draw="num" data-source="pipe_summary" data-field="lost_reliability_deals_12m" data-row="0" data-fmt="int">—</span> deals, last 12 months</span></div>
  </div>
  <div class="rr-grid2">
    <section class="rr-section" id="stages">
      <h2>Open pipeline by stage</h2>
      <p class="rr-sub">Full amount, with the probability-weighted amount after it.</p>
      <div class="rr-bars dash-skeleton" data-draw="stagebars" data-source="pipe_stage"></div>
    </section>
    <section class="rr-section" id="losses">
      <h2>Why deals were lost, last 12 months</h2>
      <p class="rr-sub">Amount lost by the reason recorded on the deal.</p>
      <div class="rr-bars dash-skeleton" data-draw="lossbars" data-source="loss_reasons"></div>
    </section>
  </div>
  <section class="rr-section" id="quarters">
    <h2>Won, lost and open by quarter</h2>
    <p class="rr-sub">By close quarter. Past quarters show what closed. Later quarters show what is still open.</p>
    <ul class="rr-legend" aria-hidden="true">
      <li><span class="rr-sw" style="background: var(--color-ok)"></span>Won</li>
      <li><span class="rr-sw" style="background: var(--cds-chart-muted)"></span>Lost</li>
      <li><span class="rr-sw rr-sw-open"></span>Open</li>
    </ul>
    <div class="rr-chart dash-skeleton" data-draw="quarterbars" data-source="pipe_quarters"></div>
  </section>
  <section class="rr-section" id="types">
    <h2>Win rate by deal type, last 12 months</h2>
    <div class="rr-tablewrap"><table class="rr-table" data-source="win_by_type" data-row-key="type">
      <thead><tr><th data-field="type">Deal type</th><th data-field="closed_deals" class="num">Closed</th><th data-field="won_deals" class="num">Won</th><th data-field="win_rate" class="num">Win rate</th><th data-field="avg_won" class="num">Average won</th></tr></thead>
      <tbody data-draw="typerows"></tbody></table></div>
  </section>
  <section class="rr-section" id="deals">
    <h2>Biggest deals closing in the next 90 days</h2>
    <p class="rr-sub">Deals at accounts with a High renewal risk are flagged. Those customers are unhappy, which can stall a deal.</p>
    <div class="rr-tablewrap"><table class="rr-table" data-source="top_open" data-row-key="opp_id">
      <thead><tr><th data-field="account">Account</th><th data-field="opportunity">Opportunity</th><th data-field="type">Type</th><th data-field="stage">Stage</th><th data-field="amount" class="num">Amount</th><th data-field="close_date">Close date</th><th data-field="risk_band">Account risk</th></tr></thead>
      <tbody data-draw="dealrows"></tbody></table></div>
    <p class="rr-msg" data-draw="dealmsg"></p>
  </section>
  <details class="rr-notes" id="method">
    <summary>How these numbers work</summary>
    <ul>
      <li>All figures come from the opportunity and account data in Databricks (workspace.salesforce_synth). Windows count from the latest case in the data, not from today.</li>
      <li>Weighted pipeline multiplies each open deal by its stage probability: Prospecting 10%, Qualification 25%, Proposal 50%, Negotiation 75%.</li>
      <li>Win rate counts deals, not dollars: won deals divided by all deals closed in the last 12 months.</li>
      <li>Account risk is the renewal risk band from the Renewal Risk Radar, based on the account's support cases in the last 90 days.</li>
    </ul>
  </details>
</div>
<style>.rr-sw-open { background: var(--rr-open); } .rr { --rr-open: var(--color-fg-muted); }</style>"""

pipe_js = """<script>window.rr.summaryId = 'pipe_summary';</script>""" + FILTER_JS + """<script>
dash.draw('stagebars', (el) => {
  const s = dash.data('pipe_stage');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.stage, value: (d) => Number(d.amount), right: 130,
    valueText: (d) => `${window.rr.money(d.amount)} · ${window.rr.money(d.weighted)} wtd`, aria: 'Open pipeline by stage', empty: 'No open deals match these filters.' });
});
dash.draw('lossbars', (el) => {
  const s = dash.data('loss_reasons');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.loss_reason, value: (d) => Number(d.amount), right: 110,
    color: (d) => (d.loss_reason === 'Service Reliability' ? 'var(--color-bad)' : dash.colors[0]),
    valueText: (d) => `${window.rr.money(d.amount)} · ${window.rr.int(d.deals)}`, aria: 'Lost amount by loss reason', empty: 'No lost deals match these filters.' });
});
dash.draw('quarterbars', (el) => {
  const s = dash.data('pipe_quarters');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  const keys = ['won', 'lost', 'open'];
  const rows = s.data.map((d) => ({ quarter: d.quarter, won: Number(d.won), lost: Number(d.lost), open: Number(d.open), open_weighted: Number(d.open_weighted) }));
  if (!rows.length) { const p = document.createElement('p'); p.className = 'rr-msg'; p.textContent = 'No deals match these filters.'; el.append(p); return; }
  const W = Math.max(280, el.clientWidth), H = 300, m = { t: 12, r: 12, b: 32, l: 52 };
  const x = d3.scaleBand().domain(rows.map((d) => d.quarter)).range([m.l, W - m.r]).padding(0.3);
  const stack = d3.stack().keys(keys)(rows);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.won + d.lost + d.open) || 1]).nice().range([H - m.b, m.t]);
  const color = { won: 'var(--color-ok)', lost: 'var(--cds-chart-muted)', open: 'var(--color-fg-muted)' };
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', 'Won, lost and open amount by close quarter');
  svg.append('g').attr('class', 'rr-grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((q) => (W < 480 ? q.replace(/^20/, '') : q)).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((v) => window.rr.money(v)).tickSizeOuter(0));
  svg.append('g').selectAll('g').data(stack).join('g').style('fill', (d) => color[d.key]).style('fill-opacity', (d) => (d.key === 'open' ? 0.45 : 1))
    .selectAll('rect').data((d) => d).join('rect').attr('x', (d) => x(d.data.quarter)).attr('width', x.bandwidth())
    .attr('y', (d) => y(d[1])).attr('height', (d) => Math.max(0, y(d[0]) - y(d[1])));
  const tip = d3.select(el).append('div').attr('class', 'rr-tip').style('display', 'none');
  svg.append('g').selectAll('rect').data(rows).join('rect').attr('x', (d) => x(d.quarter)).attr('width', x.bandwidth()).attr('y', m.t).attr('height', H - m.b - m.t).style('fill', 'transparent')
    .on('pointerenter pointermove', (event, d) => {
      const [px, py] = d3.pointer(event, el);
      tip.style('display', 'block').html('');
      tip.append('strong').text(d.quarter);
      tip.append('span').text(`Won ${window.rr.money(d.won)} · Lost ${window.rr.money(d.lost)}`);
      tip.append('span').text(`Open ${window.rr.money(d.open)} (${window.rr.money(d.open_weighted)} weighted)`);
      tip.style('left', Math.min(Math.max(0, px + 12), el.clientWidth - 230) + 'px').style('top', Math.max(0, py - 60) + 'px');
    }).on('pointerleave', () => tip.style('display', 'none'));
});
dash.draw('typerows', (el) => window.rr.tbody(el, 'win_by_type', 'type', [
  { f: 'type' }, { f: 'closed_deals', fmt: 'int', num: true }, { f: 'won_deals', fmt: 'int', num: true }, { f: 'win_rate', fmt: 'pct', num: true }, { f: 'avg_won', fmt: 'money', num: true }]));
dash.draw('dealrows', (el) => window.rr.tbody(el, 'top_open', 'opp_id', [
  { f: 'account' }, { f: 'opportunity' }, { f: 'type' }, { f: 'stage' }, { f: 'amount', fmt: 'money', num: true }, { f: 'close_date', fmt: 'date' },
  { f: 'risk_band', render: (td, d) => { if (d.risk_band === 'Not scored') { td.textContent = 'Not scored'; td.className = 'rr-muted'; } else window.rr.pill(td, d.risk_band); } }]));
dash.draw('dealmsg', (el) => window.rr.msg(el, 'top_open', 'No open deals close in the next 90 days for these filters.'));
</script>"""

write("pipeline", "https://claude.ai/artifact/XTcXboGewENJooF3DThh6r", {"title": "Pipeline Health"},
      {"segment": "", "region": "", "opp_type": ""}, pipe, page(pipe_body, pipe_js, list(pipe)))
