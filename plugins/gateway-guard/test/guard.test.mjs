// Run: node --test plugins/gateway-guard/test
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-work-'));
const ENV = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_DATA: DATA, CLAUDE_PROJECT_DIR: WORK };

function run(script, payload, env = {}) {
  const r = spawnSync('node', [path.join(ROOT, 'hooks', script)], {
    input: JSON.stringify(payload), env: { ...ENV, ...env }, encoding: 'utf-8'
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const pre = (tool_name, tool_input, extra = {}) =>
  run('pretooluse-guard.mjs', { session_id: 's1', hook_event_name: 'PreToolUse', cwd: WORK, tool_name, tool_input, ...extra });
const denied = out => out?.hookSpecificOutput?.permissionDecision === 'deny';

describe('PreToolUse: blocks direct org access', () => {
  const blocked = [
    ['Bash', { command: 'sf data query -q "SELECT Id FROM Account" -o prod' }],
    ['Bash', { command: 'cd x && npx sf org display' }],
    ['Bash', { command: 'sfdx force:data:soql:query -q "SELECT Id FROM Lead"' }],
    ['Bash', { command: 'sf project deploy start -d force-app' }],
    ['Bash', { command: 'env SF_LOG_LEVEL=debug sf org list' }],
    ['Bash', { command: 'curl https://acme.my.salesforce.com/services/data/v61.0/query' }],
    ['Bash', { command: 'python -c "import simple_salesforce"' }],
    ['Bash', { command: 'node -e "require(\'jsforce\')"' }],
    ['Bash', { command: 'cat ~/.sfdx/alias.json' }],
    ['Bash', { command: 'python -c "import os; os.system(\'sf data query -q x\')"' }],
    ['Bash', { command: 'export TOKEN=$SF_ACCESS_TOKEN' }],
    ['WebFetch', { url: 'https://acme.lightning.force.com/lightning/r/Account/001/view', prompt: 'read' }],
    ['Read', { file_path: '/home/me/.sf/sf-config.json' }],
    ['Write', { file_path: `${WORK}/pull.js`, content: "const jsforce = require('jsforce');" }],
    ['Edit', { file_path: `${WORK}/pull.py`, old_string: 'x', new_string: 'url = "https://acme.my.salesforce.com"' }],
    ['mcp__salesforce__run_soql_query', { query: 'SELECT Id FROM Account' }],
    ['mcp__fetch__get', { url: 'https://acme.my.salesforce.com/services/data' }]
  ];
  for (const [tool, ti] of blocked) {
    test(`${tool}: ${JSON.stringify(ti).slice(0, 70)}`, () => {
      const out = pre(tool, ti);
      assert.ok(denied(out), `expected deny for ${tool}`);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /gateway/);
    });
  }

  test('catches "write the script, then run it"', () => {
    const file = path.join(WORK, 'export.py');
    fs.writeFileSync(file, 'import requests\nrequests.get("https://acme.my.salesforce.com/services/data")\n');
    const out = pre('Bash', { command: 'python3 export.py' });
    assert.ok(denied(out));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /export\.py/);
  });

  test('the model cannot loosen its own guard or settings', () => {
    assert.ok(denied(pre('Write', { file_path: `${WORK}/.claude/gateway-guard.json`, content: '{"allowPathPrefixes":["/"]}' })));
    assert.ok(denied(pre('Edit', { file_path: `${WORK}/.claude/settings.local.json`, old_string: 'a', new_string: 'b' })));
    assert.ok(denied(pre('Bash', { command: `echo '{}' > ${WORK}/.claude/gateway-guard.json` })));
    assert.ok(denied(pre('Bash', { command: "sed -i 's/deny/allow/' .claude/settings.json" })));
    assert.equal(pre('Bash', { command: 'cat .claude/gateway-guard.json' }), null);
  });

  test('the deny message tells the model where to go and not to improvise', () => {
    const reason = pre('Bash', { command: 'sf org list' }).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /mcp__gateway__\*/);
    assert.match(reason, /Do not try another route/);
  });

  test('denials are written to the audit log', () => {
    pre('Bash', { command: 'sf org list' });
    const log = fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf-8');
    assert.match(log, /"event":"deny"/);
  });
});

describe('PreToolUse: leaves normal work alone', () => {
  const allowed = [
    ['Bash', { command: 'git status && npm test' }],
    ['Bash', { command: 'ls -la sfx/ && echo surf' }],
    ['Bash', { command: 'python3 gen.py' }],
    ['WebFetch', { url: 'https://code.claude.com/docs/en/hooks', prompt: 'read' }],
    ['Write', { file_path: `${WORK}/README.md`, content: 'Org access goes through acme.my.salesforce.com via the gateway.' }],
    ['Read', { file_path: `${WORK}/src/index.js` }],
    ['mcp__gateway__query_records', { object: 'Account' }],
    ['mcp__github__get_file_contents', { path: 'x' }]
  ];
  for (const [tool, ti] of allowed) {
    test(`${tool}: ${JSON.stringify(ti).slice(0, 70)}`, () => {
      assert.equal(pre(tool, ti), null);
    });
  }

  test('allowlist mode blocks unlisted MCP tools', () => {
    const cfgFile = path.join(WORK, 'strict.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ mcp: { mode: 'allowlist', allowedMcpPrefixes: ['mcp__github__'] } }));
    const env = { GATEWAY_GUARD_CONFIG: cfgFile };
    const p = (tool) => run('pretooluse-guard.mjs', { session_id: 's1', cwd: WORK, tool_name: tool, tool_input: {} }, env);
    assert.ok(denied(p('mcp__slack__send_message')));
    assert.equal(p('mcp__github__get_file_contents'), null);
    assert.equal(p('mcp__gateway__query_records'), null);
  });

  test('project override sets the gateway prefix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-proj-'));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'gateway-guard.json'),
      JSON.stringify({ gatewayToolPrefixes: ['mcp__plugin_acme_gw__'] }));
    const out = run('pretooluse-guard.mjs',
      { session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'sf org list' } },
      { CLAUDE_PROJECT_DIR: dir });
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /mcp__plugin_acme_gw__\*/);
  });

  test('fails closed when the config is broken', () => {
    const bad = path.join(WORK, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    const out = run('pretooluse-guard.mjs',
      { session_id: 's1', cwd: WORK, tool_name: 'Bash', tool_input: { command: 'ls' } },
      { GATEWAY_GUARD_CONFIG: bad });
    assert.ok(denied(out));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /could not evaluate/);
  });
});

describe('Receipts: Stop hook', () => {
  const SID = 'turn-test';
  const prompt = () => run('record-gateway-result.mjs', { session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  const post = (tool, tool_response) =>
    run('record-gateway-result.mjs', { session_id: SID, hook_event_name: 'PostToolUse', cwd: WORK, tool_name: tool, tool_input: {}, tool_response });
  const stop = (msg, active = false) =>
    run('stop-receipt-check.mjs', { session_id: SID, hook_event_name: 'Stop', cwd: WORK, stop_hook_active: active, last_assistant_message: msg });

  const CLAIM = 'Acme (001Ak00000Xyz12AAB) has opportunity 006Ak00000Abc34 at stage Negotiation for $120,000.';

  before(() => prompt());

  test('blocks an answer with org data and no receipt', () => {
    prompt();
    const out = stop(CLAIM);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /no gateway call in this turn returned a receipt/);
  });

  test('lets the same answer through once the gateway returned a receipt', () => {
    prompt();
    post('mcp__gateway__query_records', { records: [], receipt: 'gw_9f3a21bc' });
    assert.equal(stop(CLAIM), null);
  });

  test('a receipt from a non-gateway tool does not count', () => {
    prompt();
    post('mcp__other__thing', { receipt: 'gw_forged123' });
    assert.equal(stop(CLAIM).decision, 'block');
  });

  test('receipts do not carry over to the next turn', () => {
    prompt();
    post('mcp__gateway__query_records', { receipt: 'gw_aaaaaa11' });
    prompt();
    assert.equal(stop(CLAIM).decision, 'block');
  });

  test('names the failure when the gateway errored this turn', () => {
    prompt();
    post('mcp__gateway__query_records', { success: false, error: 'upstream timeout' });
    assert.match(stop(CLAIM).reason, /1 gateway call failed this turn/);
  });

  test('answers without org data pass', () => {
    prompt();
    assert.equal(stop('I updated the README and the tests pass.'), null);
  });

  test('does not loop: releases on stop_hook_active and audits it', () => {
    prompt();
    assert.equal(stop(CLAIM, true), null);
    assert.match(fs.readFileSync(path.join(DATA, 'audit.jsonl'), 'utf-8'), /unreceipted_claim_released/);
  });
});
