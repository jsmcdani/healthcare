import os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "build_crm.py")).read()
# reuse everything from build_crm up to its first dashboard definition
exec(src[: src.index("# ---------------------------------------------------------------- CRM Top Accounts")])

TRI = "Local Trifecta"
def tri(title, desc, query):
    return {"title": title, "description": desc, "source": {"kind": "call", "connector": TRI, "tool": "ask", "args": {"query": query}}}

# Trifecta returns a structured `table` {columns:[{key,label,type}], rows:[[...]], ids:[...], source, truncated}. No Markdown parsing needed.
def table_loader(id_, what):
    return """dash.loader('""" + id_ + """', { description: 'Reads the structured table in the Trifecta card (""" + what + """). Record paths become Salesforce links. An empty table means the routed system returned nothing for this viewer.', fn: ({ answer }) => {
    const card = typeof answer === 'string' ? JSON.parse(answer) : answer;
    if (!card) throw new Error('Trifecta returned nothing.');
    if (card.error) throw new Error(typeof card.error === 'string' ? card.error : (card.error.message || 'Trifecta reported an error.'));
    const said = String(card.answer || '').split('\\n').map((l) => l.trim()).find((l) => l && !/^_/.test(l)) || '';
    const meta = [{ label: 'Asked', value: String(card.ask || '') }, { label: 'Answered by', value: String(card.title || '') },
      { label: 'Routed to', value: (card.routed || []).join(', ') || 'none' }, { label: 'Agent said', value: said.replace(/\\*\\*/g, '') },
      { label: 'Runs as', value: String(card.runs_as || '') + ' (' + String(card.persona || '') + ')' }];
    const t = card.table;
    if (!t || !Array.isArray(t.rows)) return { data: [], columns: [], truncated: false, meta };
    const base = /^https:\\/\\//.test(card.instance_url || '') ? card.instance_url.replace(/\\/$/, '') : '';
    const keys = t.columns.map((c) => c.key);
    const data = t.rows.map((r, i) => { const o = {}; keys.forEach((k, j) => { o[k] = r[j]; });
      const p = t.ids && t.ids[i]; o.url = p && base && String(p).startsWith('/') ? base + p : null; return o; });
    return { data, columns: keys.concat(['url']), truncated: !!t.truncated, meta };
  } });"""

def sqlds(title, desc, sql):
    return {"title": title, "description": desc, "langs": {"query": "sql"}, "source": {"kind": "call", "connector": CONNECTOR, "tool": TOOL, "args": {"query": sql.strip()}}}

ds_ = {
 "crm": tri("CRM: top accounts (live)", "Trifecta routes this to Salesforce: top 10 accounts by average commissionable revenue.", "top 10 accounts by revenue"),
 "itsm": tri("ServiceNow: open incidents (live)", "Trifecta routes this to ServiceNow ITSM: the viewer's open incidents.", "my open incidents"),
 "wh": tri("Warehouse: total ARR (live)", "Trifecta routes this to the Databricks warehouse: total ARR.", "total ARR"),
 "si_incidents": sqlds("Stand-in: incidents (Databricks trial)", "Trial incident data in Databricks, standing in until ServiceNow answers through Trifecta. Not the same records as ServiceNow.", f"""
SELECT i.Name AS incident, i.Severity__c AS severity, i.Type__c AS type, i.Component__c AS component, i.Affected_Region__c AS region,
  CAST(CAST(i.Start_Time__c AS DATE) AS STRING) AS started, count(DISTINCT cs.AccountId) AS accounts_hit, count(cs.Id) AS cases
FROM {T}.incident__c i LEFT JOIN {T}.`case` cs ON cs.Incident__c = i.Id
GROUP BY ALL ORDER BY accounts_hit DESC, started DESC LIMIT 15"""),
 "si_arr": sqlds("Stand-in: ARR by segment (Databricks trial)", "Trial account data in Databricks, standing in until the warehouse answers through Trifecta. Not the same accounts as the CRM.", f"""
SELECT a.Customer_Segment__c AS segment, count(*) AS accounts, sum(CAST(a.ARR__c AS DOUBLE)) AS arr
FROM {T}.account a GROUP BY 1 ORDER BY arr DESC"""),
}

CALC = """dash.calc('join_check', { inputs: ['crm', 'itsm', 'wh'], title: 'Cross-system match check', description: 'For each CRM top account, how many live ServiceNow and warehouse rows mention the same account name. It shows whether the systems can be joined yet; it is not a reconciliation.',
  fn: (crm, itsm, wh) => { const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hits = (rows, name) => rows.filter((r) => Object.values(r).some((v) => typeof v === 'string' && norm(v).includes(name))).length;
    return crm.map((c) => { const n = norm(c.account); return { account: c.account, itsm_rows: itsm.length, itsm_matches: hits(itsm, n), wh_rows: wh.length, wh_matches: hits(wh, n) }; }); } });"""

body = """<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">Trifecta Command Center</h1>
    <p class="rr-lede" id="takeaway">One page across Salesforce, ServiceNow and the Databricks warehouse, all asked through the Trifecta gateway. This is a prototype: a panel whose system has no data yet shows a labeled stand-in from the Databricks trial.</p>
    <p class="rr-gov">Every live panel runs as the person viewing it. The three systems hold different data sets, so nothing on this page is joined or reconciled across them.</p>
  </header>

  <section class="rr-section" id="status">
    <h2>System status</h2>
    <div class="rr-kpis">
      <div class="rr-card" id="sys-crm"><span class="rr-kpi-label">Salesforce CRM</span><span class="rr-kpi-value" style="font-size: var(--cds-font-size-heading)" data-draw="sys" data-sys="crm" data-source="crm">—</span><span class="rr-kpi-note" data-draw="said" data-sys="crm">—</span></div>
      <div class="rr-card" id="sys-itsm"><span class="rr-kpi-label">ServiceNow ITSM</span><span class="rr-kpi-value" style="font-size: var(--cds-font-size-heading)" data-draw="sys" data-sys="itsm" data-source="itsm">—</span><span class="rr-kpi-note" data-draw="said" data-sys="itsm">—</span></div>
      <div class="rr-card" id="sys-wh"><span class="rr-kpi-label">Databricks warehouse</span><span class="rr-kpi-value" style="font-size: var(--cds-font-size-heading)" data-draw="sys" data-sys="wh" data-source="wh">—</span><span class="rr-kpi-note" data-draw="said" data-sys="wh">—</span></div>
    </div>
  </section>

  <section class="rr-section" id="crm-panel">
    <h2>Revenue: top accounts <span class="rr-pill rr-pill-Good">Live · Salesforce</span></h2>
    <p class="rr-sub">Average monthly commissionable revenue, last 90 days of collections. From the full sandbox org.</p>
    <div class="rr-grid2">
      <div class="rr-bars dash-skeleton" data-draw="crmbars" data-source="crm"></div>
      <div class="rr-tablewrap"><table class="rr-table" data-source="crm" data-row-key="account">
        <thead><tr><th data-field="account">Account</th><th data-field="avg_commissionable_revenue" class="num">Avg monthly</th><th data-field="commissionable_revenue" class="num">Last 90 days</th></tr></thead>
        <tbody data-draw="crmrows"></tbody></table></div>
    </div>
  </section>

  <div class="rr-grid2">
    <section class="rr-section" id="itsm-panel">
      <h2>Service: incidents</h2>
      <div id="itsm-live" hidden>
        <p class="rr-sub"><span class="rr-pill rr-pill-Good">Live · ServiceNow</span> Your open incidents.</p>
        <div class="rr-tablewrap"><table class="rr-table" data-source="itsm" data-row-key="number"><thead><tr data-draw="itsmhead"></tr></thead><tbody data-draw="itsmrows"></tbody></table></div>
      </div>
      <div id="itsm-standin">
        <p class="rr-sub"><span class="rr-pill rr-pill-Fair">Stand-in · Databricks trial</span> ServiceNow returned no incidents for you yet. These are trial incidents, not ServiceNow records.</p>
        <div class="rr-tablewrap"><table class="rr-table" data-source="si_incidents" data-row-key="incident">
          <thead><tr><th data-field="incident">Incident</th><th data-field="severity">Severity</th><th data-field="component">Component</th><th data-field="started">Started</th><th data-field="accounts_hit" class="num">Accounts hit</th></tr></thead>
          <tbody data-draw="sirows"></tbody></table></div>
      </div>
    </section>

    <section class="rr-section" id="wh-panel">
      <h2>Warehouse: ARR</h2>
      <div id="wh-live" hidden>
        <p class="rr-sub"><span class="rr-pill rr-pill-Good">Live · Databricks via Trifecta</span></p>
        <div class="rr-tablewrap"><table class="rr-table" data-source="wh"><thead><tr data-draw="whhead"></tr></thead><tbody data-draw="whrows"></tbody></table></div>
      </div>
      <div id="wh-standin">
        <p class="rr-sub"><span class="rr-pill rr-pill-Fair">Stand-in · Databricks trial</span> The warehouse returned no data through Trifecta yet. These are trial accounts, not CRM accounts.</p>
        <div class="rr-bars dash-skeleton" data-draw="arrbars" data-source="si_arr"></div>
      </div>
    </section>
  </div>

  <section class="rr-section" id="join">
    <h2>Can the systems be joined yet?</h2>
    <p class="rr-sub">For each top CRM account: how many live ServiceNow and warehouse rows mention it by name. Zero everywhere means the systems don't share accounts or keys yet. That's expected with trial data.</p>
    <div class="rr-tablewrap"><table class="rr-table" data-source="join_check" data-row-key="account">
      <thead><tr><th data-field="account">CRM account</th><th data-field="itsm_matches" class="num">ServiceNow matches</th><th data-field="wh_matches" class="num">Warehouse matches</th></tr></thead>
      <tbody data-draw="joinrows"></tbody></table></div>
  </section>

  <details class="rr-notes" id="method">
    <summary>How this prototype works</summary>
    <ul>
      <li>Three questions go to the Trifecta gateway's ask agent: "top 10 accounts by revenue" (routes to Salesforce), "my open incidents" (routes to ServiceNow) and "total ARR" (routes to the Databricks warehouse). Each answer carries a structured table, which the page reads directly.</li>
      <li>When a system returns no rows, its panel switches to a stand-in from the Databricks trial schema (workspace.salesforce_synth). Stand-ins are labeled and never mixed with live numbers.</li>
      <li>A real cross-system view needs a shared account key: the Salesforce Account Id carried into ServiceNow (for example on the company or customer record) and into the warehouse. Until then the match check stays at zero.</li>
    </ul>
  </details>
</div>"""

js = """<script>
const live = (id) => { const s = dash.data(id); return s.status === 'ok' && s.data.length > 0; };
dash.onData(() => {
  document.querySelectorAll('#itsm-live').forEach((e) => { e.hidden = !live('itsm'); });
  document.querySelectorAll('#itsm-standin').forEach((e) => { e.hidden = live('itsm'); });
  document.querySelectorAll('#wh-live').forEach((e) => { e.hidden = !live('wh'); });
  document.querySelectorAll('#wh-standin').forEach((e) => { e.hidden = live('wh'); });
});
const metaVal = (id, label) => { const s = dash.data(id); const m = (s.meta || []).find((x) => x.label === label); return m ? m.value : ''; };
dash.draw('sys', (el) => { const id = el.dataset.sys; const s = dash.data(id);
  el.textContent = s.status === 'loading' ? 'Asking…' : s.status === 'ok' ? (s.data.length ? `${s.data.length} rows, live` : 'No data yet') : s.status === 'error' ? 'Error' : 'Waiting for connection';
  el.style.color = s.status === 'ok' && s.data.length ? 'var(--color-ok)' : s.status === 'ok' ? 'var(--color-warn)' : ''; });
dash.draw('said', (el) => { const id = el.dataset.sys; const s = dash.data(id);
  el.textContent = s.status === 'ok' ? `Routed to ${metaVal(id, 'Routed to') || '—'}. ${s.data.length ? '' : metaVal(id, 'Agent said')}` : ''; });
dash.draw('crmbars', (el) => { const s = dash.data('crm'); if (s.status === 'loading') return; if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.account, value: (d) => Number(d.avg_commissionable_revenue), right: 70, valueText: (d) => window.rr.money(d.avg_commissionable_revenue),
    aria: 'Top CRM accounts by average monthly commissionable revenue', empty: 'Salesforce returned no accounts.' }); });
dash.draw('crmrows', (el) => window.rr.tbody(el, 'crm', 'account', [
  { f: 'account', render: (td, d) => { if (d.url && /^https:\\/\\//.test(d.url)) { const a = document.createElement('a'); a.href = d.url; a.target = '_blank'; a.rel = 'noopener'; a.className = 'rr-link'; a.textContent = d.account; td.append(a); } else td.textContent = d.account; } },
  { f: 'avg_commissionable_revenue', fmt: 'money', num: true }, { f: 'commissionable_revenue', fmt: 'money', num: true }]));
const genericHead = (el, id) => { const s = dash.data(id); el.replaceChildren(); (s.columns || []).filter((c) => c !== 'url').forEach((c) => { const th = document.createElement('th'); th.dataset.field = c; th.textContent = c.replace(/_/g, ' '); el.append(th); }); };
const genericRows = (el, id) => { const s = dash.data(id); el.replaceChildren(); if (s.status !== 'ok') return;
  s.data.slice(0, 25).forEach((d) => { const tr = document.createElement('tr'); (s.columns || []).filter((c) => c !== 'url').forEach((c) => { const td = document.createElement('td'); td.textContent = d[c] == null ? '—' : String(d[c]); tr.append(td); }); el.append(tr); }); };
dash.draw('itsmhead', (el) => genericHead(el, 'itsm'));
dash.draw('itsmrows', (el) => genericRows(el, 'itsm'));
dash.draw('whhead', (el) => genericHead(el, 'wh'));
dash.draw('whrows', (el) => genericRows(el, 'wh'));
dash.draw('sirows', (el) => window.rr.tbody(el, 'si_incidents', 'incident', [{ f: 'incident' }, { f: 'severity' }, { f: 'component' }, { f: 'started', fmt: 'date' }, { f: 'accounts_hit', fmt: 'int', num: true }]));
dash.draw('arrbars', (el) => { const s = dash.data('si_arr'); if (s.status === 'loading') return; if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data, { label: (d) => d.segment, value: (d) => Number(d.arr), right: 120, color: () => 'var(--cds-chart-muted)',
    valueText: (d) => `${window.rr.money(d.arr)} · ${window.rr.int(d.accounts)} accts`, aria: 'Stand-in ARR by segment from the Databricks trial' }); });
dash.draw('joinrows', (el) => window.rr.tbody(el, 'join_check', 'account', [{ f: 'account' }, { f: 'itsm_matches', fmt: 'int', num: true }, { f: 'wh_matches', fmt: 'int', num: true }]));
</script>"""

loaders = table_loader("crm", "Salesforce") + "\n" + table_loader("itsm", "ServiceNow") + "\n" + table_loader("wh", "warehouse") + "\n" + \
  "dash.loader('si_incidents', { description: 'Reads the Databricks SQL statement result as rows.', fn: ({ answer, read }) => read.databricks(answer) });\n" + \
  "dash.loader('si_arr', { description: 'Reads the Databricks SQL statement result as rows.', fn: ({ answer, read }) => read.databricks(answer) });\n" + CALC
html = crm_page(body, js, loaders)
write("trifecta", "https://claude.ai/artifact/ELxMoZA76SFCgTrrNQ6M1P", {"title": "Trifecta Command Center"}, None, ds_, html)
