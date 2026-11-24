#!/usr/bin/env node
/**
 * gateway-guard · PostToolUse (gateway tools) and UserPromptSubmit
 *
 *   UserPromptSubmit  → start a new turn: clear receipts and failures
 *   PostToolUse       → for gateway tools, record the receipt or the failure
 *
 * The Stop hook reads this per-turn state, so it never has to parse the
 * transcript file, whose format isn't a documented contract.
 */

import { readStdinJson, loadConfig, rx, isGatewayTool, readTurn, writeTurn, resetTurn, audit } from './lib.mjs';

try {
  const input = await readStdinJson();
  const sid = input.session_id;

  if (input.hook_event_name === 'UserPromptSubmit') {
    resetTurn(sid);
    process.exit(0);
  }

  const cfg = loadConfig(input.cwd);
  const tool = input.tool_name || '';
  if (!isGatewayTool(tool, cfg)) process.exit(0);

  const response = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '');
  const state = readTurn(sid);

  const receipts = [];
  for (const r of rx(cfg.receipts?.patterns)) {
    const g = new RegExp(r.source, 'gi');
    let m;
    while ((m = g.exec(response))) receipts.push(m[1] || m[0]);
  }

  const failed = /"is_?error"\s*:\s*true|"success"\s*:\s*false|"error"\s*:\s*"/i.test(response) && receipts.length === 0;
  if (receipts.length) state.receipts = [...new Set([...(state.receipts || []), ...receipts])];
  if (failed) state.failures = [...(state.failures || []), { tool, at: new Date().toISOString() }];
  writeTurn(sid, state);

  audit({ event: failed ? 'gateway_failure' : 'gateway_call', session: sid, agent: input.agent_type, tool, receipts });
} catch {
  // Recording is best effort. With nothing recorded the Stop hook treats the
  // turn as having no receipt, which errs on the side of asking for one.
}
process.exit(0);
