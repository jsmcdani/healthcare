const fs = require('fs'); const L = {}, C = {};
const dash = { loader: (id, o) => { L[id] = o.fn; }, calc: (id, o) => { C[id] = o.fn; } };
const html = fs.readFileSync('crm_exec/index.html', 'utf8'); const re = /<script>([\s\S]*?)<\/script>/g; let m;
while ((m = re.exec(html))) if (m[1].includes('dash.loader(')) new Function('dash', m[1])(dash);
const md = "Here are your **top 10 accounts** — note. A couple of things to flag: Pacific Lutheran.\n\n| # | Account | Owner | Branch | Avg Monthly Revenue | Contract Expiration | Total Machines | LTM Service Calls |\n|---|---------|-------|--------|-------------------|-------------------|---------------|------------------|\n| 1 | [PURDUE UNIVERSITY](/lightning/r/Account/00160000010vjOrAAI/view) | Trina Morimanno | Indianapolis | $258,992 | Jun 30, 2029 | 709 | 869 |\n| 2 | [PACIFIC LUTHERAN UNIVERSITY](/lightning/r/Account/00160000014xupzAAA/view) | Jill Young | Seattle | $253,215 | Jan 1, 2024 ⚠️ | 118 | 4 |\n| 6 | [UNIVERSITY OF FLORIDA](/lightning/r/Account/0016000000yI1u1AAC/view) | Stephen Duncan | Orlando | $143,785 | Jun 30, 2028 | 590 | 1,088 |\n| 9 | [SAVANNAH COLLEGE ART & DESIGN-SAVANNAH](/lightning/r/Account/00160000010vq4mAAA/view) | Stephen Duncan | Atlanta | $98,054 | Aug 31, 2027 | 521 | 666 |\n| 10 | [PARK TERRACE GARDENS](/lightning/r/Account/00160000013EZ7TAAW/view) | Richard Busby | New York West (73) | $92,550 | Jun 20, 2020 ⚠️ | 0 | — |\n\nA few quick observations:\n- **Stephen Duncan** owns 3 of the top 10 accounts (UF, Boston College, SCAD)\n- **3 contracts are expired** (Pacific Lutheran, Peter Cooper Village, Park Terrace Gardens)\n\n_Routed to: CRM (Coworker), run-as you._";
(async () => {
  const r = await L.sc({ answer: JSON.stringify({ answer: md, instance_url: 'https://cscsw.my.salesforce.com' }) });
  console.log(r.data.map((d) => [d.account, d.owner, d.branch, d.avg_monthly_revenue, d.contract_expiration, d.machines, d.ltm_service_calls].join(' | ')).join('\n'));
  console.log('notes:', JSON.stringify(r.data[0].agent_notes));
  console.log('accounts:', JSON.stringify(C.sc_accounts(r.data)));
  console.log('summary:', JSON.stringify(C.sc_summary(r.data)));
  console.log('owners:', JSON.stringify(C.sc_owners(r.data)));
})();
