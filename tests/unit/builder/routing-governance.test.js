import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  lintRoutable,
  checkCollisions,
  governRoutable,
  auditCatalog,
  loadRoutingPolicy,
  parseClauses
} from '../../../src/healthcare/builder/routing/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { catalog } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../fixtures/routing-catalog.json'), 'utf-8')
);
const policy = loadRoutingPolicy();
const rules = res => res.findings.map(f => f.rule);
const byName = name => catalog.find(e => e.name === name);

describe('parseClauses', () => {
  test('separates use-when and not-for, and drops not-for from routing text', () => {
    const c = parseClauses(
      'Reviews deals. Use when a rep asks about my deals. Not for team views: use pipeline-review-team.',
      policy.clauses
    );
    expect(c.useWhen).toBe('a rep asks about my deals.');
    expect(c.notFor).toMatch(/team views: use pipeline-review-team/);
    expect(c.routingText).not.toMatch(/pipeline-review-team/);
  });

  test('returns nulls when clauses are missing', () => {
    const c = parseClauses('Does pipeline things.', policy.clauses);
    expect(c.useWhen).toBeNull();
    expect(c.notFor).toBeNull();
  });
});

describe('lintRoutable (creation-time check)', () => {
  test('a well-formed catalog item has no lint errors', () => {
    const res = lintRoutable(byName('pipeline-review-team'), policy, { stage: 'share', catalog });
    expect(res.findings.filter(f => f.severity === 'error')).toEqual([]);
    expect(res.metrics.hasUseWhen).toBe(true);
    expect(res.metrics.hasNotFor).toBe(true);
  });

  test('catches the typical vibe-built skill', () => {
    const vibe = {
      id: 'v1', name: 'Pipeline Helper', kind: 'orchestrator_skill', parentId: null,
      description: 'Helps with anything about pipeline and deals, various things.'
    };
    const r = rules(lintRoutable(vibe, policy));
    expect(r).toEqual(expect.arrayContaining([
      'NAME_FORMAT', 'DESC_TOO_SHORT', 'DESC_MISSING_USE_WHEN', 'DESC_MISSING_NOT_FOR', 'DESC_VAGUE_TERMS'
    ]));
  });

  test('every finding tells the builder how to fix it', () => {
    const res = lintRoutable({ id: 'x', name: 'X', kind: 'skill', description: 'stuff' }, policy);
    for (const f of res.findings) expect(f.fix).toEqual(expect.any(String));
  });

  test('flags a description that claims two scopes', () => {
    const e = {
      ...byName('pipeline-review-my'), id: 'ms',
      description: 'Reviews pipeline for my own deals and for my team as a manager rollup. Use when a rep or manager asks about pipeline coverage. Not for briefs: use account-brief-my.'
    };
    expect(rules(lintRoutable(e, policy))).toContain('DESC_MULTI_SCOPE');
  });

  test('a scope named only in the not-for clause does not count', () => {
    expect(rules(lintRoutable(byName('pipeline-review-my'), policy))).not.toContain('DESC_MULTI_SCOPE');
  });

  test('warns on long descriptions because they cost every turn', () => {
    const long = { ...byName('pipeline-review-my'), id: 'l', description: byName('pipeline-review-my').description + ' Extra detail.'.repeat(30) };
    expect(rules(lintRoutable(long, policy))).toContain('DESC_TOO_LONG');
  });

  test('missing test prompts warn at create and block at share', () => {
    const e = { ...byName('pipeline-review-my'), triggers: undefined };
    const create = lintRoutable(e, policy, { stage: 'create' }).findings.find(f => f.rule === 'TRIGGERS_SHOULD_TOO_FEW');
    const share = lintRoutable(e, policy, { stage: 'share' }).findings.find(f => f.rule === 'TRIGGERS_SHOULD_TOO_FEW');
    expect(create.severity).toBe('warning');
    expect(share.severity).toBe('error');
  });

  test('warns when a not-for clause names nothing that exists', () => {
    const e = { ...byName('pipeline-review-my'), id: 'n', description: byName('pipeline-review-my').description.replace('pipeline-review-team', 'the manager thing') };
    expect(rules(lintRoutable(e, policy, { catalog }))).toContain('NOT_FOR_NO_NEIGHBOUR');
  });

  test('a skill placed beside topics, not under one, is flagged', () => {
    const loose = { ...byName('close-won-checklist'), id: 'loose', parentId: 'ag-sales' };
    const f = lintRoutable(loose, policy, { catalog }).findings.find(x => x.rule === 'SKILL_NOT_UNDER_TOPIC');
    expect(f.severity).toBe(policy.structure.skillsRequireTopicParent);
  });
});

describe('checkCollisions', () => {
  const thief = {
    id: 'new-deal-review', name: 'deal-review-my', kind: 'orchestrator_skill', parentId: null,
    description: 'Reviews my deals, close dates and my own pipeline for a rep. Use when a rep asks to review my deals and close dates or my own pipeline. Not for account briefs: use account-brief-my.',
    triggers: { should: ['review my deals', 'check my close dates', 'my own pipeline'], shouldNot: ['brief me on Acme', 'team pipeline'] }
  };

  test('blocks a near-duplicate of an existing sibling', () => {
    const res = checkCollisions(thief, catalog, policy);
    const hit = res.findings.find(f => f.rule === 'DESC_COLLISION');
    expect(hit).toBeDefined();
    expect(hit.related).toContain('sk-pipe-my');
    expect(hit.severity).toBe('error');
  });

  test('detects that a new item takes prompts away from an existing one', () => {
    const steals = checkCollisions(thief, catalog, policy).findings.filter(f => f.rule === 'STEALS_EXISTING_PROMPT');
    expect(steals.length).toBeGreaterThan(0);
    expect(steals.every(f => f.related.includes('sk-pipe-my'))).toBe(true);
  });

  test('blocks a duplicate name in the same list', () => {
    const dup = { ...byName('activity-logging'), id: 'dup' };
    expect(rules(checkCollisions(dup, catalog, policy))).toContain('NAME_DUPLICATE');
  });

  test('items in different lists do not compete as siblings', () => {
    const res = checkCollisions(byName('stage-change-playbook'), catalog, policy);
    expect(res.metrics.siblingCount).toBe(1);
    expect(rules(res)).not.toContain('DESC_COLLISION');
  });

  test('flags overlap across layers: one owner per domain', () => {
    const shadow = {
      id: 'shadow', name: 'stage-move-helper', kind: 'orchestrator_skill', parentId: null,
      description: 'Procedure for moving an opportunity between stages: exit criteria per stage, required fields, confirmation format. Use when a deal is being moved to a new stage. Not for account briefs: use account-brief-my.',
      triggers: { should: [], shouldNot: [] }
    };
    const f = checkCollisions(shadow, catalog, policy).findings.find(x => x.rule === 'CROSS_LAYER_OVERLAP');
    expect(f).toBeDefined();
    expect(f.related).toContain('sk-stage-playbook');
  });

  test('a test prompt that lands on a neighbour is reported with the winner', () => {
    const e = { ...byName('account-brief-my'), triggers: { should: ['how is my own pipeline looking'], shouldNot: [] } };
    const f = checkCollisions(e, catalog, policy, { stage: 'share' }).findings.find(x => x.rule === 'PROMPT_ROUTES_ELSEWHERE');
    expect(f.related).toContain('sk-pipe-my');
    expect(f.severity).toBe('error');
  });

  test('a near-miss prompt that lands here is a false trigger', () => {
    const e = { ...byName('pipeline-review-my'), triggers: { should: [], shouldNot: ['review my deals and close dates'] } };
    expect(rules(checkCollisions(e, catalog, policy))).toContain('PROMPT_FALSE_TRIGGER');
  });

  test('warns when a list goes over its description token budget', () => {
    const tight = { ...policy, collision: { ...policy.collision, catalogTokenBudgetPerList: 100 } };
    expect(rules(checkCollisions(byName('pipeline-review-my'), catalog, tight))).toContain('LIST_OVER_BUDGET');
  });

  test('accepts a custom similarity function (e.g. embeddings)', () => {
    const always = () => 0.99;
    const res = checkCollisions(byName('sales-agent'), catalog, policy, { similarity: always });
    expect(rules(res)).toContain('DESC_COLLISION');
  });
});

describe('governRoutable (the gate)', () => {
  test('a clean item passes or warns, never blocks', () => {
    const r = governRoutable({ candidate: byName('opportunity-updates'), catalog, stage: 'share' });
    expect(r.verdict).toBe('pass');
    expect(r.errors).toBe(0);
  });

  test('a vibe-built item is blocked', () => {
    const r = governRoutable({
      candidate: { id: 'v', name: 'Helper', kind: 'skill', parentId: 'tp-opp-updates', description: 'Helps with various deal stuff.' },
      catalog
    });
    expect(r.verdict).toBe('block');
    expect(r.errors).toBeGreaterThan(0);
  });

  test('reports the policy version it was judged against', () => {
    const r = governRoutable({ candidate: byName('sales-agent'), catalog });
    expect(r.policyVersion).toBe(policy.version);
  });

  test('is deterministic', () => {
    const a = governRoutable({ candidate: byName('pipeline-review-team'), catalog });
    const b = governRoutable({ candidate: byName('pipeline-review-team'), catalog });
    expect(a).toEqual(b);
  });

  test('requires a candidate', () => {
    expect(() => governRoutable({ catalog })).toThrow('candidate is required');
  });
});

describe('auditCatalog', () => {
  test('the sample catalog routes every test prompt to its owner', () => {
    const a = auditCatalog({ catalog });
    expect(a.routing.rate).toBe(1);
    expect(a.misroutes).toEqual([]);
  });

  test('groups items into routing lists by parent', () => {
    const a = auditCatalog({ catalog });
    const root = a.lists.find(l => l.parentId === null);
    expect(root.size).toBe(4);
    expect(a.lists.find(l => l.parentId === 'tp-opp-updates').parentName).toBe('opportunity-updates');
  });

  test('surfaces the my/team scope pair as the closest siblings', () => {
    const [top] = auditCatalog({ catalog }).pairs;
    expect([top.a, top.b].sort()).toEqual(['pipeline-review-my', 'pipeline-review-team']);
  });

  test('builds a confusion table and records misroutes', () => {
    const broken = catalog.map(e => e.name === 'stage-change-playbook'
      ? { ...e, description: 'Exit criteria per stage and required fields for opportunities. Use when exit criteria or required fields are needed. Not for close-won paperwork: use close-won-checklist.' }
      : e);
    const a = auditCatalog({ catalog: broken });
    expect(a.routing.rate).toBeLessThan(1);
    expect(a.misroutes.some(m => m.expected === 'stage-change-playbook')).toBe(true);
    expect(a.confusion['stage-change-playbook']).toBeDefined();
  });
});
