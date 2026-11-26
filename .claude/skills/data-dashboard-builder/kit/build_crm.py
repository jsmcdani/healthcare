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

# ---------------------------------------------------------------- CRM Executive Scorecard
SC_LOADER = """dash.loader('sc', { description: 'Reads the scorecard table out of the CRM agent\\'s answer: account, owner, branch, average monthly revenue, contract expiration, machines and service calls. Also keeps the agent\\'s observations.', fn: ({ answer }) => {
    """ + CARD + """
    const t = tables[0];
    if (!t) return { data: [], columns: [], truncated: false, meta };
    const col = (re, not) => t.head.findIndex((h) => re.test(h) && !(not && not.test(h)));
    const ai = Math.max(0, col(/account|name/i)), oi = col(/owner/i), bi = col(/branch/i), ri = col(/revenue/i), ci = col(/contract|expir/i), mi = col(/machine/i), si = col(/service/i);
    const M = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const day = (s) => { const t2 = String(s || '').replace(/\\*\\*/g, ''); let m = /([A-Za-z]{3})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})/.exec(t2);
      if (m && M[m[1].toLowerCase()] != null) return new Date(Date.UTC(+m[3], M[m[1].toLowerCase()], +m[2])).toISOString().slice(0, 10);
      m = /(\\d{4})-(\\d{2})-(\\d{2})/.exec(t2); return m ? m[0] : null; };
    const num = (s) => { const t2 = String(s || '').replace(/[*,$\\s]/g, ''); return /^-?\\d+(\\.\\d+)?$/.test(t2) ? Number(t2) : null; };
    const notes = lines.filter((l, k) => (k < t.start || k >= t.end) && /^\\s*[-*]\\s/.test(l)).map((l) => l.trim().replace(/^[-*]\\s+/, '')).join('\\n');
    const data = t.body.map((r, k) => { const a = link(r[ai] || '');
      return { rank: k + 1, account: a.text, account_id: a.id, url: a.url,
        owner: oi >= 0 ? r[oi].replace(/\\*\\*/g, '') : null, branch: bi >= 0 ? r[bi].replace(/\\*\\*/g, '') : null,
        avg_monthly_revenue: ri >= 0 ? money(r[ri]) : null, contract_expiration: ci >= 0 ? day(r[ci]) : null,
        machines: mi >= 0 ? num(r[mi]) : null, ltm_service_calls: si >= 0 ? num(r[si]) : null, agent_notes: notes }; });
    return { data, columns: ['rank', 'account', 'owner', 'branch', 'avg_monthly_revenue', 'contract_expiration', 'machines', 'ltm_service_calls', 'account_id', 'url', 'agent_notes'], truncated: false, meta };
  } });"""

SC_CALCS = """dash.calc('sc_accounts', { inputs: ['sc'], title: 'Contract status and service load', description: 'For each account: whether the contract has expired or expires within 12 months of today, and service calls per machine over the last 12 months.',
  fn: (sc) => { const today = new Date().toISOString().slice(0, 10); const in12 = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
    return sc.map((d) => ({ account: d.account,
      contract_status: !d.contract_expiration ? 'Unknown' : d.contract_expiration < today ? 'Expired' : d.contract_expiration <= in12 ? 'Within 12 months' : 'Active',
      calls_per_machine: d.machines > 0 && d.ltm_service_calls != null ? Math.round((d.ltm_service_calls / d.machines) * 100) / 100 : null })); } });
dash.calc('sc_summary', { inputs: ['sc'], title: 'Scorecard totals', description: 'Revenue across the accounts shown, contracts expired or expiring within 12 months, the busiest account for service, and the owner with the most top accounts.',
  fn: (sc) => { const today = new Date().toISOString().slice(0, 10); const in12 = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
    const expired = sc.filter((d) => d.contract_expiration && d.contract_expiration < today);
    const soon = sc.filter((d) => d.contract_expiration && d.contract_expiration >= today && d.contract_expiration <= in12);
    const busiest = sc.filter((d) => d.ltm_service_calls != null).sort((a, b) => b.ltm_service_calls - a.ltm_service_calls)[0] || {};
    const owners = {}; sc.forEach((d) => { if (!d.owner) return; owners[d.owner] = owners[d.owner] || { n: 0, rev: 0 }; owners[d.owner].n++; owners[d.owner].rev += d.avg_monthly_revenue || 0; });
    const top = Object.entries(owners).sort((a, b) => b[1].n - a[1].n || b[1].rev - a[1].rev)[0] || [null, { n: 0, rev: 0 }];
    return [{ accounts: sc.length, total_revenue: sc.reduce((s, d) => s + (d.avg_monthly_revenue || 0), 0),
      expired: expired.length, expired_revenue: expired.reduce((s, d) => s + (d.avg_monthly_revenue || 0), 0), expiring_12m: soon.length,
      busiest_account: busiest.account || null, busiest_calls: busiest.ltm_service_calls ?? null,
      top_owner: top[0], top_owner_accounts: top[1].n, top_owner_revenue: top[1].rev }]; } });
dash.calc('sc_owners', { inputs: ['sc'], title: 'Top accounts by owner', description: 'How many of the accounts shown each owner holds, and their combined average monthly revenue.',
  fn: (sc) => { const m = {}; sc.forEach((d) => { const k = d.owner || 'Unassigned'; m[k] = m[k] || { owner: k, accounts: 0, avg_monthly_revenue: 0 }; m[k].accounts++; m[k].avg_monthly_revenue += d.avg_monthly_revenue || 0; });
    return Object.values(m).sort((a, b) => b.avg_monthly_revenue - a.avg_monthly_revenue); } });"""

sc_ds = {
 "sc": gw("Executive scorecard", "The CRM agent's top accounts by average monthly commissionable revenue, with owner, branch, contract expiration, machines and service calls.",
          "ask", "top {{n}} accounts by revenue with account owner, branch, contract expiration date, machine count and LTM service calls", {"n": {"enum": [10, 20]}}),
 "brief": top_ds["brief"],
}

sc_body = """<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">CRM Executive Scorecard</h1>
    <p class="rr-lede" id="takeaway">The top <b data-draw="num" data-source="sc_summary" data-field="accounts" data-row="0" data-fmt="int" class="dash-skeleton">—</b> accounts bring in <b data-draw="num" data-source="sc_summary" data-field="total_revenue" data-row="0" data-fmt="money" class="dash-skeleton">—</b> a month. <b data-draw="num" data-source="sc_summary" data-field="expired" data-row="0" data-fmt="int" class="dash-skeleton">—</b> of them, worth <b data-draw="num" data-source="sc_summary" data-field="expired_revenue" data-row="0" data-fmt="money" class="dash-skeleton">—</b> a month, are on expired contracts.</p>
    <p class="rr-gov">Live from Salesforce through the CRM gateway. Each query runs as the person viewing the page. Revenue is average monthly commissionable revenue over the last 90 days of collections.</p>
  </header>
  <div class="rr-filters" id="filters">
    <label>Show<select class="dash-select" id="f-n" aria-label="How many accounts"><option value="10">Top 10</option><option value="20">Top 20</option></select></label>
  </div>
  <div class="rr-kpis" id="kpis">
    <div class="rr-card" id="kpi-revenue"><span class="rr-kpi-label">Monthly revenue, accounts shown</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="sc_summary" data-field="total_revenue" data-row="0" data-fmt="money">—</span><span class="rr-kpi-note">average over the last 90 days</span></div>
    <div class="rr-card" id="kpi-expired"><span class="rr-kpi-label">Expired contracts</span><span class="rr-kpi-value rr-bad dash-skeleton" data-draw="num" data-source="sc_summary" data-field="expired" data-row="0" data-fmt="int">—</span><span class="rr-kpi-note"><span data-draw="num" data-source="sc_summary" data-field="expired_revenue" data-row="0" data-fmt="money">—</span> a month exposed</span></div>
    <div class="rr-card" id="kpi-soon"><span class="rr-kpi-label">Expiring within 12 months</span><span class="rr-kpi-value rr-warn dash-skeleton" data-draw="num" data-source="sc_summary" data-field="expiring_12m" data-row="0" data-fmt="int">—</span><span class="rr-kpi-note">start renewal talks now</span></div>
    <div class="rr-card" id="kpi-service"><span class="rr-kpi-label">Most service calls</span><span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="sc_summary" data-field="busiest_calls" data-row="0" data-fmt="int">—</span><span class="rr-kpi-note" data-draw="num" data-source="sc_summary" data-field="busiest_account" data-row="0">—</span></div>
    <div class="rr-card" id="kpi-owner"><span class="rr-kpi-label">Owner concentration</span><span class="rr-kpi-value dash-skeleton"><span data-draw="num" data-source="sc_summary" data-field="top_owner_accounts" data-row="0" data-fmt="int">—</span> accounts</span><span class="rr-kpi-note" data-draw="num" data-source="sc_summary" data-field="top_owner" data-row="0">—</span></div>
  </div>
  <section class="rr-section" id="runway">
    <h2>Contract runway</h2>
    <p class="rr-sub">When each top account's contract ends. Left of the Today line means already expired. Dot size is monthly revenue.</p>
    <ul class="rr-legend" aria-hidden="true">
      <li><span class="rr-dot" style="background: var(--color-bad)"></span>Expired</li>
      <li><span class="rr-dot" style="background: var(--color-warn)"></span>Within 12 months</li>
      <li><span class="rr-dot" style="background: var(--cds-chart-muted)"></span>Active</li>
    </ul>
    <div class="rr-chart dash-skeleton" data-draw="runway" data-source="sc sc_accounts"></div>
  </section>
  <div class="rr-grid2">
    <section class="rr-section" id="service">
      <h2>Service load: calls per machine, last 12 months</h2>
      <p class="rr-sub">High numbers can mean failing equipment or an unhappy customer.</p>
      <div class="rr-bars dash-skeleton" data-draw="servicebars" data-source="sc_accounts"></div>
    </section>
    <section class="rr-section" id="owners">
      <h2>Who owns the top accounts</h2>
      <div class="rr-tablewrap"><table class="rr-table" data-source="sc_owners" data-row-key="owner">
        <thead><tr><th data-field="owner">Owner</th><th data-field="accounts" class="num">Accounts</th><th data-field="avg_monthly_revenue" class="num">Monthly revenue</th></tr></thead>
        <tbody data-draw="ownerrows"></tbody></table></div>
    </section>
  </div>
  <section class="rr-section" id="scorecard">
    <h2>Scorecard</h2>
    <p class="rr-sub">Click an account name for a full briefing below.</p>
    <div class="rr-tablewrap"><table class="rr-table" data-source="sc" data-row-key="account">
      <thead><tr><th data-field="rank">#</th><th data-field="account">Account</th><th data-field="owner">Owner</th><th data-field="branch">Branch</th><th data-field="avg_monthly_revenue" class="num">Monthly revenue</th><th data-field="contract_expiration">Contract ends</th><th data-field="machines" class="num">Machines</th><th data-field="ltm_service_calls" class="num">Service calls, 12 mo</th><th data-field="calls_per_machine" data-source="sc_accounts" class="num">Calls per machine</th></tr></thead>
      <tbody data-draw="scrows"></tbody></table></div>
    <p class="rr-msg" data-draw="scmsg"></p>
  </section>
  <section class="rr-section" id="agent-notes">
    <h2>What the CRM agent noticed</h2>
    <ul class="rr-brief" data-draw="notes" data-source="sc"></ul>
  </section>
  <section class="rr-section" id="briefing">
    <h2>Briefing: <span data-draw="briefname">—</span></h2>
    <p class="rr-sub">From the Coworker agent. Contact emails and phone numbers are hidden on this page. A briefing can take up to a minute.</p>
    <div class="rr-kpis" data-draw="briefkpis" data-source="brief"></div>
    <div class="rr-brief dash-skeleton" data-draw="brief" data-source="brief"></div>
  </section>
  <details class="rr-notes" id="method">
    <summary>How this page gets its data</summary>
    <ul>
      <li>The scorecard is one question to the CRM gateway's analytics agent: the top accounts by revenue with owner, branch, contract expiration, machine count and service calls over the last 12 months.</li>
      <li>Contract status, calls per machine and the owner totals are worked out on this page from that answer. Expired means the contract end date is before today.</li>
      <li>The agent writes its answer in natural language. The page reads the first table in it, so a reworded answer can leave a column empty until the next load.</li>
    </ul>
  </details>
</div>"""

sc_js = """<script>
const fN = document.querySelectorAll('#f-n');
fN.forEach((el) => el.addEventListener('change', () => dash.setParams({ n: Number(el.value) })));
dash.onData(() => { const p = dash.params(); fN.forEach((el) => { if (document.activeElement !== el) el.value = String(p.n ?? 10); }); });
const pick = (name) => { if (window.rr.SAFE_NAME.test(name)) dash.setParams({ account: name }); };
const statusOf = (name) => { const c = dash.data('sc_accounts'); return c.status === 'ok' ? (c.data.find((d) => d.account === name) || {}) : {}; };
const statusColor = (s) => (s === 'Expired' ? 'var(--color-bad)' : s === 'Within 12 months' ? 'var(--color-warn)' : 'var(--cds-chart-muted)');
dash.draw('runway', (el) => {
  const s = dash.data('sc');
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton'); el.replaceChildren();
  const rows = s.data.filter((d) => d.contract_expiration).map((d) => ({ ...d, dt: new Date(d.contract_expiration + 'T00:00:00Z'), st: statusOf(d.account).contract_status }))
    .sort((a, b) => a.dt - b.dt);
  if (!rows.length) { const p = document.createElement('p'); p.className = 'rr-msg'; p.textContent = 'No contract dates in this answer.'; el.append(p); return; }
  const today = new Date();
  const W = Math.max(280, el.clientWidth), rh = 26, m = { t: 8, r: 20, b: 30, l: Math.min(220, W * 0.42) };
  const H = m.t + m.b + rows.length * rh;
  const x = d3.scaleUtc().domain(d3.extent([...rows.map((d) => d.dt), today])).nice().range([m.l, W - m.r]);
  const r = d3.scaleSqrt().domain([0, d3.max(rows, (d) => d.avg_monthly_revenue) || 1]).range([3, 11]);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', 'Contract end dates for the top accounts, with today marked');
  svg.append('g').attr('class', 'rr-grid').selectAll('line').data(x.ticks(W < 480 ? 4 : 8)).join('line').attr('x1', (d) => x(d)).attr('x2', (d) => x(d)).attr('y1', m.t).attr('y2', H - m.b);
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(W < 480 ? 4 : 8).tickSizeOuter(0));
  svg.append('line').attr('class', 'rr-ref').attr('x1', x(today)).attr('x2', x(today)).attr('y1', m.t).attr('y2', H - m.b);
  svg.append('text').attr('class', 'rr-ref-label').attr('x', x(today) + 4).attr('y', m.t + 10).text('Today');
  const tip = d3.select(el).append('div').attr('class', 'rr-tip').style('display', 'none');
  const g = svg.append('g').selectAll('g').data(rows).join('g').attr('transform', (d, i) => `translate(0,${m.t + i * rh + rh / 2})`).style('cursor', 'pointer').on('click', (e, d) => pick(d.account));
  g.append('text').attr('class', 'rr-axis-label').attr('x', m.l - 8).attr('dy', '0.35em').attr('text-anchor', 'end').text((d) => d.account.length > 30 ? d.account.slice(0, 29) + '…' : d.account);
  g.append('line').attr('x1', m.l).attr('x2', (d) => x(d.dt)).style('stroke', 'var(--cds-chart-grid)');
  g.append('circle').attr('cx', (d) => x(d.dt)).attr('r', (d) => r(d.avg_monthly_revenue || 0)).style('fill', (d) => statusColor(d.st))
    .on('pointerenter pointermove', (event, d) => { const [px, py] = d3.pointer(event, el); tip.style('display', 'block').html('');
      tip.append('strong').text(d.account); tip.append('span').text(`Contract ends ${window.rr.date(d.contract_expiration)} · ${d.st || ''}`);
      tip.append('span').text(`${window.rr.money(d.avg_monthly_revenue)} a month · owner ${d.owner || '—'}`);
      tip.style('left', Math.min(Math.max(0, px + 12), el.clientWidth - 240) + 'px').style('top', Math.max(0, py - 60) + 'px'); })
    .on('pointerleave', () => tip.style('display', 'none'));
});
dash.draw('servicebars', (el) => {
  const c = dash.data('sc_accounts');
  if (c.status === 'loading') return;
  if (c.status !== 'ok') { window.rr.fail(el, c); return; }
  el.classList.remove('dash-skeleton');
  const rows = c.data.filter((d) => d.calls_per_machine != null).sort((a, b) => b.calls_per_machine - a.calls_per_machine);
  const top = rows.length ? rows[0].calls_per_machine : 0;
  window.rr.hbars(el, rows, { label: (d) => d.account.length > 26 ? d.account.slice(0, 25) + '…' : d.account, value: (d) => d.calls_per_machine, right: 50,
    color: (d) => (d.calls_per_machine >= 1.5 ? 'var(--color-warn)' : dash.colors[0]),
    valueText: (d) => d.calls_per_machine.toFixed(2), aria: 'Service calls per machine for each top account', onClick: (d) => pick(d.account), empty: 'No machine counts in this answer.' });
});
dash.draw('ownerrows', (el) => window.rr.tbody(el, 'sc_owners', 'owner', [{ f: 'owner' }, { f: 'accounts', fmt: 'int', num: true }, { f: 'avg_monthly_revenue', fmt: 'money', num: true }]));
dash.draw('scrows', (el) => window.rr.tbody(el, 'sc', 'account', [
  { f: 'rank', fmt: 'int' },
  { f: 'account', render: (td, d) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'rr-linkbtn'; b.textContent = d.account; b.disabled = !window.rr.SAFE_NAME.test(d.account); b.addEventListener('click', () => pick(d.account)); td.append(b);
      if (d.url && /^https:\\/\\//.test(d.url)) { const a = document.createElement('a'); a.href = d.url; a.target = '_blank'; a.rel = 'noopener'; a.className = 'rr-link rr-muted'; a.textContent = ' ↗'; a.setAttribute('aria-label', 'Open in Salesforce'); td.append(a); } } },
  { f: 'owner' }, { f: 'branch' }, { f: 'avg_monthly_revenue', fmt: 'money', num: true },
  { f: 'contract_expiration', render: (td, d) => { td.textContent = window.rr.date(d.contract_expiration); const st = statusOf(d.account).contract_status;
      if (st === 'Expired' || st === 'Within 12 months') { const p = document.createElement('span'); p.className = 'rr-pill ' + (st === 'Expired' ? 'rr-pill-High' : 'rr-pill-Elevated'); p.textContent = st === 'Expired' ? 'Expired' : 'Soon'; td.append(p); } } },
  { f: 'machines', fmt: 'int', num: true }, { f: 'ltm_service_calls', fmt: 'int', num: true },
  { f: 'calls_per_machine', num: true, render: (td, d) => { const v = statusOf(d.account).calls_per_machine; td.textContent = v == null ? '—' : v.toFixed(2); } }]));
dash.draw('scmsg', (el) => window.rr.msg(el, 'sc', 'The CRM agent returned no table this time. Reload to ask again.'));
dash.draw('notes', (el) => {
  const s = dash.data('sc'); el.replaceChildren();
  if (s.status !== 'ok' || !s.data.length) return;
  const notes = String(s.data[0].agent_notes || '').split('\\n').filter(Boolean);
  if (!notes.length) { const li = document.createElement('li'); li.className = 'rr-muted'; li.textContent = 'No observations this time.'; el.append(li); return; }
  notes.forEach((n) => { const li = document.createElement('li'); window.rr.inline(li, n, ''); el.append(li); });
});
</script>
<style>.rr-linkbtn { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; text-decoration: underline; text-decoration-color: var(--color-border-line); text-underline-offset: 2px; } .rr-linkbtn:hover { text-decoration-color: currentColor; } .rr-linkbtn:disabled { cursor: default; text-decoration: none; }</style>"""

# reuse the briefing drawings from the top-accounts page
BRIEF_DRAWS = top_js[top_js.index("dash.draw('briefname'"): top_js.index("</script>")]
sc_html = crm_page(sc_body, sc_js + "\n<script>\n" + BRIEF_DRAWS + "</script>", SC_LOADER + "\n" + BRIEF_LOADER + "\n" + SC_CALCS)
write("crm_exec", "https://claude.ai/artifact/C1Qy57MDHyPy9GcTxfiATF", {"title": "CRM Executive Scorecard"},
      {"n": 10, "account": "PURDUE UNIVERSITY"}, sc_ds, sc_html)

# ---------------------------------------------------------------- CRM Revenue by Branch (Laundry vs Air)
def branch_loader(id_, line):
    return """dash.loader('""" + id_ + """', { description: 'Reads the """ + line + """ branch table out of the CRM agent\\'s answer: branch, account count and average monthly commissionable revenue per account. Section header rows are skipped.', fn: ({ answer }) => {
    """ + CARD + """
    const t = tables.find((tb) => tb.head.some((h) => /branch/i.test(h))) || tables[0];
    if (!t) return { data: [], columns: [], truncated: false, meta };
    const col = (re) => t.head.findIndex((h) => re.test(h));
    const bi = Math.max(0, col(/branch/i)), ci = col(/count|accounts/i), ri = col(/revenue/i);
    const num = (s) => { const v = String(s || '').replace(/[*,$\\s]/g, ''); return /^-?\\d+(\\.\\d+)?$/.test(v) ? Number(v) : null; };
    const data = [];
    t.body.forEach((r) => { const b = link(r[bi] || ''); const n = ci >= 0 ? num(r[ci]) : null; if (n == null) return;
      data.push({ branch: b.text.replace(/\\*/g, '').trim(), account_count: n, avg_monthly_revenue: ri >= 0 ? num(r[ri]) : null }); });
    return { data, columns: ['branch', 'account_count', 'avg_monthly_revenue'], truncated: false, meta };
  } });"""

BR_CALCS = """dash.calc('laundry_est', { inputs: ['laundry'], title: 'Laundry: estimated monthly revenue by branch', description: 'Estimated total = account count × average monthly commissionable revenue per account.',
  fn: (laundry) => laundry.map((d) => ({ branch: d.branch, account_count: d.account_count, avg_monthly_revenue: d.avg_monthly_revenue,
    est_monthly_revenue: d.avg_monthly_revenue != null ? Math.round(d.account_count * d.avg_monthly_revenue) : null })).sort((a, b) => (b.est_monthly_revenue ?? -1) - (a.est_monthly_revenue ?? -1)) });
dash.calc('air_est', { inputs: ['air'], title: 'Air: estimated monthly revenue by branch', description: 'Estimated total = account count × average monthly commissionable revenue per account.',
  fn: (air) => air.map((d) => ({ branch: d.branch, account_count: d.account_count, avg_monthly_revenue: d.avg_monthly_revenue,
    est_monthly_revenue: d.avg_monthly_revenue != null ? Math.round(d.account_count * d.avg_monthly_revenue) : null })).sort((a, b) => (b.est_monthly_revenue ?? -1) - (a.est_monthly_revenue ?? -1)) });
dash.calc('lines', { inputs: ['laundry', 'air'], title: 'Business line totals', description: 'Per business line: branches, accounts, accounts with revenue, estimated monthly revenue (sum of account count × average) and the revenue-weighted average per account.',
  fn: (laundry, air) => [['Laundry', laundry], ['Air', air]].map(([line, rows]) => { const withRev = rows.filter((d) => d.avg_monthly_revenue != null);
    const est = withRev.reduce((s, d) => s + d.account_count * d.avg_monthly_revenue, 0); const acc = withRev.reduce((s, d) => s + d.account_count, 0);
    const top = withRev.slice().sort((a, b) => b.account_count * b.avg_monthly_revenue - a.account_count * a.avg_monthly_revenue)[0] || {};
    return { line, branches: rows.length, branches_with_revenue: withRev.length, accounts: rows.reduce((s, d) => s + d.account_count, 0), accounts_with_revenue: acc,
      est_monthly_revenue: Math.round(est), avg_per_account: acc ? Math.round(est / acc * 100) / 100 : null, top_branch: top.branch || null,
      top_branch_est: top.branch ? Math.round(top.account_count * top.avg_monthly_revenue) : null }; }) });"""

br_ds = {
 "laundry": gw("Laundry branches", "Route (laundry) accounts by Branch: account count and average monthly commissionable revenue per account, from the CRM agent.",
               "ask", "show account count and total average commissionable revenue by account Branch (Branch__c) for Route accounts, all branches"),
 "air": gw("Air branches", "Air record type accounts by Air Area Branch: account count and average monthly commissionable revenue per account, from the CRM agent.",
           "ask", "show account count and total average commissionable revenue by Air Area Branch (Air_Area_Branch__c) for Air record type accounts, all branches"),
}

br_body = """<div class="rr">
  <header class="rr-head" id="header">
    <h1 class="rr-title">CRM Revenue by Branch</h1>
    <p class="rr-lede" id="takeaway">Laundry brings in an estimated <b data-draw="num" data-source="lines" data-field="est_monthly_revenue" data-where="line=Laundry" data-fmt="money" class="dash-skeleton">—</b> a month across <b data-draw="num" data-source="lines" data-field="accounts" data-where="line=Laundry" data-fmt="int" class="dash-skeleton">—</b> accounts. Air brings in <b data-draw="num" data-source="lines" data-field="est_monthly_revenue" data-where="line=Air" data-fmt="money" class="dash-skeleton">—</b> across <b data-draw="num" data-source="lines" data-field="accounts" data-where="line=Air" data-fmt="int" class="dash-skeleton">—</b>.</p>
    <p class="rr-gov">Live from Salesforce through the CRM gateway, run as the person viewing. The two business lines have separate branch networks: Laundry accounts (record type Route) roll up to Branch, Air accounts (record type Air) to Air Area Branch.</p>
  </header>

  <div class="rr-kpis" id="lines">
    <div class="rr-card" id="kpi-laundry"><span class="rr-kpi-label">Laundry, estimated monthly revenue</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="lines" data-field="est_monthly_revenue" data-where="line=Laundry" data-fmt="money">—</span>
      <span class="rr-kpi-note"><span data-draw="num" data-source="lines" data-field="branches_with_revenue" data-where="line=Laundry" data-fmt="int">—</span> branches · <span data-draw="num" data-source="lines" data-field="avg_per_account" data-where="line=Laundry" data-fmt="money">—</span> per account</span></div>
    <div class="rr-card" id="kpi-air"><span class="rr-kpi-label">Air, estimated monthly revenue</span>
      <span class="rr-kpi-value dash-skeleton" data-draw="num" data-source="lines" data-field="est_monthly_revenue" data-where="line=Air" data-fmt="money">—</span>
      <span class="rr-kpi-note"><span data-draw="num" data-source="lines" data-field="branches_with_revenue" data-where="line=Air" data-fmt="int">—</span> branches · <span data-draw="num" data-source="lines" data-field="avg_per_account" data-where="line=Air" data-fmt="money">—</span> per account</span></div>
    <div class="rr-card" id="kpi-top-laundry"><span class="rr-kpi-label">Largest Laundry branch</span>
      <span class="rr-kpi-value dash-skeleton" style="font-size: var(--cds-font-size-heading)" data-draw="num" data-source="lines" data-field="top_branch" data-where="line=Laundry">—</span>
      <span class="rr-kpi-note"><span data-draw="num" data-source="lines" data-field="top_branch_est" data-where="line=Laundry" data-fmt="money">—</span> a month, estimated</span></div>
    <div class="rr-card" id="kpi-top-air"><span class="rr-kpi-label">Largest Air branch</span>
      <span class="rr-kpi-value dash-skeleton" style="font-size: var(--cds-font-size-heading)" data-draw="num" data-source="lines" data-field="top_branch" data-where="line=Air">—</span>
      <span class="rr-kpi-note"><span data-draw="num" data-source="lines" data-field="top_branch_est" data-where="line=Air" data-fmt="money">—</span> a month, estimated</span></div>
  </div>

  <div class="rr-filters" id="filters">
    <label>Business line<select class="dash-select" id="f-line" aria-label="Business line"><option value="laundry">Laundry</option><option value="air">Air</option></select></label>
  </div>

  <section class="rr-section" id="ranking">
    <h2 data-draw="rankhead">Estimated monthly revenue by branch</h2>
    <p class="rr-sub">Account count multiplied by average revenue per account. Top 20 branches.</p>
    <div class="rr-bars dash-skeleton" data-draw="branchbars" data-source="laundry_est air_est"></div>
  </section>

  <section class="rr-section" id="mix">
    <h2>Volume or value</h2>
    <p class="rr-sub">Each dot is a branch. Right means more accounts; up means more revenue per account. Dot size is estimated monthly revenue. Dashed lines are the line's averages.</p>
    <div class="rr-chart dash-skeleton" data-draw="mixchart" data-source="laundry_est air_est"></div>
  </section>

  <section class="rr-section" id="table">
    <h2>All branches</h2>
    <div class="rr-tablewrap" id="t-laundry"><table class="rr-table" data-source="laundry_est" data-row-key="branch">
      <thead><tr><th data-field="branch">Branch</th><th data-field="account_count" class="num">Accounts</th><th data-field="avg_monthly_revenue" class="num">Per account, monthly</th><th data-field="est_monthly_revenue" class="num">Estimated monthly total</th></tr></thead>
      <tbody data-draw="rows_laundry"></tbody></table></div>
    <div class="rr-tablewrap" id="t-air" hidden><table class="rr-table" data-source="air_est" data-row-key="branch">
      <thead><tr><th data-field="branch">Branch</th><th data-field="account_count" class="num">Accounts</th><th data-field="avg_monthly_revenue" class="num">Per account, monthly</th><th data-field="est_monthly_revenue" class="num">Estimated monthly total</th></tr></thead>
      <tbody data-draw="rows_air"></tbody></table></div>
    <p class="rr-msg" data-draw="norev"></p>
  </section>

  <details class="rr-notes" id="method">
    <summary>How this page gets its data</summary>
    <ul>
      <li>Laundry: Salesforce accounts with record type Route, grouped by the Branch lookup (Branch__c). Air: accounts with record type Air, grouped by Air Area Branch (Air_Area_Branch__c). Line of Business (Line_of_Business__c) is blank in Salesforce, so record type is the split.</li>
      <li>Revenue is Average Commissionable Revenue: each account's average gross monthly revenue over the last 90 days of collections. The CRM agent returns the average per account in each branch. The page estimates a branch total as accounts × that average.</li>
      <li>Branches the agent lists with no revenue (for example the Super Laundry branches) count toward accounts but not revenue, and are listed under the table.</li>
      <li>Branch fields on Opportunity are formulas and can't be grouped, so this page works from Account, not Opportunity.</li>
    </ul>
  </details>
</div>"""

br_js = """<script>
const fLine = document.querySelectorAll('#f-line');
fLine.forEach((el) => el.addEventListener('change', () => dash.setParams({ line: el.value })));
dash.onData(() => { const p = dash.params(); fLine.forEach((el) => { if (document.activeElement !== el) el.value = p.line || 'laundry'; });
  document.querySelectorAll('#t-laundry').forEach((t) => { t.hidden = p.line === 'air'; }); document.querySelectorAll('#t-air').forEach((t) => { t.hidden = p.line !== 'air'; }); });
const cur = () => (dash.params().line === 'air' ? 'air_est' : 'laundry_est');
const lineName = () => (dash.params().line === 'air' ? 'Air' : 'Laundry');
dash.draw('rankhead', (el) => { el.textContent = `${lineName()}: estimated monthly revenue by branch`; });
dash.draw('branchbars', (el) => {
  const s = dash.data(cur());
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton');
  const rows = s.data.filter((d) => d.est_monthly_revenue != null).slice(0, 20);
  window.rr.hbars(el, rows, { label: (d) => d.branch, value: (d) => d.est_monthly_revenue, right: 120,
    color: () => (dash.params().line === 'air' ? dash.colors[1] || dash.colors[0] : dash.colors[0]),
    valueText: (d) => `${window.rr.money(d.est_monthly_revenue)} · ${window.rr.int(d.account_count)} accts`, aria: `${lineName()} estimated monthly revenue by branch`, empty: 'The CRM agent returned no branches this time. Reload to ask again.' });
});
dash.draw('mixchart', (el) => {
  const s = dash.data(cur());
  if (s.status === 'loading') return;
  if (s.status !== 'ok') { window.rr.fail(el, s); return; }
  el.classList.remove('dash-skeleton'); el.replaceChildren();
  const rows = s.data.filter((d) => d.avg_monthly_revenue != null);
  if (!rows.length) { const p = document.createElement('p'); p.className = 'rr-msg'; p.textContent = 'No branches with revenue.'; el.append(p); return; }
  const W = Math.max(280, el.clientWidth), H = 340, m = { t: 14, r: 16, b: 40, l: 56 };
  const x = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.account_count) * 1.05]).nice().range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.avg_monthly_revenue) * 1.1]).nice().range([H - m.b, m.t]);
  const r = d3.scaleSqrt().domain([0, d3.max(rows, (d) => d.est_monthly_revenue) || 1]).range([3, 18]);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).attr('role', 'img').attr('aria-label', `${lineName()} branches by account count and revenue per account`);
  svg.append('g').attr('class', 'rr-grid').selectAll('line').data(y.ticks(5)).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(W < 480 ? 4 : 6).tickFormat(d3.format('~s')).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat((v) => '$' + d3.format('~s')(v)).tickSizeOuter(0));
  svg.append('text').attr('class', 'rr-axis-label').attr('x', (m.l + W - m.r) / 2).attr('y', H - 6).attr('text-anchor', 'middle').text('Accounts');
  const ax = d3.mean(rows, (d) => d.account_count), ay = d3.sum(rows, (d) => d.est_monthly_revenue) / d3.sum(rows, (d) => d.account_count);
  svg.append('line').attr('class', 'rr-ref').attr('x1', x(ax)).attr('x2', x(ax)).attr('y1', m.t).attr('y2', H - m.b);
  svg.append('line').attr('class', 'rr-ref').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(ay)).attr('y2', y(ay));
  const tip = d3.select(el).append('div').attr('class', 'rr-tip').style('display', 'none');
  const color = dash.params().line === 'air' ? (dash.colors[1] || dash.colors[0]) : dash.colors[0];
  svg.append('g').selectAll('circle').data(rows.slice().sort((a, b) => b.est_monthly_revenue - a.est_monthly_revenue)).join('circle')
    .attr('cx', (d) => x(d.account_count)).attr('cy', (d) => y(d.avg_monthly_revenue)).attr('r', (d) => r(d.est_monthly_revenue))
    .style('fill', color).style('fill-opacity', 0.5).style('stroke', color)
    .on('pointerenter pointermove', (event, d) => { const [px, py] = d3.pointer(event, el); tip.style('display', 'block').html('');
      tip.append('strong').text(d.branch); tip.append('span').text(`${window.rr.int(d.account_count)} accounts · ${window.rr.money(d.avg_monthly_revenue)} each a month`);
      tip.append('span').text(`About ${window.rr.money(d.est_monthly_revenue)} a month in total`);
      tip.style('left', Math.min(Math.max(0, px + 12), el.clientWidth - 240) + 'px').style('top', Math.max(0, py - 64) + 'px'); })
    .on('pointerleave', () => tip.style('display', 'none'));
  const lab = rows.slice().sort((a, b) => b.est_monthly_revenue - a.est_monthly_revenue).slice(0, W < 480 ? 3 : 6);
  svg.append('g').selectAll('text').data(lab).join('text').attr('class', 'rr-axis-label').attr('x', (d) => x(d.account_count) + r(d.est_monthly_revenue) + 3).attr('y', (d) => y(d.avg_monthly_revenue)).attr('dy', '0.35em').text((d) => d.branch);
});
['laundry', 'air'].forEach((k) => dash.draw('rows_' + k, (el) => window.rr.tbody(el, k + '_est', 'branch', [
  { f: 'branch' }, { f: 'account_count', fmt: 'int', num: true }, { f: 'avg_monthly_revenue', fmt: 'money', num: true }, { f: 'est_monthly_revenue', fmt: 'money', num: true }])));
dash.draw('norev', (el) => { const s = dash.data(cur()); if (s.status !== 'ok') { el.textContent = s.status === 'loading' ? 'Loading…' : ''; return; }
  const none = s.data.filter((d) => d.avg_monthly_revenue == null);
  el.textContent = none.length ? `No revenue recorded for ${none.length} branch${none.length > 1 ? 'es' : ''}: ${none.map((d) => d.branch).join(', ')}.` : ''; });
</script>"""

br_html = crm_page(br_body, br_js, branch_loader("laundry", "Laundry") + "\n" + branch_loader("air", "Air") + "\n" + BR_CALCS)
write("crm_branch", "https://claude.ai/artifact/N1Yu3MDQmHTaikZ48BL6wp", {"title": "CRM Revenue by Branch"}, {"line": "laundry"}, br_ds, br_html)
