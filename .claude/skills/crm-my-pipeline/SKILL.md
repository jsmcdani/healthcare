---
name: crm-my-pipeline
description: The signed-in rep's own Salesforce pipeline from the live CRM: health score and rating, top issues, forecast reliability, percent past due, and open opportunities. Use for "my pipeline", "my deals", "how's my forecast", "review my pipeline", or /crm-my-pipeline.
---

# My CRM Pipeline

**Load `crm-gateway` first.** All calls go to `pipeline_my`, which only ever covers the
**signed-in rep's own** deals.

Live dashboard: https://claude.ai/artifact/B8uPLH5zbyNGoTQvKc5a7C. Each rep who opens it
sees their own pipeline.

## Quick answer (in chat)
Make three calls and combine them:
1. `what's my pipeline health score`: score out of 100, rating (Critical / Fair / Good …), top issues
2. `How reliable is my forecast?`: reliability rating and % of open pipeline past due
3. `Show my open opportunities`: table of name, stage, amount, close date

Lead with the score and the single biggest issue. Then list open deals, with past-due
ones flagged (close date before today). End with the agent's suggested next questions.

## Guardrails
- Don't widen the scope. "My team" or "the org" is a different role and tool. If the
  user asks for it, say it isn't available to this persona.
- "Clean up my past-due opps" **changes records**. The gateway returns a proposal.
  Show the proposal and let the user confirm it themselves. Never confirm it for them,
  and never wire it into a dashboard.
