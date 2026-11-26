import os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "build.py")).read()
exec(src[: src.index("exec(open(")])

GW = "CSCSW GW Prod"

def gw(title, desc, tool, query, rules=None):
    s = {"kind": "call", "connector": GW, "tool": tool, "args": {"query": query}}
    if rules:
        s["rules"] = rules
    return {"title": title, "description": desc, "source": s}

def crm_page(body, scripts, loaders_js):
    return ('<meta name="dash-one-writer">\n<meta name="dash-form" content="dashboard">\n'
            + CSS + "\n" + EXTRA_CSS + "\n" + CRM_CSS + "\n" + body + "\n"
            + JS.replace("__LOADERS__", "") + "\n" + NUMDRAW + "\n<script>\n" + loaders_js + "\n</script>\n" + MD_JS + "\n" + scripts)

CRM_CSS = """<style>
.rr-brief { display: flex; flex-direction: column; gap: var(--cds-gap-sm); max-width: 78ch; line-height: 1.5; }
.rr-brief h3 { font-size: var(--cds-font-size-heading); font-weight: var(--cds-font-weight-medium); margin: var(--cds-gap-md) 0 0; }
.rr-brief p, .rr-brief ul { margin: 0; }
.rr-brief ul { padding-left: 1.2em; display: flex; flex-direction: column; gap: var(--cds-gap-xs); }
.rr-brief a, .rr-link { color: inherit; text-decoration-color: var(--color-border-line); text-underline-offset: 2px; }
.rr-brief a:hover, .rr-link:hover { text-decoration-color: currentColor; }
.rr-gov { font-size: var(--cds-font-size-caption); color: var(--color-fg-muted); margin: 0; }
.rr-score { display: flex; align-items: center; gap: var(--cds-gap-lg); flex-wrap: wrap; }
.rr-gauge { width: 160px; max-width: 100%; }
.rr-gauge text { fill: var(--color-fg); font-family: var(--font-anthropic-serif); }
.rr-chips { display: flex; flex-wrap: wrap; gap: var(--cds-gap-sm); padding: 0; margin: 0; list-style: none; }
.rr-chips li { border: 1px solid var(--color-border-line); border-radius: 999px; padding: var(--cds-pad-xs) var(--cds-pad-md); font-size: var(--cds-font-size-caption); color: var(--color-fg-muted); }
.rr-pill-Critical, .rr-pill-Unreliable, .rr-pill-PastDue { color: var(--color-bad); }
.rr-pill-Fair, .rr-pill-AtRisk { color: var(--color-warn); }
.rr-pill-Good, .rr-pill-Healthy, .rr-pill-Reliable { color: var(--color-ok); }
</style>"""

# Shared, self-contained parsing code. Each loader embeds what it needs (loaders may not use outside code).
CARD = r"""const card = typeof answer === 'string' ? JSON.parse(answer) : answer;
    if (!card) throw new Error('The CRM gateway returned nothing.');
    if (card.error) throw new Error(typeof card.error === 'string' ? card.error : (card.error.message || 'The CRM gateway reported an error.'));
    const md = String(card.answer || '');
    const base = /^https:\/\//.test(card.instance_url || '') ? card.instance_url.replace(/\/$/, '') : '';
    const link = (s) => { const m = /\[([^\]]+)\]\(([^)]+)\)/.exec(s); if (!m) return { text: s.replace(/\*\*/g, '').trim(), url: null, id: null };
      const id = (/\/r\/\w+\/(\w{15,18})\//.exec(m[2]) || [])[1] || null;
      const url = /^https:\/\//.test(m[2]) ? m[2] : (base && m[2].startsWith('/') ? base + m[2] : null);
      return { text: m[1].replace(/\*\*/g, '').trim(), url, id }; };
    const money = (s) => { const t = String(s).replace(/\*\*/g, '').trim(); if (!/^-?\$?-?[\d,]+(\.\d+)?$/.test(t)) return null; return Number(t.replace(/[$,]/g, '')); };
    const tables = []; const lines = md.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\s*\|/.test(lines[i]) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(lines[i]).map((h) => h.replace(/\*\*/g, ''));
        const body = []; let j = i + 2;
        while (j < lines.length && /^\s*\|/.test(lines[j])) { body.push(cells(lines[j])); j++; }
        tables.push({ head, body, start: i, end: j }); i = j;
      }
    }
    const meta = [{ label: 'Asked', value: String(card.ask || '') }, { label: 'Agent', value: String(card.title || '') }, { label: 'Runs as', value: String(card.runs_as || '') + ' (' + String(card.persona || '') + ')' }];"""

TOP_LOADER = """dash.loader('top', { description: 'Reads the accounts table out of the CRM agent\\'s answer card. Links become Salesforce record links; dollar amounts become numbers.', fn: ({ answer }) => {
    """ + CARD + """
    const t = tables[0];
    if (!t) return { data: [], columns: [], truncated: false, meta };
    const acctCol = Math.max(0, t.head.findIndex((h) => /account|name/i.test(h)));
    const moneyCols = t.head.map((h, k) => k).filter((k) => k !== acctCol && t.body.some((r) => money(r[k]) !== null && /\\$/.test(r[k])));
    const outside = lines.filter((l, k) => k < t.start || k >= t.end).join('\\n')
      .replace(/^_.*_$/gm, '').replace(/\\n{2,}/g, '\\n').trim();
    const summary = outside.split('\\n').filter((l) => l.trim() && !/^(here are|want me)/i.test(l.trim())).join(' ').replace(/\\*\\*/g, '');
    const data = t.body.map((r, k) => { const a = link(r[acctCol] || '');
      return { rank: k + 1, account: a.text, account_id: a.id, url: a.url,
        primary_value: moneyCols[0] != null ? money(r[moneyCols[0]]) : null, primary_label: moneyCols[0] != null ? t.head[moneyCols[0]] : '',
        secondary_value: moneyCols[1] != null ? money(r[moneyCols[1]]) : null, secondary_label: moneyCols[1] != null ? t.head[moneyCols[1]] : '',
        agent_summary: summary }; });
    return { data, columns: ['rank', 'account', 'account_id', 'url', 'primary_value', 'primary_label', 'secondary_value', 'secondary_label', 'agent_summary'], truncated: false, meta };
  } });"""

BRIEF_LOADER = """dash.loader('brief', { description: 'Splits the briefing card into headings, paragraphs, bullets and metric rows. Email addresses and phone numbers are removed.', fn: ({ answer }) => {
    """ + CARD + """
    const scrub = (s) => s.replace(/[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/g, '[email hidden]').replace(/\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}/g, '[phone hidden]');
    const rows = []; let section = '';
    const inTable = new Set(); tables.forEach((t) => { for (let k = t.start; k < t.end; k++) inTable.add(k); });
    tables.forEach((t) => t.body.forEach((r) => { if (r.length >= 2) rows.push({ i: t.start, kind: 'metric', section: '', key: r[0].replace(/\\*\\*/g, ''), value: scrub(r[1].replace(/\\*\\*/g, '')), text: null, number: money(r[1]) }); }));
    lines.forEach((l, k) => {
      if (inTable.has(k)) return;
      const s = l.trim();
      if (!s || /^-{3,}$/.test(s)) return;
      if (/^#{1,6}\\s/.test(s)) { section = s.replace(/^#+\\s*/, '').replace(/[^\\p{L}\\p{N} &/,'()-]/gu, '').trim(); rows.push({ i: k, kind: 'h', section, key: null, value: null, text: section, number: null }); return; }
      if (/^[-*]\\s/.test(s)) { rows.push({ i: k, kind: 'li', section, key: null, value: null, text: scrub(s.replace(/^[-*]\\s+/, '')), number: null }); return; }
      if (/^want me/i.test(s)) return;
      rows.push({ i: k, kind: 'p', section, key: null, value: null, text: scrub(s), number: null });
    });
    rows.sort((a, b) => a.i - b.i);
    return { data: rows.map((r, n) => ({ ...r, i: n, base })), columns: ['i', 'kind', 'section', 'key', 'value', 'number', 'text', 'base'], truncated: false, meta };
  } });"""

MD_JS = r"""<script>
// Renders the CRM agent's markdown inline formatting safely: text nodes only, links only to https.
window.rr.inline = (el, s, base) => {
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g; let last = 0, m;
  s = String(s || '');
  while ((m = re.exec(s))) {
    if (m.index > last) el.append(document.createTextNode(s.slice(last, m.index)));
    if (m[1] != null) { const b = document.createElement('strong'); window.rr.inline(b, m[1], base); el.append(b); }
    else {
      const href = /^https:\/\//.test(m[3]) ? m[3] : (base && m[3].startsWith('/') ? base + m[3] : null);
      if (href) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = m[2].replace(/\*\*/g, ''); el.append(a); }
      else el.append(document.createTextNode(m[2]));
    }
    last = re.lastIndex;
  }
  if (last < s.length) el.append(document.createTextNode(s.slice(last)));
};
window.rr.SAFE_NAME = /^[\p{L}\p{M}\p{N} .,&/#()-]{1,80}$/u;
</script>"""

# ---------------------------------------------------------------- CRM Top Accounts + briefing
NAME_RULE = {"pattern": "^[\\p{L}\\p{M}\\p{N} .,&/#()-]{1,80}$", "description": "Any account name; the briefing shows only what the viewer's own CRM access allows"}
top_ds = {
 "top": gw("Top accounts by revenue", "The CRM agent's ranking of accounts by average commissionable revenue, run as the viewer.",
           "ask", "top {{n}} accounts by revenue", {"n": {"enum": [10, 20, 50]}}),
 "brief": gw("Account briefing", "The Coworker agent's briefing on the chosen account: owner, metrics, opportunities, service activity and recommended actions.",
             "coworker_search", "brief me on {{account}}", {"account": NAME_RULE}),
}
top_body = """<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">CRM Top Accounts</h1>
    <p class="rr-lede" id="takeaway"><b data-draw="num" data-source="top" data-field="account" data-row="0" class="dash-skeleton">—</b> leads with <b data-draw="num" data-source="top" data-field="primary_value" data-row="0" data-fmt="money" class="dash-skeleton">—</b> in average monthly commissionable revenue. Click any account for a full briefing.</p>
    <p class="rr-gov">Live from Salesforce through the CRM gateway agents. Each query runs as the person viewing the page, so every viewer sees only what their own CRM access allows.</p>
  </header>
  <div class="rr-filters" id="filters">
    <label>Show<select class="dash-select" id="f-n" aria-label="How many accounts"><option value="10">Top 10</option><option value="20">Top 20</option><option value="50">Top 50</option></select></label>
  </div>
  <div class="rr-grid2">
    <section class="rr-section" id="ranking">
      <h2>Average monthly commissionable revenue</h2>
      <p class="rr-sub">Based on the last 90 days of collections. Click a bar to brief on that account.</p>
      <div class="rr-bars dash-skeleton" data-draw="topbars" data-source="top"></div>
    </section>
    <section class="rr-section" id="agent-take">
      <h2>What the CRM agent says</h2>
      <p class="rr-brief" data-draw="num" data-source="top" data-field="agent_summary" data-row="0">—</p>
      <div class="rr-tablewrap"><table class="rr-table" data-source="top" data-row-key="rank">
        <thead><tr><th data-field="rank">#</th><th data-field="account">Account</th><th data-field="primary_value" class="num">Avg monthly</th><th data-field="secondary_value" class="num">Last 90 days</th></tr></thead>
        <tbody data-draw="toprows"></tbody></table></div>
      <p class="rr-msg" data-draw="topmsg"></p>
    </section>
  </div>
  <section class="rr-section" id="briefing">
    <h2>Briefing: <span data-draw="briefname">—</span></h2>
    <p class="rr-sub">From the Coworker agent. Contact emails and phone numbers are hidden on this page. A briefing can take up to a minute.</p>
    <div class="rr-kpis" data-draw="briefkpis" data-source="brief"></div>
    <div class="rr-brief dash-skeleton" data-draw="brief" data-source="brief"></div>
  </section>
  <details class="rr-notes" id="method">
    <summary>How this page gets its data</summary>
    <ul>
      <li>The ranking asks the CRM gateway's analytics agent "top N accounts by revenue". The briefing asks the Coworker agent "brief me on" the chosen account.</li>
      <li>Both agents query Salesforce on the server and return a summary card. Raw records never pass through the page or the model.</li>
      <li>The agents write their answers in natural language, so a column name or layout can change between runs. The page reads the first table in each answer.</li>
    </ul>
  </details>
</div>"""
top_js = """<script>
const fN = document.querySelectorAll('#f-n');
fN.forEach((el) => el.addEventListener('change', () => dash.setParams({ n: Number(el.value) })));
dash.onData(() => { const p = dash.params(); fN.forEach((el) => { if (document.activeElement !== el) el.value = String(p.n ?? 20); }); });
const pick = (name) => { if (window.rr.SAFE_NAME.test(name)) dash.setParams({ account: name }); };
dash.draw('topbars', (el) => {
  const s = dash.data('top');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  window.rr.hbars(el, s.data.filter((d) => d.primary_value != null), { label: (d) => d.account, value: (d) => d.primary_value, right: 70,
    valueText: (d) => window.rr.money(d.primary_value), aria: 'Accounts ranked by average monthly commissionable revenue',
    onClick: (d) => pick(d.account), empty: 'The CRM agent returned no ranked accounts.' });
  el.querySelectorAll('g').forEach((g) => { const d = d3.select(g).datum(); if (d && d.account === dash.params().account) d3.select(g).select('rect').style('fill', 'var(--color-fg)'); });
});
dash.draw('toprows', (el) => window.rr.tbody(el, 'top', 'rank', [
  { f: 'rank', fmt: 'int' },
  { f: 'account', render: (td, d) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'rr-linkbtn'; b.textContent = d.account; b.disabled = !window.rr.SAFE_NAME.test(d.account); b.addEventListener('click', () => pick(d.account)); td.append(b);
      if (d.url && /^https:\\/\\//.test(d.url)) { const a = document.createElement('a'); a.href = d.url; a.target = '_blank'; a.rel = 'noopener'; a.className = 'rr-link rr-muted'; a.textContent = ' Salesforce ↗'; td.append(a); } } },
  { f: 'primary_value', fmt: 'money', num: true }, { f: 'secondary_value', fmt: 'money', num: true }]));
dash.draw('topmsg', (el) => window.rr.msg(el, 'top', 'The CRM agent returned no table this time. Try again, or pick another size.'));
dash.draw('briefname', (el) => { el.textContent = dash.params().account || '—'; });
dash.draw('briefkpis', (el) => {
  const s = dash.data('brief');
  el.replaceChildren();
  if (s.status !== 'ok') return;
  s.data.filter((d) => d.kind === 'metric').slice(0, 10).forEach((d) => {
    const c = document.createElement('div'); c.className = 'rr-card';
    const l = document.createElement('span'); l.className = 'rr-kpi-label'; l.textContent = d.key;
    const v = document.createElement('span'); v.className = 'rr-kpi-value'; v.style.fontSize = 'var(--cds-font-size-heading)';
    v.textContent = d.number != null && Math.abs(d.number) >= 1000 ? window.rr.money(d.number) : d.value;
    v.dataset.source = 'brief'; v.dataset.field = 'value'; v.dataset.row = String(d.i);
    c.append(l, v); el.append(c);
  });
});
dash.draw('brief', (el) => {
  const s = dash.data('brief');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  el.replaceChildren();
  let ul = null;
  s.data.filter((d) => d.kind !== 'metric').forEach((d) => {
    if (d.kind !== 'li') ul = null;
    if (d.kind === 'h') { const h = document.createElement('h3'); h.textContent = d.text; el.append(h); return; }
    if (d.kind === 'li') { if (!ul) { ul = document.createElement('ul'); el.append(ul); } const li = document.createElement('li'); window.rr.inline(li, d.text, d.base); ul.append(li); return; }
    const p = document.createElement('p'); window.rr.inline(p, d.text, d.base); el.append(p);
  });
  if (!s.data.length) { const p = document.createElement('p'); p.className = 'rr-msg'; p.textContent = 'The Coworker agent found nothing for this account.'; el.append(p); }
});
</script>
<style>.rr-linkbtn { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; text-decoration: underline; text-decoration-color: var(--color-border-line); text-underline-offset: 2px; } .rr-linkbtn:hover { text-decoration-color: currentColor; } .rr-linkbtn:disabled { cursor: default; text-decoration: none; }</style>"""

write_html = crm_page(top_body, top_js, TOP_LOADER + "\n" + BRIEF_LOADER)
write("crm_top", "https://claude.ai/artifact/HETfVogcbMN4rMddCK77Lb", {"title": "CRM Top Accounts"},
      {"n": 20, "account": "PURDUE UNIVERSITY"}, top_ds, write_html)

# ---------------------------------------------------------------- My CRM Pipeline
HEALTH_LOADER = """dash.loader('health', { description: 'Reads the pipeline health score, its rating, the top issues and the questions the agent suggests next.', fn: ({ answer }) => {
    """ + CARD + """
    const sc = /(\\d{1,3})\\s*\\/\\s*100/.exec(md);
    const rating = (/\\d{1,3}\\s*\\/\\s*100\\s*[—–-]+\\s*([A-Za-z ]+)/.exec(md) || /\\(([A-Za-z ]+)\\)/.exec(md) || [])[1] || null;
    const scope = (/_Scope:\\s*([^_]+)_/.exec(md) || [])[1] || null;
    const headline = (md.split('\\n').find((l) => l.trim() && !/^#/.test(l.trim())) || '').trim();
    const rows = [{ kind: 'score', score: sc ? Number(sc[1]) : null, rating: rating ? rating.trim() : null, text: headline, scope }];
    let inIssues = false;
    lines.forEach((l) => { const s = l.trim();
      if (/^\\*\\*top issues\\*\\*/i.test(s) || /^#+\\s*top issues/i.test(s)) { inIssues = true; return; }
      if (inIssues && /^[-*]\\s/.test(s)) rows.push({ kind: 'issue', score: null, rating: null, text: s.replace(/^[-*]\\s+/, '').replace(/\\s{2,}/g, ' '), scope: null });
      else if (inIssues && s && !/^[-*]\\s/.test(s)) inIssues = false; });
    (card.next_steps || []).forEach((n) => rows.push({ kind: 'next', score: null, rating: null, text: String(n.label || n.query || ''), scope: null }));
    return { data: rows, columns: ['kind', 'score', 'rating', 'text', 'scope'], truncated: false, meta };
  } });"""

OPPS_LOADER = """dash.loader('opps', { description: 'Reads the open opportunities table out of the agent\\'s card. Amounts become numbers.', fn: ({ answer }) => {
    """ + CARD + """
    const t = tables[0];
    if (!t) return { data: [], columns: ['name', 'stage', 'amount', 'close'], truncated: false, meta };
    const col = (re) => t.head.findIndex((h) => re.test(h));
    const ni = Math.max(0, col(/name|opportunit/i)), si = col(/stage/i), ai = col(/amount|value/i), ci = col(/close/i);
    const data = t.body.map((r) => { const n = link(r[ni] || ''); return { name: n.text.replace(/\\s{2,}/g, ' '), url: n.url,
      stage: si >= 0 ? r[si] : null, amount: ai >= 0 ? money(r[ai]) : null, close: ci >= 0 ? r[ci] : null }; });
    return { data, columns: ['name', 'stage', 'amount', 'close', 'url'], truncated: false, meta };
  } });"""

FORECAST_LOADER = """dash.loader('forecast', { description: 'Reads the forecast reliability rating and the share of open pipeline that is past due.', fn: ({ answer }) => {
    """ + CARD + """
    const rel = (/Forecast Reliability:\\s*\\**\\s*([A-Za-z ]+?)\\s*\\**\\s*(?:[.\\n]|$)/i.exec(md) || [])[1] || null;
    const pd = (/%\\s*past due:\\s*(\\d+(?:\\.\\d+)?)/i.exec(md) || /(\\d+(?:\\.\\d+)?)%\\s+of your open pipeline is past due/i.exec(md) || [])[1];
    const headline = (md.split('\\n').find((l) => l.trim() && !/^#/.test(l.trim())) || '').trim();
    return { data: [{ reliability: rel ? rel.trim() : null, pct_past_due: pd != null ? Number(pd) / 100 : null, text: headline }], columns: ['reliability', 'pct_past_due', 'text'], truncated: false, meta };
  } });"""

pipe_ds = {
 "health": gw("My pipeline health", "The pipeline agent's health score for the viewer's own deals, with top issues.", "pipeline_my", "what's my pipeline health score"),
 "opps": gw("My open opportunities", "The viewer's own open opportunities from Salesforce.", "pipeline_my", "Show my open opportunities"),
 "forecast": gw("My forecast reliability", "How much of the viewer's open pipeline is past due, and the resulting forecast rating.", "pipeline_my", "How reliable is my forecast?"),
}
pipe_body = """<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">My CRM Pipeline</h1>
    <p class="rr-lede" id="takeaway" data-draw="num" data-source="health" data-field="text" data-where="kind=score">—</p>
    <p class="rr-gov">Live from Salesforce through the CRM pipeline agent. It always runs as the person viewing the page, so each rep who opens this sees their own deals.</p>
  </header>
  <div class="rr-kpis" id="kpis">
    <div class="rr-card" id="kpi-score"><span class="rr-kpi-label">Pipeline health</span>
      <div class="rr-score"><svg class="rr-gauge dash-skeleton" data-draw="gauge" data-source="health" viewBox="0 0 160 96" role="img" aria-label="Pipeline health score out of 100"></svg></div>
      <span class="rr-kpi-note" data-draw="rating"></span></div>
    <div class="rr-card" id="kpi-forecast"><span class="rr-kpi-label">Forecast reliability</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="forecast" data-field="reliability" data-row="0">—</span>
      <span class="rr-kpi-note"><span data-draw="num" data-source="forecast" data-field="pct_past_due" data-row="0" data-fmt="pct">—</span> of open pipeline is past due</span></div>
    <div class="rr-card" id="kpi-open"><span class="rr-kpi-label">Open opportunities</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="oppcount">—</span>
      <span class="rr-kpi-note" data-draw="oppsum">—</span></div>
  </div>
  <div class="rr-grid2">
    <section class="rr-section" id="issues">
      <h2>Top issues</h2>
      <ul class="rr-brief" data-draw="issues" data-source="health"></ul>
    </section>
    <section class="rr-section" id="next">
      <h2>Questions the agent suggests next</h2>
      <p class="rr-sub">Ask these in Claude to follow up.</p>
      <ul class="rr-chips" data-draw="nextsteps" data-source="health"></ul>
    </section>
  </div>
  <section class="rr-section" id="opps">
    <h2>My open opportunities</h2>
    <div class="rr-tablewrap"><table class="rr-table" data-source="opps" data-row-key="name">
      <thead><tr><th data-field="name">Opportunity</th><th data-field="stage">Stage</th><th data-field="amount" class="num">Amount</th><th data-field="close">Close date</th></tr></thead>
      <tbody data-draw="opprows"></tbody></table></div>
    <p class="rr-msg" data-draw="oppmsg"></p>
  </section>
  <details class="rr-notes" id="method">
    <summary>How this page gets its data</summary>
    <ul>
      <li>Three questions go to the CRM gateway's pipeline agent: "what's my pipeline health score", "Show my open opportunities" and "How reliable is my forecast?".</li>
      <li>The agent scores the pipeline itself. This page shows its score and rating as given.</li>
      <li>Past due means the close date is before today.</li>
    </ul>
  </details>
</div>"""
pipe_js = """<script>
dash.draw('gauge', (el) => {
  const s = dash.data('health');
  if (s.status === 'loading') return;
  el.classList.remove('dash-skeleton');
  const row = s.status === 'ok' ? s.data.find((d) => d.kind === 'score') : null;
  const v = row && row.score != null ? Math.max(0, Math.min(100, Number(row.score))) : null;
  const svg = d3.select(el); svg.selectAll('*').remove();
  const arc = d3.arc().innerRadius(56).outerRadius(70);
  const g = svg.append('g').attr('transform', 'translate(80,84)');
  g.append('path').attr('d', arc({ startAngle: -Math.PI / 2, endAngle: Math.PI / 2 })).style('fill', 'var(--cds-chart-grid)');
  if (v != null) g.append('path').attr('d', arc({ startAngle: -Math.PI / 2, endAngle: -Math.PI / 2 + Math.PI * v / 100 }))
    .style('fill', v < 50 ? 'var(--color-bad)' : v < 70 ? 'var(--color-warn)' : 'var(--color-ok)');
  const t = g.append('text').attr('text-anchor', 'middle').attr('y', -6).style('font-size', '32px').text(v == null ? '—' : String(v));
  t.attr('data-source', 'health').attr('data-field', 'score').attr('data-where', 'kind=score');
  g.append('text').attr('text-anchor', 'middle').attr('y', 10).style('font-size', '11px').style('fill', 'var(--color-fg-muted)').text('out of 100');
});
dash.draw('rating', (el) => {
  const s = dash.data('health'); el.replaceChildren();
  const row = s.status === 'ok' ? s.data.find((d) => d.kind === 'score') : null;
  if (!row || !row.rating) return;
  const sp = document.createElement('span'); sp.className = 'rr-pill rr-pill-' + row.rating.replace(/\\s+/g, ''); sp.style.marginLeft = '0'; sp.textContent = row.rating;
  sp.dataset.source = 'health'; sp.dataset.field = 'rating'; sp.dataset.where = 'kind=score';
  el.append(sp); if (row.scope) el.append(document.createTextNode(' ' + row.scope));
});
dash.draw('issues', (el) => {
  const s = dash.data('health'); el.replaceChildren();
  if (s.status !== 'ok') return;
  const items = s.data.filter((d) => d.kind === 'issue');
  if (!items.length) { const li = document.createElement('li'); li.className = 'rr-muted'; li.textContent = 'The agent listed no issues.'; el.append(li); return; }
  items.forEach((d) => { const li = document.createElement('li'); window.rr.inline(li, d.text, ''); el.append(li); });
});
dash.draw('nextsteps', (el) => {
  const s = dash.data('health'); el.replaceChildren();
  if (s.status !== 'ok') return;
  s.data.filter((d) => d.kind === 'next' && !/clean ?up/i.test(d.text)).forEach((d) => { const li = document.createElement('li'); li.textContent = d.text; el.append(li); });
});
dash.draw('oppcount', (el) => { const s = dash.data('opps'); if (s.status === 'loading') return; el.classList.remove('dash-skeleton'); el.textContent = s.status === 'ok' ? String(s.data.length) : '—'; });
dash.draw('oppsum', (el) => { const s = dash.data('opps'); el.textContent = s.status === 'ok' && s.data.length ? `${window.rr.money(d3.sum(s.data, (d) => d.amount || 0))} total` : ''; });
dash.draw('opprows', (el) => window.rr.tbody(el, 'opps', 'name', [
  { f: 'name', render: (td, d) => { if (d.url && /^https:\\/\\//.test(d.url)) { const a = document.createElement('a'); a.href = d.url; a.target = '_blank'; a.rel = 'noopener'; a.className = 'rr-link'; a.textContent = d.name; td.append(a); } else td.textContent = d.name; } },
  { f: 'stage' }, { f: 'amount', fmt: 'money', num: true },
  { f: 'close', render: (td, d) => { td.textContent = window.rr.date(d.close); const dt = new Date(String(d.close).slice(0, 10) + 'T00:00:00Z');
      if (!isNaN(dt) && dt < new Date()) { const p = document.createElement('span'); p.className = 'rr-pill rr-pill-PastDue'; p.textContent = 'Past due'; td.append(p); } } }]));
dash.draw('oppmsg', (el) => window.rr.msg(el, 'opps', 'No open opportunities. Nice and clean.'));
</script>"""

write("crm_pipe", "https://claude.ai/artifact/B8uPLH5zbyNGoTQvKc5a7C", {"title": "My CRM Pipeline"}, None, pipe_ds,
      crm_page(pipe_body, pipe_js, HEALTH_LOADER + "\n" + OPPS_LOADER + "\n" + FORECAST_LOADER))
