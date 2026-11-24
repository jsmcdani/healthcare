/**
 * Routing Collision — the check against everything else.
 *
 * Routing in Coworker-style hosts is flat: everything that shares a parent sits
 * in one list, and the model picks by description. So the unit of competition
 * is the routing list (items with the same parentId), whatever their kind:
 * a Coworker skill competes with the agents Coworker can delegate to, and a
 * topic competes with any skill placed beside it.
 *
 * Checks:
 *   - identity: duplicate names in the same list
 *   - description overlap with siblings (block / warn thresholds)
 *   - overlap with items in other lists (one owner per domain)
 *   - simulated routing of the candidate's test prompts
 *   - whether adding the candidate takes prompts that used to land on a sibling
 *   - total description tokens in the list (the context bill)
 *
 * Lexical similarity is a pre-filter, not a verdict on how a model will route.
 * Pass `similarity(a, b)` to use embeddings, and keep live route tests.
 */

import { buildTfidf, routingTextOf, estimateTokens } from './text.js';

const parentOf = e => (e.parentId === undefined ? null : e.parentId);

/** Returns score(textA, textB) in [0, 1]. */
export function makeScorer(corpus, similarity) {
  if (typeof similarity === 'function') return (a, b) => similarity(a, b);
  const tfidf = buildTfidf(corpus);
  const cache = new Map();
  const vec = t => {
    if (!cache.has(t)) cache.set(t, tfidf.vectorize(t));
    return cache.get(t);
  };
  return (a, b) => tfidf.cosine(vec(a), vec(b));
}

/**
 * Rank a prompt against a routing list.
 * @returns {Array<{ id, score }>} best first; ties broken by id for determinism
 */
export function routePrompt(prompt, list, score, clauses) {
  return list
    .map(e => ({ id: e.id, score: score(prompt, routingTextOf(e, clauses)) }))
    .sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));
}

function finding(rule, severity, message, fix, extra = {}) {
  return { rule, severity, message, fix, ...extra };
}

const round = x => Math.round(x * 1000) / 1000;

/**
 * @param {object}   candidate  routable entry being created or changed
 * @param {object[]} catalog    every routable entry in the org (may include an older version of candidate)
 * @param {object}   policy     routing-governance policy pack
 * @param {object}   [opts]     { stage, similarity }
 */
export function checkCollisions(candidate, catalog, policy, opts = {}) {
  const stage = opts.stage || 'create';
  const promptSeverity = stage === 'share' ? 'error' : 'warning';
  const cfg = policy.collision;
  const clauses = policy.clauses;
  const findings = [];

  const others = catalog.filter(e => e.id !== candidate.id);
  const siblings = others.filter(e => parentOf(e) === parentOf(candidate));
  const nonSiblings = others.filter(e => parentOf(e) !== parentOf(candidate));

  const corpus = [candidate, ...others].map(e => routingTextOf(e, clauses));
  const score = makeScorer(corpus, opts.similarity);
  const candText = routingTextOf(candidate, clauses);

  // ---- identity -----------------------------------------------------------
  for (const e of others) {
    if (e.name && e.name === candidate.name) {
      const sameList = parentOf(e) === parentOf(candidate);
      findings.push(finding(sameList ? 'NAME_DUPLICATE' : 'NAME_REUSED', sameList ? 'error' : 'warning',
        sameList
          ? `Another item in the same list is already called "${e.name}".`
          : `"${e.name}" is already used elsewhere in this org. Names are labels, not identity, but reuse confuses people and logs.`,
        'Pick a name that is unique, ideally domain-verb-scope.',
        { related: [e.id] }));
    }
  }

  // ---- description overlap with siblings ----------------------------------
  let maxSiblingSimilarity = 0;
  for (const e of siblings) {
    const s = score(candText, routingTextOf(e, clauses));
    maxSiblingSimilarity = Math.max(maxSiblingSimilarity, s);
    if (s >= cfg.blockSimilarity) {
      findings.push(finding('DESC_COLLISION', 'error',
        `Description is too close to "${e.name}" (similarity ${round(s)}). The router will mix them up.`,
        `Merge the two, or make the difference explicit: different trigger words in "Use when", and a "Not for … use ${e.name}" clause.`,
        { related: [e.id], similarity: round(s) }));
    } else if (s >= cfg.warnSimilarity) {
      findings.push(finding('DESC_OVERLAP', 'warning',
        `Description overlaps with "${e.name}" (similarity ${round(s)}).`,
        `Add "Not for <their case>: use ${e.name}" and check the test prompts below route correctly.`,
        { related: [e.id], similarity: round(s) }));
    }
  }

  // ---- overlap across layers / lists --------------------------------------
  for (const e of nonSiblings) {
    const s = score(candText, routingTextOf(e, clauses));
    if (s >= cfg.crossLayerWarnSimilarity) {
      findings.push(finding('CROSS_LAYER_OVERLAP', 'warning',
        `Overlaps with "${e.name}" (${e.kind}) in another list (similarity ${round(s)}). Two layers claiming the same work means one answers when the other should.`,
        'Give the capability one owner. If the other item owns it, this one should route to it, not repeat it.',
        { related: [e.id], similarity: round(s) }));
    }
  }

  // ---- simulated routing --------------------------------------------------
  const listWith = [candidate, ...siblings];
  const should = candidate.triggers?.should || [];
  const shouldNot = candidate.triggers?.shouldNot || [];
  const routes = [];

  for (const p of should) {
    const ranked = routePrompt(p, listWith, score, clauses);
    const [top, second] = ranked;
    routes.push({ prompt: p, expected: candidate.id, actual: top?.score > 0 ? top.id : null });
    if (!top || top.score === 0) {
      findings.push(finding('PROMPT_NO_MATCH', promptSeverity,
        `Test prompt "${p}" shares no words with this description.`,
        'Put the words users actually type into the "Use when" clause.', { prompt: p }));
    } else if (top.id !== candidate.id) {
      const winner = listWith.find(e => e.id === top.id);
      findings.push(finding('PROMPT_ROUTES_ELSEWHERE', promptSeverity,
        `Test prompt "${p}" would go to "${winner.name}", not here.`,
        `Sharpen the "Use when" clause with this prompt's wording, or add "Not for" to "${winner.name}".`,
        { prompt: p, related: [top.id] }));
    } else if (second && top.score - second.score < cfg.nearTieMargin) {
      const runnerUp = listWith.find(e => e.id === second.id);
      findings.push(finding('PROMPT_NEAR_TIE', 'warning',
        `Test prompt "${p}" lands here only narrowly ahead of "${runnerUp.name}".`,
        'A near-tie routes inconsistently. Make the two descriptions differ on the words in this prompt.',
        { prompt: p, related: [second.id] }));
    }
  }

  for (const p of shouldNot) {
    const ranked = routePrompt(p, listWith, score, clauses);
    if (ranked[0]?.score > 0 && ranked[0].id === candidate.id) {
      findings.push(finding('PROMPT_FALSE_TRIGGER', promptSeverity,
        `Near-miss prompt "${p}" would land here, but it shouldn't.`,
        'Add this case to the "Not for" clause, naming the item it belongs to.',
        { prompt: p }));
    }
  }

  // ---- does adding the candidate move existing requests? -----------------
  for (const sib of siblings) {
    for (const p of sib.triggers?.should || []) {
      const before = routePrompt(p, siblings, score, clauses)[0];
      const after = routePrompt(p, listWith, score, clauses)[0];
      if (before?.id === sib.id && before.score > 0 && after?.id === candidate.id) {
        findings.push(finding('STEALS_EXISTING_PROMPT', 'error',
          `Adding this takes "${p}" away from "${sib.name}", where it routes today.`,
          `Add "Not for <that case>: use ${sib.name}" here, or narrow the "Use when" clause.`,
          { prompt: p, related: [sib.id] }));
      }
    }
  }

  // ---- context bill for this list -----------------------------------------
  const listTokens = listWith.reduce((n, e) => n + estimateTokens(e.description, policy.description.charsPerToken), 0);
  if (listTokens > cfg.catalogTokenBudgetPerList) {
    findings.push(finding('LIST_OVER_BUDGET', 'warning',
      `This list's descriptions total ~${listTokens} tokens, over the ${cfg.catalogTokenBudgetPerList}-token budget. All of it is in context on every turn.`,
      'Shorten descriptions, retire unused items, or split the list under topics so fewer items compete at once.'));
  }

  return {
    findings,
    routes,
    metrics: { siblingCount: siblings.length, maxSiblingSimilarity: round(maxSiblingSimilarity), listTokens }
  };
}
