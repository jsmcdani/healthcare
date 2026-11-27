import os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "build_trifecta.py")).read()
exec(src[: src.index("def sqlds(")])   # brings in build.py + build_crm helpers + table_loader()

SEV_RULE = {"enum": ["", "Sev1", "Sev2", "Sev3", "Sev4"]}
WIN_RULE = {"enum": [90, 180, 365]}
RULES = {"severity": SEV_RULE, "region": REG_RULE, "window_days": WIN_RULE}

INC = f"""WITH {ASOF},
inc AS (
  SELECT i.Id, i.Name AS incident, i.Severity__c AS severity, i.Type__c AS type, i.Component__c AS component,
    i.Affected_Region__c AS region, i.Start_Time__c AS start_ts, i.End_Time__c AS end_ts, i.Root_Cause__c AS root_cause,
    round((unix_timestamp(i.End_Time__c) - unix_timestamp(i.Start_Time__c)) / 3600, 2) AS duration_hours,
    i.Root_Cause__c RLIKE '(?i)config|deploy' AS change_related
  FROM {T}.incident__c i CROSS JOIN asof
  WHERE CAST(i.Start_Time__c AS DATE) > date_sub(asof.d, {{{{window_days}}}})
    AND ('{{{{severity}}}}' = '' OR i.Severity__c = '{{{{severity}}}}')
    AND ('{{{{region}}}}' = '' OR i.Affected_Region__c = '{{{{region}}}}')),
links AS (SELECT DISTINCT cs.Incident__c AS Id, cs.AccountId FROM {T}.`case` cs JOIN inc ON inc.Id = cs.Incident__c),
impact AS (
  SELECT cs.Incident__c AS Id, count(*) AS cases, count(DISTINCT cs.AccountId) AS accounts, count_if(cs.SLA_Breached__c) AS sla_breaches
  FROM {T}.`case` cs JOIN inc ON inc.Id = cs.Incident__c GROUP BY 1),
arr AS (SELECT l.Id, sum(CAST(a.ARR__c AS DOUBLE)) AS arr FROM links l JOIN {T}.account a ON a.Id = l.AccountId GROUP BY 1)"""

ds_ = {
 "summary": ds("Incident totals", "Incidents, high-severity count, mean time to resolve, outage hours, customer impact and change-induced share for the incidents in view.", INC + f"""
SELECT count(*) AS incidents, count_if(severity IN ('Sev1','Sev2')) AS sev1_2, count_if(severity = 'Sev1') AS sev1,
  round(avg(duration_hours), 1) AS mttr_hours, round(sum(duration_hours), 1) AS outage_hours,
  coalesce(sum(im.cases), 0) AS customer_cases, coalesce(sum(im.sla_breaches), 0) AS case_sla_breaches,
  (SELECT count(DISTINCT AccountId) FROM links) AS accounts_affected,
  (SELECT coalesce(sum(CAST(a.ARR__c AS DOUBLE)), 0) FROM (SELECT DISTINCT AccountId FROM links) l JOIN {T}.account a ON a.Id = l.AccountId) AS arr_affected,
  count_if(change_related) AS change_induced, round(count_if(change_related) / nullif(count(*), 0), 3) AS change_induced_share,
  (SELECT CAST(d AS STRING) FROM asof) AS data_as_of
FROM inc LEFT JOIN impact im ON im.Id = inc.Id""", RULES),
 "monthly": ds("Incidents by month and severity", "Incident count per start month, split by severity.", INC + """
SELECT date_format(start_ts, 'yyyy-MM') AS month, count_if(severity = 'Sev1') AS sev1, count_if(severity = 'Sev2') AS sev2,
  count_if(severity = 'Sev3') AS sev3, count_if(severity = 'Sev4') AS sev4, count(*) AS total
FROM inc GROUP BY 1 ORDER BY 1""", RULES),
 "mttr": ds("Time to resolve by severity", "Incidents, average and longest duration in hours, per severity.", INC + """
SELECT severity, count(*) AS incidents, round(avg(duration_hours), 1) AS mttr_hours, round(max(duration_hours), 1) AS longest_hours
FROM inc GROUP BY 1 ORDER BY 1""", RULES),
 "components": ds("Incidents by component", "Incidents, outage hours and change-induced incidents per component.", INC + """
SELECT component, count(*) AS incidents, round(sum(duration_hours), 1) AS outage_hours, count_if(change_related) AS change_induced
FROM inc GROUP BY 1 ORDER BY incidents DESC""", RULES),
 "causes": ds("Root causes", "Incidents per root cause, and whether the cause is a change (configuration push or deployment).", INC + """
SELECT root_cause, count(*) AS incidents, max(change_related) AS change_related, round(sum(duration_hours), 1) AS outage_hours
FROM inc GROUP BY 1 ORDER BY incidents DESC""", RULES),
 "incidents": ds("Incident list", "Every incident in view with duration, root cause and customer impact.", INC + """
SELECT inc.incident, inc.severity, inc.type, inc.component, inc.region, CAST(inc.start_ts AS STRING) AS started,
  inc.duration_hours, inc.root_cause, inc.change_related, coalesce(im.cases, 0) AS cases, coalesce(im.accounts, 0) AS accounts,
  coalesce(arr.arr, 0) AS arr_affected
FROM inc LEFT JOIN impact im ON im.Id = inc.Id LEFT JOIN arr ON arr.Id = inc.Id
ORDER BY CASE inc.severity WHEN 'Sev1' THEN 1 WHEN 'Sev2' THEN 2 WHEN 'Sev3' THEN 3 ELSE 4 END, inc.start_ts DESC""", RULES),
 "case_sla": ds("Support cases by priority", "Support cases in the window by priority: SLA target, breach rate, average resolution hours and still open.", f"""
WITH {ASOF}
SELECT cs.Priority AS priority, CASE cs.Priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END AS sort,
  count(*) AS cases, max(cs.SLA_Target_Hours__c) AS sla_target_hours, round(count_if(cs.SLA_Breached__c) / count(*), 3) AS breach_rate,
  round(avg(cs.Resolution_Hours__c), 1) AS avg_resolution_hours, count_if(NOT cs.IsClosed) AS still_open
FROM {T}.`case` cs CROSS JOIN asof JOIN {T}.account a ON a.Id = cs.AccountId
WHERE CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, {{{{window_days}}}}) AND ('{{{{region}}}}' = '' OR a.Hosting_Region__c = '{{{{region}}}}')
GROUP BY 1, 2 ORDER BY sort""", RULES),
 "sn_live": {"title": "ServiceNow: all incidents (live)", "description": "Asks the Trifecta gateway for all ServiceNow incidents, run as the viewer. Empty until the ServiceNow trial returns incidents for this user.",
             "source": {"kind": "call", "connector": "Local Trifecta", "tool": "ask", "args": {"query": "all incidents"}}},
}

FILTERS = """<div class="rr-filters" id="filters">
    <label>Severity<select class="dash-select" id="f-sev" aria-label="Severity"><option value="">All severities</option><option value="Sev1">Sev1</option><option value="Sev2">Sev2</option><option value="Sev3">Sev3</option><option value="Sev4">Sev4</option></select></label>
    <label>Region<select class="dash-select" id="f-region" aria-label="Region"><option value="">All regions</option><option value="US-East">US-East</option><option value="US-West">US-West</option><option value="EU">EU</option><option value="APAC">APAC</option></select></label>
    <label>Window<select class="dash-select" id="f-win" aria-label="Time window"><option value="90">Last 90 days</option><option value="180">Last 180 days</option><option value="365">Last 12 months</option></select></label>
  </div>"""

def kpi(id_, label, field, fmt, note, cls=""):
    return f"""<div class="rr-card" id="{id_}"><span class="rr-kpi-label">{label}</span><span class="rr-kpi-value {cls} dash-skeleton" data-draw="num" data-source="summary" data-field="{field}" data-row="0" data-fmt="{fmt}">—</span><span class="rr-kpi-note">{note}</span></div>"""

body = f"""<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">Incident Management</h1>
    <p class="rr-lede" id="takeaway"><b data-draw="num" data-source="summary" data-field="incidents" data-row="0" data-fmt="int" class="dash-skeleton">—</b> incidents in view, <b data-draw="num" data-source="summary" data-field="sev1_2" data-row="0" data-fmt="int" class="dash-skeleton">—</b> of them Sev1 or Sev2. <b data-draw="num" data-source="summary" data-field="change_induced" data-row="0" data-fmt="int" class="dash-skeleton">—</b> were caused by a change: a configuration push or a deployment.</p>
    <p class="rr-meta">Data as of <span data-draw="num" data-source="summary" data-field="data_as_of" data-row="0" data-fmt="date">—</span> · windows count back from that date</p>
    <p class="rr-gov" data-draw="snstatus" data-source="sn_live">—</p>
  </header>
  {FILTERS}
  <div class="rr-kpis" id="kpis">
    {kpi("kpi-inc", "Incidents", "incidents", "int", "in the selected window")}
    {kpi("kpi-sev", "Sev1 and Sev2", "sev1_2", "int", "high-severity incidents", "rr-bad")}
    {kpi("kpi-mttr", "Mean time to resolve", "mttr_hours", "num1", "hours, start to end")}
    {kpi("kpi-outage", "Outage hours", "outage_hours", "num1", "total incident duration")}
    {kpi("kpi-change", "Change-induced", "change_induced_share", "pct", "caused by a config push or deployment", "rr-warn")}
    {kpi("kpi-arr", "ARR affected", "arr_affected", "money", '<span data-draw="num" data-source="summary" data-field="accounts_affected" data-row="0" data-fmt="int">—</span> accounts · <span data-draw="num" data-source="summary" data-field="customer_cases" data-row="0" data-fmt="int">—</span> customer cases')}
  </div>

  <section class="rr-section" id="sn-live" hidden>
    <h2>Live from ServiceNow <span class="rr-pill rr-pill-Good">Live</span></h2>
    <div class="rr-tablewrap"><table class="rr-table" data-source="sn_live"><thead><tr data-draw="snhead"></tr></thead><tbody data-draw="snrows"></tbody></table></div>
  </section>

  <section class="rr-section" id="trend">
    <h2>Incidents by month</h2>
    <ul class="rr-legend" aria-hidden="true">
      <li><span class="rr-sw" style="background: var(--color-bad)"></span>Sev1</li>
      <li><span class="rr-sw" style="background: var(--color-warn)"></span>Sev2</li>
      <li><span class="rr-sw" style="background: var(--color-fg-muted)"></span>Sev3</li>
      <li><span class="rr-sw" style="background: var(--cds-chart-muted)"></span>Sev4</li>
    </ul>
    <div class="rr-chart dash-skeleton" data-draw="monthly" data-source="monthly"></div>
  </section>

  <div class="rr-grid2">
    <section class="rr-section" id="mttr">
      <h2>Time to resolve by severity</h2>
      <p class="rr-sub">Average hours from start to end. The longest is shown after it.</p>
      <div class="rr-bars dash-skeleton" data-draw="mttrbars" data-source="mttr"></div>
    </section>
    <section class="rr-section" id="causes">
      <h2>Root causes</h2>
      <p class="rr-sub">Amber marks causes that came from a change. Better change control would prevent these.</p>
      <div class="rr-bars dash-skeleton" data-draw="causebars" data-source="causes"></div>
    </section>
  </div>

  <section class="rr-section" id="components">
    <h2>Where incidents happen</h2>
    <p class="rr-sub">Incidents per component, with total outage hours.</p>
    <div class="rr-bars dash-skeleton" data-draw="compbars" data-source="components"></div>
  </section>

  <section class="rr-section" id="list">
    <h2>Incident log</h2>
    <div class="rr-tablewrap"><table class="rr-table" data-source="incidents" data-row-key="incident">
      <thead><tr><th data-field="incident">Incident</th><th data-field="severity">Severity</th><th data-field="component">Component</th><th data-field="region">Region</th><th data-field="started">Started</th><th data-field="duration_hours" class="num">Hours</th><th data-field="root_cause">Root cause</th><th data-field="accounts" class="num">Accounts hit</th><th data-field="arr_affected" class="num">ARR affected</th></tr></thead>
      <tbody data-draw="incrows"></tbody></table></div>
    <p class="rr-msg" data-draw="incmsg"></p>
  </section>

  <section class="rr-section" id="sla">
    <h2>Support cases against SLA</h2>
    <p class="rr-sub">All customer support cases in the window, by priority.</p>
    <div class="rr-tablewrap"><table class="rr-table" data-source="case_sla" data-row-key="priority">
      <thead><tr><th data-field="priority">Priority</th><th data-field="cases" class="num">Cases</th><th data-field="sla_target_hours" class="num">SLA target, hours</th><th data-field="breach_rate" class="num">Breached SLA</th><th data-field="avg_resolution_hours" class="num">Avg hours to resolve</th><th data-field="still_open" class="num">Still open</th></tr></thead>
      <tbody data-draw="slarows"></tbody></table></div>
  </section>

  <details class="rr-notes" id="method">
    <summary>How these numbers work</summary>
    <ul>
      <li>Sample data: incidents and support cases from the Databricks trial (workspace.salesforce_synth), shaped like ServiceNow incident records. They are not ServiceNow records.</li>
      <li>The page also asks the Trifecta gateway for live ServiceNow incidents. When ServiceNow returns rows for you, a live table appears near the top.</li>
      <li>Mean time to resolve is the average of end time minus start time. Change-induced means the root cause names a configuration push or a deployment.</li>
      <li>ARR affected adds up the ARR of each distinct account with at least one support case linked to an incident in view.</li>
      <li>Windows count back from the latest case in the data, not from today.</li>
    </ul>
  </details>
</div>"""

js = """<script>
const fSev = document.querySelectorAll('#f-sev'), fReg = document.querySelectorAll('#f-region'), fWin = document.querySelectorAll('#f-win');
fSev.forEach((el) => el.addEventListener('change', () => dash.setParams({ severity: el.value })));
fReg.forEach((el) => el.addEventListener('change', () => dash.setParams({ region: el.value })));
fWin.forEach((el) => el.addEventListener('change', () => dash.setParams({ window_days: Number(el.value) })));
dash.onData(() => { const p = dash.params();
  fSev.forEach((el) => { if (document.activeElement !== el) el.value = p.severity ?? ''; });
  fReg.forEach((el) => { if (document.activeElement !== el) el.value = p.region ?? ''; });
  fWin.forEach((el) => { if (document.activeElement !== el) el.value = String(p.window_days ?? 365); });
  const sn = dash.data('sn_live'); document.querySelectorAll('#sn-live').forEach((e) => { e.hidden = !(sn.status === 'ok' && sn.data.length); }); });
const SEV = { Sev1: 'var(--color-bad)', Sev2: 'var(--color-warn)', Sev3: 'var(--color-fg-muted)', Sev4: 'var(--cds-chart-muted)' };
dash.draw('snstatus', (el) => { const s = dash.data('sn_live'); const said = ((s.meta || []).find((m) => m.label === 'Agent said') || {}).value || '';
  el.textContent = s.status === 'loading' ? 'Checking ServiceNow through Trifecta…'
    : s.status === 'ok' && s.data.length ? `Live ServiceNow incidents found: ${s.data.length}. They are shown in their own table below; the charts use the sample data.`
    : s.status === 'ok' ? `Sample data from the Databricks trial, shaped like ServiceNow. ServiceNow itself, asked through Trifecta, said: "${said}"`
    : 'Sample data from the Databricks trial, shaped like ServiceNow. The live ServiceNow check is waiting for the Trifecta connection.'; });
dash.draw('monthly', (el) => {
  const s = dash.data('monthly'); if (s.status === 'loading') return; if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton'); el.replaceChildren();
  const keys = ['sev1', 'sev2', 'sev3', 'sev4'], col = { sev1: SEV.Sev1, sev2: SEV.Sev2, sev3: SEV.Sev3, sev4: SEV.Sev4 };
  const rows = s.data.map((d) => ({ month: d.month, sev1: +d.sev1, sev2: +d.sev2, sev3: +d.sev3, sev4: +d.sev4 }));
  if (!rows.length) { const p = document.createElement('p'); p.className = 'rr-msg'; p.textContent = 'No incidents match these filters.'; el.append(p); return; }
  const W = Math.max(280, el.clientWidth), H = 280, m = { t: 10, r: 10, b: 32, l: 28 };
  const x = d3.scaleBand().domain(rows.map((d) => d.month)).range([m.l, W - m.r]).padding(0.25);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.sev1 + d.sev2 + d.sev3 + d.sev4) || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', 'Incidents per month by severity');
  svg.append('g').attr('class', 'rr-grid').selectAll('line').data(y.ticks(4)).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  const fmtM = (k) => d3.utcFormat(W < 520 ? '%b' : '%b %y')(new Date(k + '-01T00:00:00Z'));
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(x.domain().filter((d, i) => W >= 520 || i % 2 === 0)).tickFormat(fmtM).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('d')).tickSizeOuter(0));
  svg.append('g').selectAll('g').data(d3.stack().keys(keys)(rows)).join('g').style('fill', (d) => col[d.key])
    .selectAll('rect').data((d) => d).join('rect').attr('x', (d) => x(d.data.month)).attr('width', x.bandwidth()).attr('y', (d) => y(d[1])).attr('height', (d) => Math.max(0, y(d[0]) - y(d[1])));
  const tip = d3.select(el).append('div').attr('class', 'rr-tip').style('display', 'none');
  svg.append('g').selectAll('rect').data(rows).join('rect').attr('x', (d) => x(d.month)).attr('width', x.bandwidth()).attr('y', m.t).attr('height', H - m.b - m.t).style('fill', 'transparent')
    .on('pointerenter pointermove', (event, d) => { const [px, py] = d3.pointer(event, el); tip.style('display', 'block').html('');
      tip.append('strong').text(fmtM(d.month)); tip.append('span').text(`Sev1 ${d.sev1} · Sev2 ${d.sev2} · Sev3 ${d.sev3} · Sev4 ${d.sev4}`);
      tip.style('left', Math.min(Math.max(0, px + 12), el.clientWidth - 220) + 'px').style('top', Math.max(0, py - 50) + 'px'); })
    .on('pointerleave', () => tip.style('display', 'none'));
});
dash.draw('mttrbars', (el) => { const s = dash.data('mttr'); if (s.status === 'loading') return; if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.severity, value: (d) => +d.mttr_hours, right: 140, color: (d) => SEV[d.severity] || dash.colors[0],
    valueText: (d) => `${(+d.mttr_hours).toFixed(1)} h avg · longest ${(+d.longest_hours).toFixed(1)} h`, aria: 'Mean time to resolve by severity', empty: 'No incidents match these filters.' }); });
dash.draw('causebars', (el) => { const s = dash.data('causes'); if (s.status === 'loading') return; if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => (d.root_cause.length > 30 ? d.root_cause.slice(0, 29) + '…' : d.root_cause), value: (d) => +d.incidents, right: 90,
    color: (d) => (d.change_related === true || d.change_related === 'true' ? 'var(--color-warn)' : dash.colors[0]),
    valueText: (d) => `${d.incidents} · ${(+d.outage_hours).toFixed(0)} h`, aria: 'Incidents by root cause', empty: 'No incidents match these filters.' }); });
dash.draw('compbars', (el) => { const s = dash.data('components'); if (s.status === 'loading') return; if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.component, value: (d) => +d.incidents, right: 160,
    valueText: (d) => `${d.incidents} incidents · ${(+d.outage_hours).toFixed(0)} outage h`, aria: 'Incidents by component', empty: 'No incidents match these filters.' }); });
dash.draw('incrows', (el) => window.rr.tbody(el, 'incidents', 'incident', [
  { f: 'incident' }, { f: 'severity', render: (td, d) => { const p = document.createElement('span'); p.className = 'rr-pill'; p.style.marginLeft = '0'; p.style.color = SEV[d.severity]; p.textContent = d.severity; td.append(p); } },
  { f: 'component' }, { f: 'region' }, { f: 'started', fmt: 'date' }, { f: 'duration_hours', fmt: 'num1', num: true },
  { f: 'root_cause', render: (td, d) => { td.textContent = d.root_cause; if (d.change_related === true || d.change_related === 'true') { const p = document.createElement('span'); p.className = 'rr-pill rr-pill-Elevated'; p.textContent = 'Change'; td.append(p); } } },
  { f: 'accounts', fmt: 'int', num: true }, { f: 'arr_affected', fmt: 'money', num: true }]));
dash.draw('incmsg', (el) => window.rr.msg(el, 'incidents', 'No incidents match these filters.'));
dash.draw('slarows', (el) => window.rr.tbody(el, 'case_sla', 'priority', [
  { f: 'priority' }, { f: 'cases', fmt: 'int', num: true }, { f: 'sla_target_hours', fmt: 'int', num: true }, { f: 'breach_rate', fmt: 'pct', num: true },
  { f: 'avg_resolution_hours', fmt: 'num1', num: true }, { f: 'still_open', fmt: 'int', num: true }]));
const genericHead = (el, id) => { const s = dash.data(id); el.replaceChildren(); (s.columns || []).filter((c) => c !== 'url').forEach((c) => { const th = document.createElement('th'); th.dataset.field = c; th.textContent = c.replace(/_/g, ' '); el.append(th); }); };
dash.draw('snhead', (el) => genericHead(el, 'sn_live'));
dash.draw('snrows', (el) => { const s = dash.data('sn_live'); el.replaceChildren(); if (s.status !== 'ok') return;
  s.data.slice(0, 50).forEach((d) => { const tr = document.createElement('tr'); (s.columns || []).filter((c) => c !== 'url').forEach((c) => { const td = document.createElement('td'); td.textContent = d[c] == null ? '—' : String(d[c]); tr.append(td); }); el.append(tr); }); });
</script>"""

dbx_ids = [k for k in ds_ if k != "sn_live"]
html = page(body, "<script>\n" + table_loader("sn_live", "ServiceNow incidents") + "\n</script>\n" + js, dbx_ids)
write("itsm", "https://claude.ai/artifact/4R3dgA9ndSksVwgebZGBZ4", {"title": "Incident Management"}, {"severity": "", "region": "", "window_days": 365}, ds_, html)
