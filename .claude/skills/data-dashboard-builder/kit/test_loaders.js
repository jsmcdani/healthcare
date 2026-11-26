const fs = require('fs');
const loaders = {};
global.dash = { loader: (id, o) => { loaders[id] = o.fn; } };
for (const f of ['crm_top/index.html', 'crm_pipe/index.html']) {
  const html = fs.readFileSync(f, 'utf8'); const re = /<script>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) if (m[1].includes('dash.loader(')) new Function('dash', m[1])(global.dash);
}
const top = { title: 'Ask · Salesforce CRM', runs_as: 'X', persona: 'sales_rep', ask: 'top 20 accounts by revenue', instance_url: 'https://cscsw.my.salesforce.com',
  answer: "Here are your **top 20 accounts by Average Commissionable Revenue** (avg gross monthly revenue based on 90-day collection history):\n\n| # | Account | Avg Commissionable Revenue | Commissionable Revenue |\n|---|---------|---------------------------|----------------------|\n| 1 | [PURDUE UNIVERSITY](/lightning/r/Account/00160000010vjOrAAI/view) | $258,992 | $776,976 |\n| 2 | [PACIFIC LUTHERAN UNIVERSITY](/lightning/r/Account/00160000014xupzAAA/view) | $253,215 | $759,645 |\n| 3 | [UNIVERSITY OF PITTSBURGH #1](/lightning/r/Account/0016000000aGcCAAA0/view) | $192,883 | $578,649 |\n\nThe list is heavily dominated by **universities and colleges** (14 of the top 20), with a few residential apartment communities rounding it out.\n\nWant me to break these down?\n\n_Routed to: CRM (Coworker), run-as you._\n\n_⚡ Governed · run-as you — queried server-side._" };
const brief = { title: 'Coworker · Search', ask: 'brief me on PURDUE UNIVERSITY', instance_url: 'https://cscsw.my.salesforce.com',
  answer: "Here's your full briefing on **[PURDUE UNIVERSITY](/lightning/r/Account/00160000010vjOrAAI/view)** — a major active account.\n\n---\n\n## 🎓 Executive Summary\n\n- **Account Owner:** Trina | **Record Type:** Route\n\n---\n\n## 📊 Account Metrics\n\n| Metric | Value |\n|---|---|\n| **Machine Count** | 709 |\n| **LTM Total Revenue** | $1,634,139.54 |\n| **Contract Expiration** | **June 30, 2029** |\n\n## 👥 Contacts\n\n- **[Dave Hardy](/lightning/r/Contact/003UH00000phtFBYAY/view)** — Senior Buyer | dghardy@purdue.edu | (765) 494-2487 *(most active)*\n\nWant me to dig deeper?" };
const health = { ask: "what's my pipeline health score", instance_url: 'https://cscsw.my.salesforce.com', next_steps: [{ label: 'How reliable is my forecast?' }, { label: 'Clean up my past-due opps' }],
  answer: "Your pipeline health score is 38 (Critical). The biggest issue is past-due close dates on key opportunities.\n\n## Pipeline Health: 38/100\n**Score:** 38/100 — Critical\n_Scope: Your pipeline_\n\n**Top issues**\n- Melissa Test  Opp - past-due close date (12/11/2023)\n- Test - past-due close date (12/12/2023)" };
const opps = { ask: 'Show my open opportunities', answer: "Here are your current open opportunities.\n\n**Opportunities** — 2 total · $39,221\n\n| Name | Stage | Amount | Close |\n| --- | --- | --- | --- |\n| Melissa Test  Opp | Custom Proposal | $39,221 | 2023-12-11 |\n| Test | Signed Contract | $0 | 2023-12-12 |" };
const fc = { answer: "Forecast Reliability: Unreliable. 100% of your open pipeline is past due. Would you like to clean up your past-due opps?\n\n## Forecast Reliability: Unreliable\n% past due: 100" };
(async () => {
  for (const [id, a] of [['top', top], ['brief', brief], ['health', health], ['opps', opps], ['forecast', fc]]) {
    const r = await loaders[id]({ answer: JSON.stringify(a) });
    console.log('==', id, JSON.stringify(r.data, null, 0).slice(-420));
  }
})();
