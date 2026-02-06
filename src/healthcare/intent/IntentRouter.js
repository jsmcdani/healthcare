/**
 * Healthcare Intent Router
 * Routes incoming requests to appropriate recipes based on intent detection
 */

import { IntentModes, getMode, getDefaultMode, isRecipeAllowedInMode } from './IntentModeRegistry.js';
import { Logger } from '../../utils/logger.js';

export class IntentRouter {
  constructor(config = {}) {
    this.logger = new Logger('IntentRouter');
    this.policyEngine = config.policyEngine;
    this.recipeEngine = config.recipeEngine;
    this.knowledgeEngine = config.knowledgeEngine;
    
    // Intent detection patterns
    this.intentPatterns = {
      'patient-summary': [/patient\s+summary/i, /summarize\s+patient/i, /patient\s+overview/i],
      'drug-interaction-check': [/drug\s+interaction/i, /medication\s+check/i, /prescri.*safe/i],
      'lab-interpretation': [/lab\s+results?/i, /interpret\s+labs?/i, /blood\s+work/i],
      'diagnosis-coding': [/icd.*code/i, /diagnosis\s+code/i, /code\s+this/i],
      'care-gap-analysis': [/care\s+gap/i, /overdue/i, /missing\s+care/i],
      'triage-assessment': [/triage/i, /emergency/i, /urgent/i, /critical/i],
      'disease-prevalence': [/prevalence/i, /population/i, /how\s+many\s+patients/i],
      'risk-stratification': [/risk\s+score/i, /high\s+risk/i, /stratif/i]
    };
  }

  /**
   * Route a request to the appropriate recipe
   */
  async route(request) {
    const startTime = Date.now();
    
    try {
      // 1. Detect intent from request
      const detectedIntent = this.detectIntent(request);
      
      // 2. Determine appropriate mode
      const mode = this.determineMode(request, detectedIntent);
      
      // 3. Validate against policy
      const policyResult = await this.validatePolicy(request, mode, detectedIntent);
      if (!policyResult.allowed) {
        return this.createBlockedResponse(policyResult);
      }
      
      // 4. Select recipe
      const recipe = this.selectRecipe(detectedIntent, mode);
      if (!recipe) {
        return this.createNoRecipeResponse(detectedIntent, mode);
      }
      
      // 5. Build execution context
      const context = await this.buildContext(request, mode, recipe);
      
      // 6. Return routing result
      return {
        success: true,
        intent: detectedIntent,
        mode: mode.id,
        recipe: recipe.id,
        context,
        policyApplied: policyResult.policiesApplied,
        routingTimeMs: Date.now() - startTime
      };
      
    } catch (error) {
      this.logger.error('Routing failed:', error);
      return {
        success: false,
        error: error.message,
        routingTimeMs: Date.now() - startTime
      };
    }
  }

  /**
   * Detect intent from natural language request
   */
  detectIntent(request) {
    const query = request.query || request.message || '';
    
    for (const [intentId, patterns] of Object.entries(this.intentPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(query)) {
          this.logger.info(`Detected intent: ${intentId}`);
          return {
            id: intentId,
            confidence: 0.85,
            matchedPattern: pattern.toString()
          };
        }
      }
    }
    
    // Default to general query
    return {
      id: 'general-query',
      confidence: 0.5,
      matchedPattern: null
    };
  }

  /**
   * Determine the appropriate mode for the request
   */
  determineMode(request, intent) {
    // Check for explicit mode override
    if (request.mode && IntentModes[request.mode]) {
      return IntentModes[request.mode];
    }
    
    // Emergency detection
    if (this.isEmergencyContext(request, intent)) {
      return IntentModes.EMERGENCY_TRIAGE;
    }
    
    // PHI sensitivity detection
    if (this.requiresPHIProtection(request)) {
      return IntentModes.PHI_PROTECTION;
    }
    
    // Use context-based default
    return getDefaultMode({
      hasPatientId: !!request.patientId,
      isEmergency: false,
      isAudit: request.auditMode || false
    });
  }

  /**
   * Check if emergency context
   */
  isEmergencyContext(request, intent) {
    const emergencyKeywords = /emergency|urgent|critical|stat|code\s+blue|cardiac\s+arrest/i;
    const query = request.query || request.message || '';
    return emergencyKeywords.test(query) || intent.id === 'triage-assessment';
  }

  /**
   * Check if PHI protection is required
   */
  requiresPHIProtection(request) {
    return request.exportData || request.shareExternal || request.printPHI;
  }

  /**
   * Validate request against policy engine
   */
  async validatePolicy(request, mode, intent) {
    if (!this.policyEngine) {
      return { allowed: true, policiesApplied: [] };
    }
    
    const result = await this.policyEngine.validateOperation({
      mode: mode.id,
      intent: intent.id,
      user: request.user,
      patientId: request.patientId
    }, { request });

    return {
      allowed: result.allowed,
      policiesApplied: result.trace || []
    };
  }

  /**
   * Select appropriate recipe for intent and mode
   */
  selectRecipe(intent, mode) {
    // Check if intent's recipe is allowed in this mode
    if (!isRecipeAllowedInMode(intent.id, mode.id)) {
      // Try to find an alternative allowed recipe
      for (const recipeId of mode.allowedRecipes) {
        if (recipeId.includes(intent.id.split('-')[0])) {
          return { id: recipeId };
        }
      }
      return null;
    }
    
    return { id: intent.id };
  }

  /**
   * Build execution context with knowledge and constraints
   */
  async buildContext(request, mode, recipe) {
    const context = {
      mode: mode.id,
      constraints: mode.constraints,
      recipe: recipe.id,
      timestamp: new Date().toISOString(),
      sessionId: request.sessionId,
      userId: request.user?.id,
      patientId: request.patientId
    };
    
    // Enrich with knowledge if available
    if (this.knowledgeEngine) {
      context.knowledge = await this.knowledgeEngine.getRelevantKnowledge(recipe.id);
    }
    
    return context;
  }

  /**
   * Create blocked response
   */
  createBlockedResponse(policyResult) {
    return {
      success: false,
      blocked: true,
      reason: policyResult.reason,
      requiredActions: policyResult.requiredActions,
      policiesViolated: policyResult.policiesViolated
    };
  }

  /**
   * Create no recipe found response
   */
  createNoRecipeResponse(intent, mode) {
    return {
      success: false,
      error: 'NO_RECIPE_AVAILABLE',
      message: `No recipe available for intent '${intent.id}' in mode '${mode.id}'`,
      suggestedModes: this.getSuggestedModes(intent.id)
    };
  }

  /**
   * Get suggested modes for an intent
   */
  getSuggestedModes(intentId) {
    return Object.values(IntentModes)
      .filter(mode => mode.allowedRecipes.includes(intentId))
      .map(mode => mode.id);
  }
}

export default IntentRouter;
