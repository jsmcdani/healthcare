const fs = require('fs'); const L = {}, C = {};
const dash = { loader: (id, o) => { L[id] = o.fn; }, calc: (id, o) => { C[id] = o.fn; } };
const html = fs.readFileSync('crm_branch/index.html', 'utf8'); const re = /<script>([\s\S]*?)<\/script>/g; let m;
while ((m = re.exec(html))) if (m[1].includes('dash.loader(')) new Function('dash', m[1])(dash);
const lau = "Here's the full breakdown:\n\n| Branch | Account Count | Avg Commissionable Revenue |\n|---|---|---|\n| Balt/Wash | 2,563 | $1,609.38 |\n| So. California | 5,584 | $717.83 |\n| New York East (21) | 278 | $348.04 |\n| **Branches with no avg revenue data** | | |\n| Super Laundry Indianapolis | 2 | — |\n| *(No branch assigned)* | 1 | — |\n\nA few highlights.";
const air = "Only 16.\n\n| # | Air Area Branch | Account Count | Avg Commissionable Revenue |\n|---|---|---|---|\n| 1 | [Mountain South (Phoenix)](/lightning/r/Account/a0AUH0000057RTd2AM/view) | 2,810 | $467.26 |\n| 11 | [Atlantic Central (Balt/Wash)](/lightning/r/Account/a0AUH000004MfqD2AS/view) | 7,755 | $318.06 |\n";
(async () => {
  const l = await L.laundry({ answer: JSON.stringify({ answer: lau }) }); const a = await L.air({ answer: JSON.stringify({ answer: air }) });
  console.log(JSON.stringify(l.data)); console.log(JSON.stringify(a.data));
  console.log(JSON.stringify(C.laundry_est(l.data))); console.log(JSON.stringify(C.lines(l.data, a.data)));
})();
