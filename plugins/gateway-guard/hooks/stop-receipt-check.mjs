#!/usr/bin/env node
/**
 * gateway-guard · Stop
 *
 * Before the turn ends: if the answer states org data (record IDs, record
 * fields with values, "according to the org") and no gateway call in this turn
 * returned a receipt, send the model back to either call the gateway or say it
 * doesn't have the data. Catches both a bypass and a fabricated answer after a
 * failed call.
 *
 * Fires once per answer: when stop_hook_active is set, the model is already
 * continuing because of this hook, so it is let go (and the miss is audited).
 */

import { readStdinJson, loadConfig, rx, firstMatch, readTurn, audit, fill } from './lib.mjs';

try {
  const input = await readStdinJson();
  const cfg = loadConfig(input.cwd);
  const text = String(input.last_assistant_message || '');
  const signal = firstMatch(rx(cfg.receipts?.claimPatterns), text);
  if (!signal) process.exit(0);

  const state = readTurn(input.session_id);
  if ((state.receipts || []).length > 0) process.exit(0);

  if (input.stop_hook_active) {
    audit({ event: 'unreceipted_claim_released', session: input.session_id, signal: signal.match });
    process.exit(0);
  }

  const failures = (state.failures || []).length;
  const reason = fill(cfg.receipts.blockMessage, {
    signal: `"${signal.match}"`,
    gateway: (cfg.gatewayToolPrefixes || []).map(p => `${p}*`).join(', '),
    failure: failures ? ` (${failures} gateway call${failures > 1 ? 's' : ''} failed this turn)` : ''
  });
  audit({ event: 'unreceipted_claim_blocked', session: input.session_id, signal: signal.match, failures });
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
} catch {
  // A broken Stop hook must not trap the session; the PreToolUse guard is the hard control.
}
process.exit(0);
