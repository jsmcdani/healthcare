---
name: crm-revenue-by-branch
description: Revenue by branch from the live Salesforce CRM, always split into the two business lines, Laundry (record type Route, grouped by Branch__c) and Air (record type Air, grouped by Air_Area_Branch__c). Use for "revenue by branch", "which branches make the most", "branch performance", "Laundry vs Air", "Air regions", or /crm-revenue-by-branch [laundry|air].
---

# CRM Revenue by Branch (Laundry and Air)

**Load `crm-gateway` first.**

Live dashboard: https://claude.ai/artifact/N1Yu3MDQmHTaikZ48BL6wp

## The two business lines. Never mix them.

| | Laundry | Air |
|---|---|---|
| How to tell | Account record type **Route** | Account record type **Air** |
| Branch field | `Branch__c` (lookup to `Branch__c`). Name: `Branch_Name_Text__c`, ID: `CSC_Branch_ID__c` | `Air_Area_Branch__c` (lookup). Name: `Air_Area_Branch_Name__c` |
| Branch network | ~49 metro branches (Balt/Wash, So. California …), plus "Super Laundry" locations with no revenue | ~15 regions (Great Lakes (Columbus), Carolinas (Charlotte) …) |
| Typical revenue per account | ~$900 a month | ~$350 a month |

`Line_of_Business__c` exists but is **blank**, so use the record type to separate the lines.

## Metadata learned (Nov 2026)
- **Opportunity branch fields are formulas** (`Branch_Name__c`, `Account_Branch_Site_ID__c`), so the CRM can't group by them. Always group at the **Account** level.
- **Revenue field:** Average Commissionable Revenue, the account's average gross monthly revenue over 90 days of collections. Opportunities carry a copy (`Account_Avg_Comm_Revenue__c`). **Never average it across opportunities**: that double-counts accounts.
- The `Branch__c` object also has sales-plan fields, but they're empty.
- Other useful Account fields: `Branch_Manager_Name__c`, `Branch_EVP__c`, `Miles_From_Branch__c`, `Branch_Mismatch__c`.

## Questions that work (send to `ask` word for word)
- Laundry: `show account count and total average commissionable revenue by account Branch (Branch__c) for Route accounts, all branches`
- Air: `show account count and total average commissionable revenue by Air Area Branch (Air_Area_Branch__c) for Air record type accounts, all branches`

The agent returns **average revenue per account** and the **account count** for each branch.
Estimated branch total = count × average. Always label it **estimated**.

## Phrasing traps
- Don't say "sum", "grouped", "rollup" or "metadata": the router sends those to the warehouse,
  which isn't connected, and you get a refusal. Say "show … by …".
- For field metadata, ask `coworker_search` to "find the record for <account> and list its
  <topic> fields with their API names and values". That works.

## Chat answer
Report each line on its own:
1. Estimated monthly revenue, account count, and average per account.
2. The top 5 branches by estimated revenue.
3. Volume vs value: branches with many accounts but low revenue per account, and the reverse.
4. Branches with no revenue recorded.

## Ask the gateway team for
A governed "revenue by branch" tool that returns `records` with the true total
(SUM of account revenue) per branch and line. That would replace the estimate.
