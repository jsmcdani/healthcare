/**
 * Routing Governance Tools for Healthcare Builder Agent
 *
 * Gate every routable item (orchestrator skill, agent, topic, skill, action)
 * before it is saved or shared, and audit an existing catalog. Checks are
 * deterministic; no model is called. See docs/ROUTING_GOVERNANCE.md.
 *
 * The catalog comes from `input.catalog` when given, otherwise from the
 * `routables` collection for the org.
 */

import { governRoutable, auditCatalog, lintRoutable, loadRoutingPolicy } from '../routing/index.js';

const routableSchema = {
  type: 'object',
  description: 'A routable item',
  properties: {
    id: { type: 'string', description: 'Stable identifier' },
    name: { type: 'string', description: 'Name, lowercase-hyphenated (domain-verb-scope)' },
    kind: { type: 'string', enum: ['orchestrator_skill', 'agent', 'topic', 'skill', 'action'] },
    description: { type: 'string', description: 'What it does, "Use when …", "Not for … use <name>"' },
    parentId: { type: ['string', 'null'], description: 'Item whose routing list this sits in; null for the orchestrator\'s own list' },
    triggers: {
      type: 'object',
      properties: {
        should: { type: 'array', items: { type: 'string' }, description: 'Prompts that must land here' },
        shouldNot: { type: 'array', items: { type: 'string' }, description: 'Near-miss prompts that must not land here' }
      }
    }
  },
  required: ['id', 'name', 'kind', 'description']
};

async function loadCatalog(orchestrator, input) {
  if (Array.isArray(input.catalog)) return input.catalog;
  const db = orchestrator?.arango?.db;
  if (!db) return [];
  const col = db.collection('routables');
  if (!(await col.exists())) return [];
  const cursor = await db.query({
    query: 'FOR r IN routables FILTER r.orgId == @orgId RETURN r',
    bindVars: { orgId: input._orgId || input.orgId || null }
  });
  return cursor.all();
}

export const routingGovernanceTools = [
  {
    name: 'check_routable_description',
    description: 'Check one skill, topic, agent or action description against the routing rules (use-when, not-for, length, scope, vague wording). Fast; needs no catalog.',
    input_schema: {
      type: 'object',
      properties: {
        item: routableSchema,
        stage: { type: 'string', enum: ['create', 'share'], description: 'share makes missing test prompts an error' }
      },
      required: ['item']
    },
    handler: async (orchestrator, input) => {
      try {
        const policy = loadRoutingPolicy();
        const res = lintRoutable(input.item, policy, { stage: input.stage || 'create' });
        return { success: true, policyVersion: policy.version, ...res };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'gate_routable',
    description: 'Run the full pre-save or pre-share gate on an item: description rules plus collisions with every other item, simulated routing of its test prompts, and whether it takes prompts away from existing items. Returns pass, warn or block.',
    input_schema: {
      type: 'object',
      properties: {
        item: routableSchema,
        stage: { type: 'string', enum: ['create', 'share'] },
        catalog: { type: 'array', items: routableSchema, description: 'Optional; defaults to the org\'s saved routables' }
      },
      required: ['item']
    },
    handler: async (orchestrator, input) => {
      try {
        const catalog = await loadCatalog(orchestrator, input);
        const result = governRoutable({ candidate: input.item, catalog, stage: input.stage || 'create' });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  {
    name: 'audit_routing_catalog',
    description: 'Audit a whole catalog of routable items: overlapping sibling pairs, lists over their token budget, and every test prompt routed within its list with a confusion table.',
    input_schema: {
      type: 'object',
      properties: {
        catalog: { type: 'array', items: routableSchema, description: 'Optional; defaults to the org\'s saved routables' }
      }
    },
    handler: async (orchestrator, input) => {
      try {
        const catalog = await loadCatalog(orchestrator, input);
        return { success: true, ...auditCatalog({ catalog }) };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
];

export default routingGovernanceTools;
