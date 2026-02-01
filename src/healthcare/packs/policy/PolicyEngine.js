/**
 * Policy Engine
 * Evaluates policies to determine intent modes and validate operations
 */

import { Logger } from '../../../utils/logger.js';
import { IntentModes, SensitivityLevels } from '../../../database/schema/healthcare-graph-schema.js';

export class PolicyEngine {
  constructor(options = {}) {
    this.logger = new Logger('PolicyEngine');
    this.policyPacks = new Map();
    this.defaultPackName = options.defaultPack || 'healthcare-default';
    this.evaluationCache = new Map();
    this.cacheTimeout = options.cacheTimeout || 60000;  // 1 minute
  }

  /**
   * Load a policy pack
   */
  async loadPolicyPack(packDefinition) {
    const { name, version, rules, metadata } = packDefinition;

    if (!name || !rules) {
      throw new Error('Policy pack must have name and rules');
    }

    const pack = {
      name,
      version: version || '1.0.0',
      rules: rules.map((rule, index) => ({
        ...rule,
        id: rule.id || `${name}:rule_${index}`,
        priority: rule.priority || 100
      })),
      metadata: metadata || {},
      loadedAt: new Date().toISOString()
    };

    // Sort rules by priority (highest first)
    pack.rules.sort((a, b) => b.priority - a.priority);

    this.policyPacks.set(name, pack);
    this.logger.info(`Loaded policy pack: ${name} v${version} with ${pack.rules.length} rules`);

    return pack;
  }

  /**
   * Load policy pack from JSON file
   */
  async loadPolicyPackFromFile(filePath) {
    const fs = await import('fs/promises');
    const content = await fs.readFile(filePath, 'utf8');
    const packDefinition = JSON.parse(content);
    return this.loadPolicyPack(packDefinition);
  }

  /**
   * Determine intent mode based on policies
   */
  async determineIntentMode(task, context) {
    const cacheKey = this.buildCacheKey('intent', task, context);
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const evaluationContext = this.buildEvaluationContext(task, context);
    const trace = [];

    // Get applicable policy pack
    const packName = context.policyPack || this.defaultPackName;
    const pack = this.policyPacks.get(packName);

    if (!pack) {
      this.logger.warn(`Policy pack not found: ${packName}, using default intent mode`);
      return {
        mode: IntentModes.GUARDRAIL_ENFORCEMENT,
        reason: 'No policy pack loaded',
        trace
      };
    }

    // Evaluate rules in priority order
    for (const rule of pack.rules) {
      if (rule.intentModeCondition) {
        const match = this.evaluateCondition(rule.intentModeCondition, evaluationContext);
        trace.push({
          ruleId: rule.id,
          condition: rule.intentModeCondition,
          matched: match
        });

        if (match) {
          const result = {
            mode: rule.intentMode,
            reason: rule.description || `Matched rule: ${rule.id}`,
            ruleId: rule.id,
            trace
          };
          this.setInCache(cacheKey, result);
          return result;
        }
      }
    }

    // Default fallback
    const result = {
      mode: IntentModes.GUARDRAIL_ENFORCEMENT,
      reason: 'No matching policy rule, using default',
      trace
    };
    this.setInCache(cacheKey, result);
    return result;
  }

  /**
   * Validate if an operation is allowed
   */
  async validateOperation(operation, context) {
    const evaluationContext = this.buildEvaluationContext(operation, context);
    const trace = [];
    const violations = [];

    const packName = context.policyPack || this.defaultPackName;
    const pack = this.policyPacks.get(packName);

    if (!pack) {
      return { allowed: true, trace, violations };
    }

    for (const rule of pack.rules) {
      if (rule.validationCondition) {
        const match = this.evaluateCondition(rule.validationCondition, evaluationContext);
        trace.push({
          ruleId: rule.id,
          condition: rule.validationCondition,
          matched: match
        });

        if (match && rule.action === 'block') {
          violations.push({
            ruleId: rule.id,
            message: rule.message || `Blocked by rule: ${rule.id}`,
            severity: rule.severity || 'error'
          });
        }
      }
    }

    return {
      allowed: violations.filter(v => v.severity === 'error').length === 0,
      violations,
      trace
    };
  }

  /**
   * Validate recipe execution against policies
   */
  async validateRecipeExecution(recipe, routingContext) {
    const context = {
      recipe,
      task: routingContext.task,
      intentMode: routingContext.intentMode,
      ...routingContext.originalContext
    };

    return this.validateOperation(
      { type: 'recipe_execution', recipe: recipe.name },
      context
    );
  }

  /**
   * Get policy overrides for a context
   */
  async getOverrides(context) {
    const evaluationContext = this.buildEvaluationContext(null, context);
    const overrides = {};

    const packName = context.policyPack || this.defaultPackName;
    const pack = this.policyPacks.get(packName);

    if (!pack) return overrides;

    for (const rule of pack.rules) {
      if (rule.overrides) {
        const match = this.evaluateCondition(rule.condition || {}, evaluationContext);
        if (match) {
          Object.assign(overrides, rule.overrides);
        }
      }
    }

    return overrides;
  }

  /**
   * Build evaluation context from task and context
   */
  buildEvaluationContext(task, context) {
    return {
      task: task || {},
      context: context || {},
      // Convenience accessors
      taskType: task?.type,
      sensitivity: context?.sensitivity || this.detectSensitivity(task, context),
      hasPHI: context?.hasPHI || this.detectPHI(task, context),
      isMigration: context?.isMigration,
      isDeployment: context?.isDeployment,
      userRole: context?.userRole,
      environment: context?.environment || process.env.NODE_ENV,
      timestamp: new Date(),
      dayOfWeek: new Date().getDay(),
      hour: new Date().getHours()
    };
  }

  /**
   * Evaluate a condition against context
   */
  evaluateCondition(condition, context) {
    if (!condition || Object.keys(condition).length === 0) {
      return true;  // Empty condition matches everything
    }

    for (const [key, expected] of Object.entries(condition)) {
      const actual = this.getNestedValue(context, key);

      // Handle different comparison types
      if (typeof expected === 'object' && expected !== null) {
        // Complex conditions
        if (expected.$eq !== undefined && actual !== expected.$eq) return false;
        if (expected.$ne !== undefined && actual === expected.$ne) return false;
        if (expected.$in !== undefined && !expected.$in.includes(actual)) return false;
        if (expected.$nin !== undefined && expected.$nin.includes(actual)) return false;
        if (expected.$gt !== undefined && !(actual > expected.$gt)) return false;
        if (expected.$gte !== undefined && !(actual >= expected.$gte)) return false;
        if (expected.$lt !== undefined && !(actual < expected.$lt)) return false;
        if (expected.$lte !== undefined && !(actual <= expected.$lte)) return false;
        if (expected.$exists !== undefined && (actual !== undefined) !== expected.$exists) return false;
        if (expected.$regex !== undefined && !new RegExp(expected.$regex).test(actual)) return false;
      } else {
        // Simple equality
        if (actual !== expected) return false;
      }
    }

    return true;
  }

  /**
   * Get nested value from object using dot notation
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * Detect sensitivity level from task/context
   */
  detectSensitivity(task, context) {
    if (context?.sensitivity) return context.sensitivity;

    const taskString = JSON.stringify(task || {}).toLowerCase();

    if (/phi|hipaa|patient|medical|diagnosis|treatment/.test(taskString)) {
      return SensitivityLevels.PHI;
    }
    if (/ssn|social.?security|pii/.test(taskString)) {
      return SensitivityLevels.PII;
    }
    if (/confidential|secret|private/.test(taskString)) {
      return SensitivityLevels.CONFIDENTIAL;
    }
    if (/internal/.test(taskString)) {
      return SensitivityLevels.INTERNAL;
    }

    return SensitivityLevels.PUBLIC;
  }

  /**
   * Detect if PHI is involved
   */
  detectPHI(task, context) {
    if (context?.hasPHI !== undefined) return context.hasPHI;
    return this.detectSensitivity(task, context) === SensitivityLevels.PHI;
  }

  /**
   * Cache helpers
   */
  buildCacheKey(prefix, task, context) {
    return `${prefix}:${JSON.stringify({ t: task?.type, c: context })}`;
  }

  getFromCache(key) {
    const cached = this.evaluationCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.value;
    }
    return null;
  }

  setInCache(key, value) {
    this.evaluationCache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  clearCache() {
    this.evaluationCache.clear();
  }

  /**
   * Get loaded policy packs info
   */
  getLoadedPacks() {
    return Array.from(this.policyPacks.values()).map(pack => ({
      name: pack.name,
      version: pack.version,
      ruleCount: pack.rules.length,
      loadedAt: pack.loadedAt
    }));
  }

  /**
   * Unload a policy pack
   */
  unloadPolicyPack(packName) {
    const existed = this.policyPacks.delete(packName);
    if (existed) {
      this.clearCache();
      this.logger.info(`Unloaded policy pack: ${packName}`);
    }
    return existed;
  }
}

export default PolicyEngine;
