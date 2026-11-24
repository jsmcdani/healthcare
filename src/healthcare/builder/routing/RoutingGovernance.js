/**
 * Routing Governance — the gate a builder passes before saving or sharing a
 * routable item, and an audit for an existing catalog.
 *
 * Verdicts:
 *   block — at least one error; the item is not saved/shared
 *   warn  — saves, but the builder sees what to fix
 *   pass  — nothing found
 *
 * Policy is pack-driven (packs/policy/routing-governance.policy.json); pass a
 * policy object to override per org.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lintRoutable } from './RoutingLint.js';
import { checkCollisions, makeScorer, routePrompt } from './RoutingCollision.js';
import { routingTextOf, estimateTokens } from './text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = path.join(__dirname, '../../packs/policy/routing-governance.policy.json');

let cachedPolicy = null;

export function loadRoutingPolicy(policyPath = DEFAULT_POLICY_PATH) {
  if (policyPath === DEFAULT_POLICY_PATH && cachedPolicy) return cachedPolicy;
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
  if (policyPath === DEFAULT_POLICY_PATH) cachedPolicy = policy;
  return policy;
}

function verdictOf(findings) {
  if (findings.some(f => f.severity === 'error')) return 'block';
  if (findings.length > 0) return 'warn';
  return 'pass';
}

/**
 * Run both checks on one item.
 * @param {object} args { candidate, catalog = [], stage = 'create', policy, similarity }
 */
export function governRoutable({ candidate, catalog = [], stage = 'create', policy, similarity } = {}) {
  if (!candidate) throw new Error('candidate is required');
  const pol = policy || loadRoutingPolicy();
  const lint = lintRoutable(candidate, pol, { stage, catalog });
  const collisions = checkCollisions(candidate, catalog, pol, { stage, similarity });
  const findings = [...lint.findings, ...collisions.findings];
  return {
    verdict: verdictOf(findings),
    stage,
    policyVersion: pol.version,
    candidate: { id: candidate.id, name: candidate.name, kind: candidate.kind, parentId: candidate.parentId ?? null },
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    findings,
    routes: collisions.routes,
    metrics: { ...lint.metrics, ...collisions.metrics }
  };
}

/**
 * Audit a whole catalog: every routing list, every sibling pair, every test
 * prompt routed within its list. Use it on an existing skill set before
 * turning the gate on, and in CI after any change.
 */
export function auditCatalog({ catalog = [], policy, similarity } = {}) {
  const pol = policy || loadRoutingPolicy();
  const clauses = pol.clauses;
  const cfg = pol.collision;
  const byId = new Map(catalog.map(e => [e.id, e]));
  const score = makeScorer(catalog.map(e => routingTextOf(e, clauses)), similarity);

  const groups = new Map();
  for (const e of catalog) {
    const key = e.parentId ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const lists = [];
  const pairs = [];
  const misroutes = [];
  const confusion = {};
  let prompts = 0;
  let correct = 0;

  for (const [parentId, list] of groups) {
    const tokens = list.reduce((n, e) => n + estimateTokens(e.description, pol.description.charsPerToken), 0);
    lists.push({
      parentId,
      parentName: parentId ? byId.get(parentId)?.name ?? null : null,
      size: list.length,
      tokens,
      overBudget: tokens > cfg.catalogTokenBudgetPerList
    });

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = score(routingTextOf(list[i], clauses), routingTextOf(list[j], clauses));
        if (s >= cfg.warnSimilarity) {
          pairs.push({
            a: list[i].name, b: list[j].name, parentId,
            similarity: Math.round(s * 1000) / 1000,
            severity: s >= cfg.blockSimilarity ? 'error' : 'warning'
          });
        }
      }
    }

    for (const e of list) {
      for (const p of e.triggers?.should || []) {
        prompts++;
        const top = routePrompt(p, list, score, clauses)[0];
        const actual = top && top.score > 0 ? byId.get(top.id).name : null;
        confusion[e.name] ??= {};
        confusion[e.name][actual ?? '(no match)'] = (confusion[e.name][actual ?? '(no match)'] || 0) + 1;
        if (actual === e.name) correct++;
        else misroutes.push({ prompt: p, expected: e.name, actual, kind: 'should' });
      }
      for (const p of e.triggers?.shouldNot || []) {
        const top = routePrompt(p, list, score, clauses)[0];
        if (top && top.score > 0 && top.id === e.id) {
          misroutes.push({ prompt: p, expected: `not ${e.name}`, actual: e.name, kind: 'shouldNot' });
        }
      }
    }
  }

  pairs.sort((x, y) => y.similarity - x.similarity);
  return {
    policyVersion: pol.version,
    items: catalog.length,
    lists,
    pairs,
    misroutes,
    confusion,
    routing: { prompts, correct, rate: prompts ? Math.round((correct / prompts) * 1000) / 1000 : null }
  };
}
