"""Builds dataset + page JSON documents for Account 360, Expansion Radar and Pipeline Health."""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
T = "workspace.salesforce_synth"
CONNECTOR, TOOL = "Claude Databricks", "execute_sql"

CSS = open(os.path.join(HERE, "shared.css.html")).read()
JS = open(os.path.join(HERE, "shared.js.html")).read()
JS = JS[: JS.index("['radar'")] + "window.rr.pct = (v) => { const n = Number(v); return v == null || !isFinite(n) ? '—' : (n * 100).toFixed(1) + '%'; };\nwindow.rr.num1 = (v) => { const n = Number(v); return v == null || !isFinite(n) ? '—' : n.toFixed(1); };\nwindow.rr.text = (v) => (v == null || v === '' ? '—' : String(v));\n__LOADERS__\n</script>"

EXTRA_CSS = """<style>
.rr-twocol { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--cds-gap-lg); }
.rr-facts { display: flex; flex-wrap: wrap; gap: var(--cds-gap-sm) var(--cds-gap-lg); color: var(--color-fg-muted); font-size: var(--cds-font-size-caption); margin: 0; }
.rr-search { display: flex; flex-direction: column; gap: var(--cds-gap-xs); font-size: var(--cds-font-size-caption); color: var(--color-fg-muted); max-width: 420px; }
.rr-search input { font: inherit; font-size: var(--cds-font-size-body); color: var(--color-fg); background: var(--color-bg); border: 1px solid var(--color-border-line); border-radius: var(--cds-radius); padding: var(--cds-pad-sm) var(--cds-pad-md); }
.rr-cmp { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.rr-cmp th, .rr-cmp td { padding: var(--cds-pad-sm); border-bottom: 1px solid var(--color-border-line); text-align: right; }
.rr-cmp th:first-child, .rr-cmp td:first-child { text-align: left; }
.rr-cmp th { font-size: var(--cds-font-size-caption); color: var(--color-fg-muted); font-weight: var(--cds-font-weight-medium); }
.rr-legend .rr-sw { width: 12px; height: 10px; border-radius: 2px; display: inline-block; }
</style>"""

ASOF = f"asof AS (SELECT CAST(max(CreatedDate) AS DATE) AS d FROM {T}.`case`)"
C90 = f"""c90 AS (
  SELECT cs.AccountId, count(*) AS cases_90d, count_if(cs.SLA_Breached__c) AS sla_breaches_90d,
    count_if(cs.Priority IN ('Critical','High')) AS crit_high_90d, count_if(cs.Incident__c IS NOT NULL) AS incident_cases_90d,
    count(cs.CSAT__c) AS csat_responses_90d, avg(cs.CSAT__c) AS csat_avg_raw,
    count_if(cs.Reason = 'Feature Request') AS feature_requests_90d
  FROM {T}.`case` cs CROSS JOIN asof
  WHERE CAST(cs.CreatedDate AS DATE) > date_sub(asof.d, 90)
  GROUP BY cs.AccountId)"""
RISK = """risk AS (
  SELECT AccountId, cases_90d, round(sla_breaches_90d / cases_90d, 3) AS sla_breach_rate,
    CASE WHEN csat_responses_90d >= 3 THEN round(csat_avg_raw, 2) END AS csat_90d, csat_responses_90d,
    feature_requests_90d, incident_cases_90d,
    round(35 * least(sla_breaches_90d / cases_90d / 0.40, 1)
        + 30 * CASE WHEN csat_responses_90d >= 3 THEN (5 - csat_avg_raw) / 4 ELSE 0.5 END
        + 20 * least(crit_high_90d / cases_90d / 0.50, 1)
        + 15 * least(incident_cases_90d / 3.0, 1), 1) AS risk_score
  FROM c90)"""
BAND = "CASE WHEN r.cases_90d >= 5 THEN CASE WHEN r.risk_score >= 60 THEN 'High' WHEN r.risk_score >= 40 THEN 'Elevated' ELSE 'Watch' END ELSE 'Not scored' END"

SEG_RULE = {"enum": ["", "SMB", "Mid-Market", "Enterprise"]}
REG_RULE = {"enum": ["", "US-East", "US-West", "EU", "APAC"]}
SEGREG = "('{{segment}}' = '' OR a.Customer_Segment__c = '{{segment}}') AND ('{{region}}' = '' OR a.Hosting_Region__c = '{{region}}')"

def ds(title, desc, sql, rules):
    used = set(re.findall(r"\{\{(\w+)\}\}", sql))
    src = {"kind": "call", "connector": CONNECTOR, "tool": TOOL, "args": {"query": sql.strip()}}
    r = {k: v for k, v in rules.items() if k in used}
    if r:
        src["rules"] = r
    return {"title": title, "description": desc, "langs": {"query": "sql"}, "source": src}

def page(body, scripts, ids):
    loaders = "".join(
        f"dash.loader('{i}', {{ description: 'Reads the Databricks SQL statement result as rows.', fn: ({{ answer, read }}) => read.databricks(answer) }});\n"
        for i in ids)
    return ('<meta name="dash-one-writer">\n<meta name="dash-form" content="dashboard">\n'
            + CSS + "\n" + EXTRA_CSS + "\n" + body + "\n" + JS.replace("__LOADERS__", loaders) + "\n" + NUMDRAW + "\n" + scripts)

NUMDRAW = """<script>
dash.draw('num', (el) => {
  const s = dash.data(el.dataset.source);
  if (s.status === 'loading') { el.textContent = '—'; return; }
  el.classList.remove('dash-skeleton');
  let row = null;
  if (s.status === 'ok') {
    if (el.dataset.where) { const [k, v] = el.dataset.where.split('='); row = s.data.find((d) => String(d[k]) === decodeURIComponent(v)); }
    else row = s.data[Number(el.dataset.row || 0)];
  }
  if (!row) { el.textContent = '—'; return; }
  const v = row[el.dataset.field];
  const f = window.rr[el.dataset.fmt];
  el.textContent = f ? f(v) : (v == null ? '—' : String(v));
});
window.rr.tbody = (el, id, key, cols, limit) => {
  const s = dash.data(id);
  el.replaceChildren();
  if (s.status !== 'ok') return;
  s.data.slice(0, limit || 1000).forEach((d) => {
    const tr = document.createElement('tr');
    tr.dataset.key = key.split(',').map((k) => d[k]).join(',');
    cols.forEach((c) => {
      const td = document.createElement('td');
      if (c.render) c.render(td, d); else td.textContent = (window.rr[c.fmt] || window.rr.text)(d[c.f]);
      if (c.num) td.className = 'num';
      tr.append(td);
    });
    el.append(tr);
  });
};
window.rr.msg = (el, id, empty) => {
  const s = dash.data(id);
  el.textContent = s.status === 'loading' ? 'Loading…' : s.status === 'error' ? "This part didn't load." : s.status === 'ok' && !s.data.length ? empty : '';
};
window.rr.pill = (td, band) => { const p = document.createElement('span'); p.className = 'rr-pill rr-pill-' + band; p.textContent = band; td.append(p); };
window.rr.hbars = (el, rows, o) => {
  el.replaceChildren();
  if (!rows.length) { const p = document.createElement('p'); p.className = 'rr-msg'; p.textContent = o.empty || 'Nothing to show.'; el.append(p); return; }
  const W = Math.max(260, el.clientWidth), bh = 24, gap = 8;
  const probe = d3.select(el).append('svg').attr('width', 10).attr('height', 10);
  const lw = d3.max(rows, (d) => { const t = probe.append('text').attr('class', 'rr-axis-label').text(o.label(d)); const w = t.node().getComputedTextLength(); t.remove(); return w; }) || 40;
  probe.remove();
  const m = { t: 2, r: o.right || 90, b: 2, l: Math.min(lw + 10, W * 0.45) };
  const H = m.t + m.b + rows.length * (bh + gap);
  const x = d3.scaleLinear().domain([0, d3.max(rows, o.value) || 1]).range([m.l, W - m.r]);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', o.aria);
  const g = svg.selectAll('g').data(rows).join('g').attr('transform', (d, i) => `translate(0,${m.t + i * (bh + gap)})`);
  if (o.onClick) g.style('cursor', 'pointer').on('click', (e, d) => o.onClick(d));
  g.append('rect').attr('x', m.l).attr('height', bh).attr('rx', 3).attr('width', (d) => Math.max(1, x(o.value(d)) - m.l)).style('fill', (d) => (o.color ? o.color(d) : dash.colors[0]));
  g.append('text').attr('class', 'rr-axis-label').attr('x', m.l - 8).attr('y', bh / 2).attr('dy', '0.35em').attr('text-anchor', 'end').text(o.label);
  g.append('text').attr('class', 'rr-axis-label').attr('x', (d) => x(o.value(d)) + 6).attr('y', bh / 2).attr('dy', '0.35em').text(o.valueText);
};
</script>"""

def write(name, url, meta, params, datasets, html):
    out = os.path.join(HERE, name)
    os.makedirs(out, exist_ok=True)
    writes = [{"op": "set", "collection": "dash", "doc_id": "meta", "data": meta}]
    if params:
        writes.append({"op": "set", "collection": "dash", "doc_id": "params", "data": params})
    for k, v in datasets.items():
        p = os.path.join(out, f"ds_{k}.json"); json.dump(v, open(p, "w"))
        writes.append({"op": "set", "collection": "datasets", "doc_id": k, "file_path": p})
    p = os.path.join(out, "index.json"); json.dump({"text": html}, open(p, "w"))
    open(os.path.join(out, "index.html"), "w").write(html)
    writes.append({"op": "set", "collection": "files", "doc_id": "index.html", "file_path": p})
    json.dump({"url": url, "writes": writes}, open(os.path.join(out, "batch.json"), "w"), indent=1)
    # test SQL with defaults filled
    for k, v in datasets.items():
        sql = v["source"]["args"]["query"]
        for pk, pv in (params or {}).items():
            sql = sql.replace("{{%s}}" % pk, str(pv))
        open(os.path.join(out, f"test_{k}.sql"), "w").write(sql)
    print(name, "datasets:", list(datasets), "html bytes:", len(html))

exec(open(os.path.join(HERE, "build_pages.py")).read())
