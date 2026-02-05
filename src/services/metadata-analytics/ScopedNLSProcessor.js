/**
 * ScopedNLSProcessor - Processes NLS queries within a specific app scope
 *
 * IMPORTANT: This processor delegates to the full MetadataAnalyticsFacade
 * rather than implementing its own limited execution. The app's intents
 * filter which queries are handled, but the full power of the analytics
 * system (LLM recommendations, dynamic AQL, ReAct reasoning) is available.
 */

import { Logger } from '../../utils/logger.js';
import { getAppLoader } from './AppLoader.js';
import { getMetadataAnalytics } from './MetadataAnalyticsFacade.js';

export class ScopedNLSProcessor {
  constructor(orchestrator) {
    this.logger = new Logger('ScopedNLSProcessor');
    this.orchestrator = orchestrator;
    this.appLoader = getAppLoader();
    this.metadataAnalytics = getMetadataAnalytics();
  }

  /**
   * Process a query within a specific app scope
   *
   * Flow:
   * 1. Match intent within app's scoped intents (filtering)
   * 2. If matched, delegate to MetadataAnalyticsFacade for full execution
   * 3. If not matched, use ReAct fallback or return app-specific fallback
   */
  async processQuery({ appId, query, orgId, userId, context = {} }) {
    const startTime = Date.now();

    this.logger.info(`Processing scoped query`, { appId, query, orgId });

    // Ensure MetadataAnalyticsFacade is initialized
    if (!this.metadataAnalytics.initialized) {
      await this.metadataAnalytics.initialize({
        orchestrator: this.orchestrator,
        cache: this.orchestrator?.cache,
        llmService: this.orchestrator?.llmService
      });
    }

    // Ensure apps are loaded
    if (this.appLoader.apps.size === 0) {
      await this.appLoader.loadAllApps();
    }

    // Get the app configuration
    const app = this.appLoader.getApp(appId);
    if (!app) {
      return this.createFallbackResponse(appId, query);
    }

    try {
      // Step 1: Match intent within the app's scoped intents
      const matchedIntent = this.matchIntent(app, query);

      if (!matchedIntent) {
        // Use ReAct AI reasoning for unmatched queries
        return await this.handleUnmatchedQuery(app, query, orgId, userId, context, startTime);
      }

      this.logger.info(`Matched scoped intent: ${matchedIntent.id}`, {
        appId,
        confidence: matchedIntent.confidence,
        recipe: matchedIntent.recipe
      });

      // Step 2: Delegate to full MetadataAnalyticsFacade
      // This gives us access to:
      // - LLM-powered recommendations (llm/recommend, llm/analyze)
      // - Dynamic AQL generation
      // - ReAct AI reasoning
      // - Full recipe execution with all step types
      // - Risk scores, remediation plans, action items
      const analyticsResult = await this.metadataAnalytics.processQuery({
        query,
        orgId,
        userId,
        context: {
          ...context,
          appId,
          appMotif: app.motif,
          scopedIntent: matchedIntent,
          // Pass extracted entities
          ...matchedIntent.entities
        }
      });

      const processingTime = Date.now() - startTime;

      return {
        success: analyticsResult.success,
        appId,
        intent: matchedIntent,
        recipe: matchedIntent.recipe,
        result: analyticsResult.result,
        executionMode: analyticsResult.executionMode || 'static',
        processingTime,
        suggestions: this.buildSuggestions(app, matchedIntent, analyticsResult),
        error: analyticsResult.error
      };

    } catch (error) {
      this.logger.error(`Query processing failed`, {
        appId,
        query,
        error: error.message
      });

      return {
        success: false,
        appId,
        error: error.message,
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Handle queries that don't match any scoped intent
   * Uses ReAct AI reasoning within app context
   */
  async handleUnmatchedQuery(app, query, orgId, userId, context, startTime) {
    const motif = app.motif || {};
    const fallback = app.intents?.fallback || {};

    try {
      this.logger.info(`Using ReAct for unmatched query in ${app.id}`);

      // Build app-aware prompt context
      const appContext = {
        appId: app.id,
        appName: motif.name || app.id,
        capabilities: motif.capabilities || [],
        limitations: motif.limitations || [],
        suggestedQueries: motif.suggestedQueries || []
      };

      // Use the full analytics system with ReAct reasoning
      const analyticsResult = await this.metadataAnalytics.processQuery({
        query,
        orgId,
        userId,
        forceReAct: true, // Use AI reasoning
        context: {
          ...context,
          ...appContext
        }
      });

      if (analyticsResult.success) {
        return {
          success: true,
          appId: app.id,
          intent: { id: 'react:reasoning', tier: '4' },
          result: analyticsResult.result,
          executionMode: 'react',
          processingTime: Date.now() - startTime,
          suggestions: this.buildReActSuggestions(app, analyticsResult)
        };
      }
    } catch (e) {
      this.logger.warn(`ReAct fallback failed: ${e.message}`);
    }

    // Final static fallback
    return {
      success: true,
      appId: app.id,
      result: {
        data: {
          message: fallback.message || motif.welcomeMessage || `I couldn't understand that query.`,
          suggestions: fallback.suggestions || motif.suggestedQueries || []
        },
        output: {
          suggestions: (fallback.suggestions || []).map(s => ({ label: s, command: s }))
        }
      },
      matchedIntent: null,
      isFallback: true,
      processingTime: Date.now() - startTime
    };
  }

  /**
   * Match query against app's intents
   * This is the FILTERING step - we only accept queries that match
   * this app's domain before delegating to the full system
   */
  matchIntent(app, query) {
    const intents = app.intents?.intents || [];
    const queryLower = query.toLowerCase().trim();

    let bestMatch = null;
    let bestConfidence = 0;

    for (const intent of intents) {
      // Check triggers (slash commands) - exact match, highest priority
      if (intent.triggers) {
        for (const trigger of intent.triggers) {
          if (queryLower === trigger.toLowerCase() ||
              queryLower.startsWith(trigger.toLowerCase() + ' ')) {
            return {
              ...intent,
              confidence: 1.0,
              matchType: 'trigger',
              entities: this.extractTriggerEntities(query, trigger, intent)
            };
          }
        }
      }

      // Check patterns (regex) for natural language matching
      if (intent.patterns) {
        for (const pattern of intent.patterns) {
          try {
            const regex = new RegExp(pattern.regex, 'i');
            const match = queryLower.match(regex);

            if (match) {
              const confidence = pattern.weight || 0.8;

              if (confidence > bestConfidence && confidence >= (intent.confidenceThreshold || 0.7)) {
                bestConfidence = confidence;
                bestMatch = {
                  ...intent,
                  confidence,
                  matchType: 'pattern',
                  entities: this.extractPatternEntities(match, pattern.groups)
                };
              }
            }
          } catch (e) {
            this.logger.warn(`Invalid regex pattern: ${pattern.regex}`);
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * Extract entities from trigger command (args after trigger)
   * Uses intent's entity definitions to map args to correct parameter names
   */
  extractTriggerEntities(query, trigger, intent) {
    const remainder = query.slice(trigger.length).trim();
    const parts = remainder.split(/\s+/).filter(p => p.length > 0);

    // Start with generic extraction for backwards compatibility
    const entities = {
      args: parts,
      rawArgs: remainder,
      target: remainder || null,
      field: remainder || null,
      fieldName: remainder || null,
      object: parts[0] || null,
      objectName: parts[0] || null,
      flowName: parts[0] || null,
      flow1: parts[0] || null,
      flow2: parts[1] || null
    };

    // If intent has entity definitions with extractFrom: 'args', use those
    if (intent?.entities && remainder) {
      const argEntities = Object.entries(intent.entities)
        .filter(([_, def]) => def.extractFrom === 'args');

      if (argEntities.length === 1) {
        // Single arg entity - assign the whole args string
        entities[argEntities[0][0]] = remainder;
      } else if (argEntities.length > 1) {
        // Multiple arg entities - map by position
        argEntities.forEach(([name, _], index) => {
          if (parts[index]) {
            entities[name] = parts[index];
          }
        });
      }

      // Apply defaults for missing entities
      for (const [entityName, entityDef] of Object.entries(intent.entities)) {
        if (entities[entityName] === undefined && entityDef.default !== undefined) {
          entities[entityName] = entityDef.default;
        }
      }
    }

    return entities;
  }

  /**
   * Extract entities from pattern match groups
   */
  extractPatternEntities(match, groups) {
    const entities = {};

    if (groups && match) {
      for (const [name, index] of Object.entries(groups)) {
        if (match[index]) {
          entities[name] = match[index];
        }
      }
    }

    return entities;
  }

  /**
   * Build contextual suggestions based on app, intent, and result
   */
  buildSuggestions(app, matchedIntent, analyticsResult) {
    const suggestions = [];

    // Get suggestions from recipe result if available
    if (analyticsResult.result?.output?.suggestions) {
      suggestions.push(...analyticsResult.result.output.suggestions);
    }

    // Add app-specific follow-up suggestions based on the intent
    const intentSuggestions = this.getIntentFollowups(app, matchedIntent);
    suggestions.push(...intentSuggestions);

    // Add motif suggestions if we're at low count
    if (suggestions.length < 3 && app.motif?.suggestedQueries) {
      const remaining = 3 - suggestions.length;
      const motifSuggestions = app.motif.suggestedQueries
        .slice(0, remaining)
        .map(s => ({ label: s, command: s }));
      suggestions.push(...motifSuggestions);
    }

    return suggestions.slice(0, 5); // Max 5 suggestions
  }

  /**
   * Build suggestions for ReAct reasoning results
   */
  buildReActSuggestions(app, analyticsResult) {
    const suggestions = [];

    // Pull from result if available
    if (analyticsResult.result?.suggestions) {
      suggestions.push(...analyticsResult.result.suggestions);
    }

    // Add app's suggested queries
    if (app.motif?.suggestedQueries) {
      const motifSuggestions = app.motif.suggestedQueries
        .slice(0, 3)
        .map(s => ({ label: s, command: s }));
      suggestions.push(...motifSuggestions);
    }

    return suggestions.slice(0, 5);
  }

  /**
   * Get follow-up suggestions based on the matched intent
   */
  getIntentFollowups(app, matchedIntent) {
    const followups = {
      // Technical Debt app followups
      'td:summary': [
        { label: 'View action plan', command: '/action-plan' },
        { label: 'Quick wins', command: '/quick-wins' }
      ],
      'td:field-sprawl': [
        { label: 'Orphaned fields', command: '/orphaned' },
        { label: 'Field rationalization plan', command: '/action-plan' }
      ],
      'td:coupling': [
        { label: 'Blast radius', command: '/blast' },
        { label: 'Hotspot clusters', command: '/hotspots' }
      ],
      'td:action-plan': [
        { label: 'Quick wins first', command: '/quick-wins' },
        { label: 'Migration roadmap', command: '/migration' }
      ],
      'td:quick-wins': [
        { label: 'Full action plan', command: '/action-plan' },
        { label: 'Debt summary', command: '/summary' }
      ],

      // Workflow app followups
      'wf:summary': [
        { label: 'Consolidation opportunities', command: '/consolidate' },
        { label: 'Migration roadmap', command: '/migrate' }
      ],
      'wf:consolidation': [
        { label: 'Start migration', command: '/migrate' },
        { label: 'View by object', command: '/by-object' }
      ],
      'wf:by-object': [
        { label: 'Show summary', command: '/summary' },
        { label: 'Find consolidation', command: '/consolidate' }
      ],

      // Permissions app followups
      'perm:summary': [
        { label: 'Security audit', command: '/audit' },
        { label: 'PII exposure', command: '/pii' }
      ],
      'perm:audit': [
        { label: 'Permission exposure', command: '/exposure' },
        { label: 'Compare profiles', command: '/compare' }
      ],
      'perm:pii': [
        { label: 'Security audit', command: '/audit' },
        { label: 'Permission exposure', command: '/exposure' }
      ],

      // Labels app followups
      'label:summary': [
        { label: 'Worst mismatches', command: '/worst' },
        { label: 'Fix recommendations', command: '/recommendations' }
      ],
      'label:worst': [
        { label: 'View by object', command: '/by-object' },
        { label: 'Show summary', command: '/summary' }
      ],

      // MuleSoft app followups
      'mule:summary': [
        { label: 'Connected apps', command: '/apps' },
        { label: 'Named credentials', command: '/credentials' }
      ],
      'mule:apps': [
        { label: 'External services', command: '/services' },
        { label: 'Summary', command: '/summary' }
      ]
    };

    return followups[matchedIntent.id] || [];
  }

  /**
   * Create fallback response when app not found
   */
  createFallbackResponse(appId, query) {
    return {
      success: false,
      appId,
      error: `App "${appId}" not found`,
      suggestions: ['workflows', 'technical-debt', 'permissions', 'labels', 'mulesoft']
    };
  }
}

export default ScopedNLSProcessor;
