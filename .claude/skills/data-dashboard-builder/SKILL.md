---
name: data-dashboard-builder
description: The house recipe for building live Claude Data dashboards on Databricks or the CRM gateway. It covers parameterized queries with safe filter rules, loaders that turn connector answers into rows, the shared look (cards, bubble and bar charts, ranked tables), the check loop, and the hand-over. Use whenever someone asks to "make it a dashboard", "make it live", or build a new dashboard, scorecard or radar, and when changing one of the dashboards listed below.
---

# Building a live dashboard, the house way

Every dashboard here is a **Claude Data** dashboard: an artifact whose numbers come from
live queries that run as each viewer. Six are built. Reuse them before making a new one.

## Existing dashboards

| Dashboard | URL | Source | Skill |
|---|---|---|---|
| Renewal Risk Radar | https://claude.ai/artifact/PsjNi32d96WNB1BKC83GTs | Databricks | `risk-radar` |
| Account 360 | https://claude.ai/artifact/KdhtLFHSbCG5ehKxwP22Fr | Databricks | `account-360` |
| Expansion Radar | https://claude.ai/artifact/D5GE7thnBMZjshkbBd4ktX | Databricks | `expansion-radar` |
| Pipeline Health | https://claude.ai/artifact/XTcXboGewENJooF3DThh6r | Databricks | `pipeline-health` |
| CRM Top Accounts | https://claude.ai/artifact/HETfVogcbMN4rMddCK77Lb | CRM gateway | `crm-top-accounts` |
| My CRM Pipeline | https://claude.ai/artifact/B8uPLH5zbyNGoTQvKc5a7C | CRM gateway | `crm-my-pipeline` |

## The kit (`kit/`)

| File | What it holds |
|---|---|
| `build.py` | Shared style (`shared.css.html`) and helpers (`shared.js.html`): money/percent/date formatters, a generic marked number (`data-draw="num"`), table body renderer, horizontal bars, risk pills. Also `ds()` to make a Databricks dataset (it keeps only the rules a query uses), `page()` to assemble a page, and `write()` to emit the batch documents plus test SQL with default filters filled in. |
| `build_pages.py` | Account 360, Expansion Radar and Pipeline Health: SQL, page HTML and drawing code. |
| `build_crm.py` | The two CRM dashboards: gateway datasets, card-parsing loaders (tables, briefings, scores) and a safe Markdown renderer. |
| `risk-radar/` | The Risk Radar's SQL and page. |
| `test_loaders.js` | Runs the CRM loaders against sample gateway answers in node. |

Run `python3 build.py` (Databricks pages) or `python3 build_crm.py` (CRM pages) from `kit/`.
Each writes `<name>/batch.json`, which holds the documents to write with `ArtifactData` `batch`.

## Recipe

1. **Metrics first.** Take the definitions from `trifecta-metrics` (Databricks) or
   `crm-gateway` (CRM). Never invent a formula on the page. Arithmetic goes in the query,
   so readers can check it in Sources.
2. **Anchor time on the data.** For the Databricks snapshot, use `asof = max(case.CreatedDate)`,
   not `current_date()`. Show "Data as of" in the header and a stale banner after 2 days.
3. **One query per number family.** For example: a ranked list (`LIMIT 500`), a one-row
   summary, and a breakdown. Every dataset reuses the same CTEs, so their numbers agree.
4. **Filters.** Use a `{{name}}` in the query with the tightest rule that works:
   - segment and region: `enum` that includes `""` for "all", written as
     `('{{segment}}' = '' OR col = '{{segment}}')`
   - windows: `{"type": "number", "minimum": 1, "maximum": 365}`
   - ids: `pattern`
   - names: a `pattern` without quotes

   Put defaults in `dash/params`.
5. **Loaders.**
   - Databricks: `read.databricks(answer)`.
   - CRM gateway: parse the Markdown card inside the loader. The loader must be
     self-contained; copy the `CARD` block from `build_crm.py`.
   - Loaders only reshape. Scrub emails and phone numbers out of briefings.
6. **Page.**
   - Start with `<meta name="dash-one-writer">`.
   - Headline sentence with marked numbers, then a row of figure cards, then a chart and
     a breakdown, then a ranked table (`data-source` + `data-row-key` on the `<table>`,
     `data-field` on each `<th>`), then a "How it works" fold-out.
   - Scripts only listen and set `value` or `hidden` outside drawings; everything the
     data decides is a `dash.draw`.
   - Colours: `--color-bad` for High, `--color-warn` for Elevated, muted for Watch.
     Nothing else is alarm-coloured.
   - Clicks set filters: a region bar filters the page, an account opens its briefing.
7. **Write and check.** Write `ArtifactData` `batch` to the dashboard's `url`, then read
   `data/users/me` (`check`, `runs`, `page`):
   - `still_loading` usually means the viewer hasn't approved the connector yet. Run
     the read-only queries yourself with default filters to validate them.
   - Fix whatever `failed` or `runs` names.
8. **Hand over.** Tell the user:
   - what the page shows and what you assumed
   - that each query runs with the viewer's own access, or the sharer's if they choose
     "Your access" in Sources
   - that pages are private until shared
   - that rows can be downloaded as CSV from Sources
   - that charts and controls can be requested by name

## Don'ts
- No writes in a dataset. Gateway "proposals" are never stored or run from a page.
- Never use `innerHTML` with data. Use `textContent`, or `rr.inline` for agent Markdown.
  Only `https://` links.
- Don't copy rows into the store or browser storage.
