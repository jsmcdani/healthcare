const fs = require('fs'); const L = {}, C = {};
const dash = { loader: (id, o) => { L[id] = o.fn; }, calc: (id, o) => { C[id] = o.fn; } };
const html = fs.readFileSync('trifecta/index.html', 'utf8'); const re = /<script>([\s\S]*?)<\/script>/g; let m;
while ((m = re.exec(html))) if (m[1].includes('dash.loader(')) new Function('dash', m[1])(dash);
const crm = { title: 'Ask · Salesforce CRM', ask: 'top 10', routed: ['crm'], instance_url: 'https://cscsw--full.sandbox.my.salesforce.com', answer: 'Here are the **top 10**:\n\n| x |',
  table: { columns: [{ key: 'col', label: '#' }, { key: 'account', label: 'Account' }, { key: 'avg_commissionable_revenue' }, { key: 'commissionable_revenue' }], rows: [[1, 'PACIFIC LUTHERAN UNIVERSITY', 253215, 759645], [2, 'PURDUE UNIVERSITY', 225792, 677376]], ids: ['/lightning/r/Account/00160000014xupzAAA/view', '/lightning/r/Account/00160000010vjOrAAI/view'] } };
const itsm = { title: 'Ask · ServiceNow ITSM', routed: ['itsm'], answer: 'No incidents matched that filter. Try a different chip below.\n\n_Routed to: ServiceNow_', table: null };
(async () => { const c = await L.crm({ answer: JSON.stringify(crm) }); const i = await L.itsm({ answer: JSON.stringify(itsm) });
  console.log(JSON.stringify(c.data)); console.log(JSON.stringify(i)); console.log(JSON.stringify(C.join_check(c.data, i.data, []))); })();
