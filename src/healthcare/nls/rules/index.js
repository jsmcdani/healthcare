/**
 * Rule Loader - Load and validate intent rule tables with Zod
 *
 * P1: Closed-world intent universe (allowlist only)
 * P5: Auditability + version pinning
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateRuleTable } from './rule-schema.js';
import { Logger } from '../../../utils/logger.js';

const logger = new Logger('RuleLoader');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache loaded rule tables
let cachedRuleTables = null;
let cacheTimestamp = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load a single rule table JSON file
 */
async function loadRuleFile(filename) {
  const filepath = join(__dirname, filename);

  try {
    const content = await readFile(filepath, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate with Zod
    const result = validateRuleTable(parsed);

    if (!result.success) {
      const errors = result.error.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message
      }));
      logger.error(`Invalid rule table ${filename}:`, { errors });
      throw new Error(`Invalid rule table ${filename}: ${JSON.stringify(errors)}`);
    }

    logger.info(`Loaded rule table: ${filename}`, {
      version: result.data.version,
      intentCount: result.data.intents.length
    });

    return result.data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn(`Rule file not found: ${filename}`);
      return null;
    }
    throw err;
  }
}

/**
 * Load all rule tables and merge them
 */
export async function loadRuleTables(options = {}) {
  const { useCache = true, files = null } = options;

  // Check cache
  if (useCache && cachedRuleTables && cacheTimestamp) {
    const age = Date.now() - cacheTimestamp;
    if (age < CACHE_TTL_MS) {
      logger.debug('Using cached rule tables', { ageMs: age });
      return cachedRuleTables;
    }
  }

  // Default rule files
  const ruleFiles = files || [
    'clinical-intents.json'
    // Future: 'administrative-intents.json', 'system-intents.json'
  ];

  const allIntents = [];
  const versions = [];

  for (const file of ruleFiles) {
    const ruleTable = await loadRuleFile(file);
    if (ruleTable) {
      allIntents.push(...ruleTable.intents);
      versions.push({
        file,
        version: ruleTable.version,
        lastUpdated: ruleTable.lastUpdated,
        intentCount: ruleTable.intents.length
      });
    }
  }

  // Build composite version string for auditability
  const compositeVersion = versions
    .map(v => `${v.file}@${v.version}`)
    .join('+');

  const result = {
    version: compositeVersion,
    loadedAt: new Date().toISOString(),
    sources: versions,
    intents: allIntents,

    // Convenience methods
    getIntent(intentId) {
      return allIntents.find(i => i.intentId === intentId);
    },

    getIntentsByDomain(domain) {
      return allIntents.filter(i => i.domain === domain);
    },

    getIntentsByFamily(family) {
      return allIntents.filter(i => i.intentFamily === family);
    },

    getAllIntentIds() {
      return allIntents.map(i => i.intentId);
    },

    isKnownIntent(intentId) {
      return allIntents.some(i => i.intentId === intentId);
    }
  };

  // Update cache
  cachedRuleTables = result;
  cacheTimestamp = Date.now();

  logger.info('Rule tables loaded', {
    version: compositeVersion,
    totalIntents: allIntents.length,
    sources: versions.length
  });

  return result;
}

/**
 * Clear the rule table cache
 */
export function clearRuleCache() {
  cachedRuleTables = null;
  cacheTimestamp = null;
  logger.info('Rule cache cleared');
}

/**
 * Get the current rule table version
 */
export function getCurrentVersion() {
  return cachedRuleTables?.version || null;
}

/**
 * Get cached rules synchronously (null if not loaded)
 */
export function getCachedRules() {
  return cachedRuleTables;
}

export default {
  loadRuleTables,
  clearRuleCache,
  getCurrentVersion,
  getCachedRules
};
