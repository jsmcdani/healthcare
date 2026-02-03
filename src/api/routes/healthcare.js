/**
 * Healthcare API Routes - NLS endpoints
 */

import { Router } from 'express';
import { Logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { asyncHandler } from '../middleware/error-handler.js';
import { createEndpointRateLimit } from '../middleware/rate-limit.js';
import { getNaturalLanguageService } from '../../healthcare/nls/index.js';

const logger = new Logger('HealthcareRoutes');

export default function healthcareRoutes(orchestrator, eventSystem) {
  const router = Router();
  let nlsInitialized = false;

  async function ensureNLSInitialized() {
    if (nlsInitialized) return;
    const nls = getNaturalLanguageService();
    await nls.initialize({
      orchestrator,
      cache: orchestrator?.cache
    });
    nlsInitialized = true;
    logger.info('NaturalLanguageService initialized');
  }

  router.post('/parse-intent',
    createEndpointRateLimit('healthcare_parse', { max: 100, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      await ensureNLSInitialized();
      const { rawText, context = {} } = req.body;
      if (!rawText) throw new ValidationError('rawText is required');

      const parseContext = {
        ...context,
        userId: context.userId || req.user?.userId,
        orgId: context.orgId || req.orgId || req.user?.orgId,
        correlationId: req.headers['x-correlation-id']
      };

      const nls = getNaturalLanguageService();
      const envelope = await nls.parseIntent({ rawText, context: parseContext });

      logger.info('Intent parsed', { intentId: envelope.payload.intentId, confidence: envelope.payload.parseConfidence });
      res.json({ success: true, envelopeId: envelope.header.envelopeId, payload: envelope.payload, timestamp: envelope.header.timestamp });
    })
  );

  router.post('/confirm-intent',
    createEndpointRateLimit('healthcare_confirm', { max: 100, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      await ensureNLSInitialized();
      const { parseEnvelopeId, confirmedIntentId, confirmedParameters = [] } = req.body;
      if (!parseEnvelopeId) throw new ValidationError('parseEnvelopeId is required');
      if (!confirmedIntentId) throw new ValidationError('confirmedIntentId is required');

      const nls = getNaturalLanguageService();
      const confirmation = {
        header: { confirmId: crypto.randomUUID ? crypto.randomUUID() : `confirm-${Date.now()}`, confirmType: 'IntentConfirm', version: '1.0.0', timestamp: new Date().toISOString() },
        payload: { parseEnvelopeId, confirmedIntentId, confirmedParameters }
      };

      const response = await nls.confirmIntent(confirmation);
      logger.info('Intent confirmed', { confirmed: response.confirmed, intentId: confirmedIntentId });
      res.json(response);
    })
  );

  router.get('/intents',
    createEndpointRateLimit('healthcare_intents', { max: 200, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      await ensureNLSInitialized();
      const nls = getNaturalLanguageService();
      res.json({ success: true, intents: nls.getAvailableIntents(), timestamp: new Date().toISOString() });
    })
  );

  router.get('/intents/:intentId',
    createEndpointRateLimit('healthcare_intent_detail', { max: 200, windowMs: 60000 }),
    asyncHandler(async (req, res) => {
      await ensureNLSInitialized();
      const nls = getNaturalLanguageService();
      const intent = nls.getHelpText(req.params.intentId);
      if (!intent) return res.status(404).json({ success: false, error: `Intent not found: ${req.params.intentId}` });
      res.json({ success: true, intent, timestamp: new Date().toISOString() });
    })
  );

  router.get('/health',
    asyncHandler(async (req, res) => {
      let nlsStatus = 'not_initialized';
      try {
        await ensureNLSInitialized();
        const nls = getNaturalLanguageService();
        nlsStatus = `ok (${nls.getAvailableIntents().length} intents)`;
      } catch (error) { nlsStatus = `error: ${error.message}`; }
      res.json({ success: true, status: 'healthy', nls: nlsStatus, timestamp: new Date().toISOString() });
    })
  );

  return router;
}
