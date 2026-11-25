#!/usr/bin/env node
/**
 * gateway-guard · PreToolUse
 *
 * Runs before every matching tool call, in the main session and in subagents.
 * Denies any call that would reach the Salesforce org other than through the
 * gateway's MCP tools, and tells the model where to go instead.
 *
 * Covers: Bash (CLI, hosts, tokens, client libraries, credential stores, and
 * the contents of local scripts it runs), WebFetch (hosts), Write/Edit/
 * MultiEdit/NotebookEdit (scripts that would call the org), Read/Grep/Glob
 * (CLI credential stores), and MCP tools other than the gateway.
 *
 * Fails closed: if the guard itself errors, the call is denied with the error.
 */

import fs from 'fs';
import path from 'path';
import { readStdinJson, loadConfig, rx, firstMatch, isGatewayTool, audit, readTurn, writeTurn, fill } from './lib.mjs';

function deny(reason, cfg, input) {
  const gateway = (cfg?.gatewayToolPrefixes || []).map(p => `${p}*`).join(', ') || 'the gateway tools';
  const message = cfg?.denyMessage ? fill(cfg.denyMessage, { reason, gateway }) : `Blocked by gateway-guard: ${reason}`;
  audit({ event: 'deny', session: input?.session_id, agent: input?.agent_type, tool: input?.tool_name, reason });
  try {
    if (input?.session_id) {
      const s = readTurn(input.session_id);
      s.denied = [...(s.denied || []), { tool: input.tool_name, reason }];
      writeTurn(input.session_id, s);
    }
  } catch { /* state is best effort */ }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message }
  }));
  process.exit(0);
}

const allow = () => process.exit(0); // no opinion: normal permission flow continues

function underAllowedPath(file, cfg) {
  return file && (cfg.allowPathPrefixes || []).some(p => path.resolve(file).startsWith(path.resolve(p)));
}

/** Org-reaching signals in arbitrary text. Returns a reason or null. */
function scanText(text, cfg, { cli = true } = {}) {
  const lower = String(text || '').toLowerCase();
  let hit;
  if (cli && (hit = firstMatch(rx(cfg.cliPatterns), lower))) return `Salesforce CLI call (${hit.match})`;
  if ((hit = firstMatch(rx(cfg.salesforceHosts), lower))) return `direct Salesforce host (${hit.match})`;
  if ((hit = firstMatch(rx(cfg.tokenPatterns), lower))) return 'Salesforce credential or token';
  if ((hit = firstMatch(rx(cfg.credentialPaths), lower))) return `Salesforce CLI credential store (${hit.match})`;
  const lib = (cfg.clientLibraries || []).find(l => new RegExp(`(^|[^a-z0-9_@/-])${l.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([^a-z0-9_-]|$)`, 'i').test(lower));
  if (lib) return `Salesforce client library (${lib})`;
  return null;
}

const isScript = (file, cfg) => (cfg.scriptExtensions || []).includes(path.extname(String(file || '')).toLowerCase());

/** Local script files a shell command runs; scanned so "write it, then run it" is caught. */
function scriptsRunBy(command, cwd, cfg) {
  const found = [];
  for (const tok of String(command).split(/[\s;&|()<>`'"]+/)) {
    if (!tok || !isScript(tok, cfg)) continue;
    const p = path.resolve(cwd || process.cwd(), tok.replace(/^~(?=\/)/, process.env.HOME || '~'));
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size <= (cfg.maxScriptBytes || 1048576)) found.push(p);
    } catch { /* not a local file */ }
  }
  return found;
}

/**
 * The guard's own config and Claude Code settings are off limits to the model:
 * an agent that can edit its guard can loosen it, and a reported failure mode
 * is an agent using a control's own escape hatch.
 */
const PROTECTED = [
  /gateway-guard\.json/i,
  /guard\.config\.json/i,
  /gateway-guard[\\/](hooks|\.claude-plugin)/i,
  /\.claude[\\/]settings(\.local)?\.json/i,
  /managed-settings\.json/i
];
const protectedHit = text => PROTECTED.find(r => r.test(String(text || '')));

function check(input, cfg) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};

  // ---- the guard protects itself ------------------------------------------
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && protectedHit(ti.file_path || ti.notebook_path)) {
    return 'changing the guard or Claude Code settings; ask the user to make this change';
  }
  if (tool === 'Bash' && protectedHit(ti.command) && /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\bchmod\b|\bln\b|writefile|open\()/i.test(ti.command)) {
    return 'changing the guard or Claude Code settings from the shell; ask the user to make this change';
  }

  // ---- MCP ----------------------------------------------------------------
  if (tool.startsWith('mcp__')) {
    if (isGatewayTool(tool, cfg)) return null;
    if (cfg.mcp?.mode === 'allowlist' && !(cfg.mcp.allowedMcpPrefixes || []).some(p => tool.startsWith(p))) {
      return `MCP tool ${tool} is not on the allowlist`;
    }
    const nameHit = firstMatch(rx(cfg.mcp?.orgToolNamePatterns), tool);
    if (nameHit) return `non-gateway MCP tool that reaches the org (${tool})`;
    const r = scanText(JSON.stringify(ti), cfg, { cli: false });
    return r ? `${r} via MCP tool ${tool}` : null;
  }

  switch (tool) {
    case 'Bash': {
      const cmd = String(ti.command || '');
      const r = scanText(cmd, cfg);
      if (r) return r;
      for (const file of scriptsRunBy(cmd, input.cwd, cfg)) {
        if (underAllowedPath(file, cfg)) continue;
        const r2 = scanText(fs.readFileSync(file, 'utf-8'), cfg);
        if (r2) return `${r2} inside ${path.basename(file)}, which this command runs`;
      }
      return null;
    }
    case 'WebFetch': {
      const r = firstMatch(rx(cfg.salesforceHosts), String(ti.url || '').toLowerCase());
      return r ? `fetching a Salesforce URL directly (${r.match})` : null;
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = ti.file_path || ti.notebook_path || '';
      if (underAllowedPath(file, cfg)) return null;
      if (!isScript(file, cfg) && tool !== 'NotebookEdit') return null; // docs may mention the org; scripts may not call it
      const r = scanText(JSON.stringify(ti), cfg);
      return r ? `writing a script that would reach the org: ${r}` : null;
    }
    case 'Read':
    case 'Grep':
    case 'Glob': {
      const target = [ti.file_path, ti.path, ti.pattern].filter(Boolean).join(' ').toLowerCase();
      const r = firstMatch(rx(cfg.credentialPaths), target);
      return r ? `reading the Salesforce CLI credential store (${r.match})` : null;
    }
    default:
      return null;
  }
}

let input = {};
let cfg = null;
try {
  input = await readStdinJson();
  cfg = loadConfig(input.cwd);
  const reason = check(input, cfg);
  if (reason) deny(reason, cfg, input);
  allow();
} catch (err) {
  deny(`gateway-guard could not evaluate this call (${err.message}); fix the guard config`, cfg, input);
}
