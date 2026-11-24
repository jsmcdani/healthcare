/**
 * Shared helpers for gateway-guard hooks. No dependencies.
 *
 * Hook contract (Claude Code): JSON on stdin; for PreToolUse, a deny is JSON on
 * stdout with hookSpecificOutput.permissionDecision = "deny"; for Stop, a block
 * is {"decision":"block","reason":...}. Exit 0 with no output means "no opinion".
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

/** Plugin defaults, then project override, then GATEWAY_GUARD_CONFIG. */
export function loadConfig(cwd) {
  let cfg = readJson(path.join(PLUGIN_ROOT, 'guard.config.json'));
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const projectFile = projectDir && path.join(projectDir, '.claude', 'gateway-guard.json');
  if (projectFile && fs.existsSync(projectFile)) cfg = merge(cfg, readJson(projectFile));
  if (process.env.GATEWAY_GUARD_CONFIG) cfg = merge(cfg, readJson(process.env.GATEWAY_GUARD_CONFIG));
  return cfg;
}

export const rx = list => (list || []).map(s => new RegExp(s, 'i'));
export const firstMatch = (regexes, text) => {
  for (const r of regexes) {
    const m = r.exec(text);
    if (m) return { pattern: r.source, match: m[0].trim().slice(0, 80) };
  }
  return null;
};

export function isGatewayTool(name, cfg) {
  return (cfg.gatewayToolPrefixes || []).some(p => name.startsWith(p));
}

export function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'gateway-guard');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one JSON line to the audit log. Never throws. */
export function audit(event) {
  try {
    fs.appendFileSync(path.join(dataDir(), 'audit.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch { /* audit must not break the session */ }
}

// ---- per-turn state: receipts and gateway failures ------------------------

const safe = s => String(s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
const stateFile = sessionId => path.join(dataDir(), `turn-${safe(sessionId)}.json`);

export function readTurn(sessionId) {
  try { return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf-8')); }
  catch { return { receipts: [], failures: [], denied: [] }; }
}

export function writeTurn(sessionId, state) {
  fs.writeFileSync(stateFile(sessionId), JSON.stringify(state));
}

export function resetTurn(sessionId) {
  writeTurn(sessionId, { receipts: [], failures: [], denied: [], startedAt: new Date().toISOString() });
}

export function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
