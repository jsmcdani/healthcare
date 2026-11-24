/**
 * Routing Lint — the creation-time check.
 *
 * Checks one routable item (orchestrator skill, agent, topic, skill, action)
 * on its own: name, description shape, routing clauses, vocabulary, scope and
 * test prompts. Every finding carries a plain-language `fix`, because the
 * person reading it is often a builder with no engineering background.
 *
 * Stages:
 *   'create' — missing test prompts are warnings, so drafting isn't blocked
 *   'share'  — missing test prompts are errors; nothing ships untested
 */

import { parseClauses, wordCount, estimateTokens } from './text.js';

function finding(rule, severity, message, fix, extra = {}) {
  return { rule, severity, message, fix, ...extra };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(lower, phrase) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`).test(lower);
}

/**
 * @param {object} entry   { id, name, kind, description, parentId, triggers: { should, shouldNot } }
 * @param {object} policy  routing-governance policy pack
 * @param {object} [opts]  { stage: 'create'|'share', catalog: entry[] }
 * @returns {{ findings: object[], metrics: object }}
 */
export function lintRoutable(entry, policy, opts = {}) {
  const stage = opts.stage || 'create';
  const catalog = opts.catalog || [];
  const findings = [];
  const name = String(entry?.name || '');
  const description = String(entry?.description || '');
  const kind = entry?.kind;

  // ---- kind -----------------------------------------------------------------
  if (!policy.kinds.includes(kind)) {
    findings.push(finding('KIND_UNKNOWN', 'error',
      `Kind "${kind}" is not one of: ${policy.kinds.join(', ')}.`,
      'Pick the kind that matches the job: topics route, skills hold know-how, actions execute.'));
  }

  // ---- name -----------------------------------------------------------------
  if (!new RegExp(policy.name.pattern).test(name) || name.length > policy.name.maxLength) {
    findings.push(finding('NAME_FORMAT', 'error',
      `Name "${name}" doesn't follow the naming rule.`,
      `Use ${policy.name.hint}, at most ${policy.name.maxLength} characters.`));
  }

  // ---- description length -------------------------------------------------
  const words = wordCount(description);
  const tokens = estimateTokens(description, policy.description.charsPerToken);
  if (words < policy.description.minWords) {
    findings.push(finding('DESC_TOO_SHORT', 'error',
      `Description has ${words} words; the router needs at least ${policy.description.minWords} to tell this apart from its neighbours.`,
      'Say what it does, when to use it in the user\'s own words, and what it is not for.'));
  }
  if (words > policy.description.maxWords || description.length > policy.description.maxChars) {
    findings.push(finding('DESC_TOO_LONG', 'warning',
      `Description is ${words} words (~${tokens} tokens). Every description is in context on every turn, so length here costs on every request.`,
      'Keep only the trigger and the not-for clause in the description. Move procedure and detail into the body, which loads only when picked.'));
  }

  // ---- routing clauses ----------------------------------------------------
  const { useWhen, notFor } = parseClauses(description, policy.clauses);
  if (!useWhen) {
    findings.push(finding('DESC_MISSING_USE_WHEN', 'error',
      'Description has no "Use when …" clause, so the router has to guess when this applies.',
      'Add "Use when <what the user actually says, in what context>."'));
  }
  if (!notFor && policy.clauses.requireNotFor.includes(kind)) {
    findings.push(finding('DESC_MISSING_NOT_FOR', 'error',
      'Description has no "Not for …" clause. Naming the closest neighbour separates the two better than a longer description does.',
      'Add "Not for <nearest similar case>: use <that item\'s name> instead."'));
  }
  if (notFor && catalog.length > 0) {
    const lowerNotFor = notFor.toLowerCase();
    const named = catalog.filter(c => c.id !== entry.id && c.name && containsPhrase(lowerNotFor, c.name.toLowerCase()));
    if (named.length === 0) {
      findings.push(finding('NOT_FOR_NO_NEIGHBOUR', 'warning',
        'The "Not for" clause doesn\'t name any existing item, so it can\'t steer requests anywhere.',
        'Name the item those requests should go to, by its exact name.'));
    }
  }

  // ---- vague vocabulary -----------------------------------------------------
  const lower = description.toLowerCase();
  const vague = policy.vagueTerms.filter(t => containsPhrase(lower, t));
  if (vague.length) {
    findings.push(finding('DESC_VAGUE_TERMS', 'warning',
      `Description uses vague wording (${vague.map(v => `"${v}"`).join(', ')}). Vague descriptions win requests they shouldn't.`,
      'Replace them with the specific task, record type or phrase a user would type.',
      { terms: vague }));
  }

  // ---- scope: one tier per description (not-for clause excluded) -----------
  const { routingText } = parseClauses(description, policy.clauses);
  const routingLower = routingText.toLowerCase();
  const scopesHit = Object.entries(policy.scopes)
    .filter(([, phrases]) => phrases.some(p => containsPhrase(routingLower, p)))
    .map(([scope]) => scope);
  if (scopesHit.length > 1) {
    findings.push(finding('DESC_MULTI_SCOPE', 'error',
      `Description claims more than one scope (${scopesHit.join(', ')}). A request for one scope can then land here for another.`,
      'Split it into one item per scope (e.g. …-my, …-team, …-org) and point each at the others in its "Not for" clause.',
      { scopes: scopesHit }));
  }

  // ---- structure: skills sit under topics ---------------------------------
  const structureSeverity = policy.structure?.skillsRequireTopicParent;
  if (kind === 'skill' && structureSeverity && structureSeverity !== 'off') {
    const parent = catalog.find(c => c.id === entry.parentId);
    if (!parent || parent.kind !== 'topic') {
      findings.push(finding('SKILL_NOT_UNDER_TOPIC', structureSeverity,
        'This skill is not attached to a topic, so it competes directly with topics in the agent\'s list.',
        'Attach it to the topic it supports. Topics route; skills hold the know-how for that topic.'));
    }
  }

  // ---- test prompts -------------------------------------------------------
  const should = entry?.triggers?.should || [];
  const shouldNot = entry?.triggers?.shouldNot || [];
  const promptSeverity = stage === 'share' ? 'error' : 'warning';
  if (should.length < policy.triggers.minShould) {
    findings.push(finding('TRIGGERS_SHOULD_TOO_FEW', promptSeverity,
      `${should.length} of ${policy.triggers.minShould} required "should trigger" prompts.`,
      'Add real phrasings a user would type that must land here.'));
  }
  if (shouldNot.length < policy.triggers.minShouldNot) {
    findings.push(finding('TRIGGERS_SHOULD_NOT_TOO_FEW', promptSeverity,
      `${shouldNot.length} of ${policy.triggers.minShouldNot} required "should not trigger" prompts.`,
      'Add near-misses: requests that sound similar but belong to a neighbour.'));
  }

  return {
    findings,
    metrics: { words, tokens, hasUseWhen: !!useWhen, hasNotFor: !!notFor, scopes: scopesHit }
  };
}
