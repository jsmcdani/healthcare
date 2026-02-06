/**
 * NLS Confidence System — Complete Test Suite
 *
 * Tests the RESET SPEC compliance:
 * - All confidence from pack (no hardcoded values)
 * - Drug-check parameter extraction fix
 * - Mount Sinai "I don't know" safety
 * - Version pinning in artifacts
 * - Penalty/boost mechanics
 */

const http = require('http');

const BASE = 'http://localhost:4001';
let passed = 0;
let failed = 0;
const failures = [];

function post(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ raw: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    http.get(url, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ raw: chunks }); }
      });
    }).on('error', reject);
  });
}

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name} — ${detail || ''}`);
    failed++;
    failures.push({ name, detail });
  }
}

async function testDrugCheckExtraction() {
  console.log('\n=== Drug-Check Parameter Extraction ===');
  const r = await post('/api/healthcare/nls/parse', { text: '/drug-check aspirin warfarin' });
  const params = r.envelope?.payload?.parameters || r.parameters || [];
  const medParam = params.find(p => p.name === 'medications');
  const pidParam = params.find(p => p.name === 'patientId');

  assert('Intent is hc:drug-check',
    (r.envelope?.payload?.intentId || r.intentId) === 'hc:drug-check',
    `Got: ${r.envelope?.payload?.intentId || r.intentId}`);
  assert('Medications parameter exists',
    !!medParam,
    `Params: ${JSON.stringify(params.map(p => p.name))}`);
  assert('Medications value is "aspirin warfarin"',
    medParam?.value === 'aspirin warfarin',
    `Got: ${medParam?.value}`);
  assert('No patientId parameter (was the bug)',
    !pidParam,
    pidParam ? `patientId still present: ${pidParam.value}` : '');
}

async function testPatientSummary() {
  console.log('\n=== Patient Summary ===');
  const r = await post('/api/healthcare/nls/parse', { text: '/patient TestPatient123' });
  const params = r.envelope?.payload?.parameters || [];
  const pid = params.find(p => p.name === 'patientId');

  assert('Intent is hc:patient-summary',
    (r.envelope?.payload?.intentId) === 'hc:patient-summary',
    `Got: ${r.envelope?.payload?.intentId}`);
  assert('patientId extracted',
    !!pid,
    `Params: ${JSON.stringify(params.map(p => p.name))}`);
}

async function testCareGaps() {
  console.log('\n=== Care Gaps ===');
  const r = await post('/api/healthcare/nls/parse', { text: '/care-gaps P002' });
  const params = r.envelope?.payload?.parameters || [];
  const pid = params.find(p => p.name === 'patientId');

  assert('Intent is hc:care-gaps',
    (r.envelope?.payload?.intentId) === 'hc:care-gaps',
    `Got: ${r.envelope?.payload?.intentId}`);
  assert('patientId extracted as P002',
    pid?.value === 'P002',
    `Got: ${pid?.value}`);
}

async function testConfidenceModelInfo() {
  console.log('\n=== Confidence Model Info (pack-driven) ===');
  const r = await get('/api/healthcare/nls/confidence/model');
  const model = r.model || {};

  assert('Model ID is nls_intent_parsing_v1',
    model.modelId === 'nls_intent_parsing_v1',
    `Got: ${model.modelId}`);
  assert('Model version is 1.0.0',
    model.modelVersion === '1.0.0',
    `Got: ${model.modelVersion}`);
  assert('Pack version pinned',
    model.packVersion === '1.0.0',
    `Got: ${model.packVersion}`);
  assert('Has 4 factors',
    model.factorCount === 4,
    `Got: ${model.factorCount}`);
  assert('Has 5 penalties',
    model.penaltyCount === 5,
    `Got: ${model.penaltyCount}`);
  assert('Has 4 boosts',
    model.boostCount === 4,
    `Got: ${model.boostCount}`);
  assert('Signal mappings: tier reliability keys loaded',
    model.signalMappings?.tierReliabilityKeys?.length === 6,
    `Got: ${model.signalMappings?.tierReliabilityKeys}`);
  assert('Signal mappings: query clarity brackets loaded',
    model.signalMappings?.queryClarity?.brackets === 3,
    `Got: ${model.signalMappings?.queryClarity?.brackets}`);
  assert('Uncertainty triggers present',
    model.uncertaintyTriggers?.length === 4,
    `Got: ${model.uncertaintyTriggers}`);
}

async function testTriggerConfidence() {
  console.log('\n=== Trigger Match Confidence (Tier 1) ===');
  const r = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'trigger',
    rawConfidence: 0.95,
    queryLength: 28,
    hasAmbiguity: false,
    entityCompleteness: 1.0,
    missingRequired: false
  });
  const exp = r.explanation || {};
  const factors = exp.steps?.[1]?.factors || {};

  assert('source_reliability = 1.0 (trigger tier from pack)',
    factors.parser_tier_reliability?.value === 1,
    `Got: ${factors.parser_tier_reliability?.value}`);
  assert('data_quality = 0.8 (28 chars, pack bracket <50)',
    factors.query_clarity?.value === 0.8,
    `Got: ${factors.query_clarity?.value}`);
  assert('Result is HIGH',
    exp.result?.level === 'HIGH',
    `Got: ${exp.result?.level}`);
  assert('canProceed is true',
    exp.result?.canProceed === true,
    `Got: ${exp.result?.canProceed}`);
}

async function testLLMFallbackConfidence() {
  console.log('\n=== LLM Fallback + Ambiguity (degraded) ===');
  const r = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'llm',
    rawConfidence: 0.6,
    queryLength: 45,
    hasAmbiguity: true,
    entityCompleteness: 0.5,
    missingRequired: true
  });
  const exp = r.explanation || {};
  const factors = exp.steps?.[1]?.factors || {};
  const penalties = exp.steps?.[2]?.applied || [];

  assert('source_reliability = 0.65 (LLM tier from pack)',
    factors.parser_tier_reliability?.value === 0.65,
    `Got: ${factors.parser_tier_reliability?.value}`);
  assert('Ambiguity penalty applied',
    penalties.some(p => p.id === 'ambiguous_intent'),
    `Penalties: ${penalties.map(p => p.id)}`);
  assert('Missing required penalty applied',
    penalties.some(p => p.id === 'missing_required_params'),
    `Penalties: ${penalties.map(p => p.id)}`);
  assert('LLM fallback penalty applied',
    penalties.some(p => p.id === 'llm_fallback'),
    `Penalties: ${penalties.map(p => p.id)}`);
  assert('Result is UNCERTAIN (heavy penalties)',
    exp.result?.level === 'UNCERTAIN' || exp.result?.level === 'LOW',
    `Got: ${exp.result?.level} (value: ${exp.result?.value})`);
  assert('canProceed reflects degraded confidence',
    exp.result?.canProceed === false || exp.result?.value < 0.65,
    `Got: canProceed=${exp.result?.canProceed}, value=${exp.result?.value}`);
}

async function testNoMatchConfidence() {
  console.log('\n=== No Match (Mount Sinai "I don\'t know") ===');
  const r = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'none',
    rawConfidence: 0,
    queryLength: 3,
    hasAmbiguity: true,
    entityCompleteness: 0,
    missingRequired: true
  });
  const exp = r.explanation || {};
  const factors = exp.steps?.[1]?.factors || {};

  assert('source_reliability = 0.0 (none tier from pack)',
    factors.parser_tier_reliability?.value === 0,
    `Got: ${factors.parser_tier_reliability?.value}`);
  assert('data_quality = 0.3 (3 chars, pack bracket <5)',
    factors.query_clarity?.value === 0.3,
    `Got: ${factors.query_clarity?.value}`);
  assert('Result is UNCERTAIN',
    exp.result?.level === 'UNCERTAIN',
    `Got: ${exp.result?.level}`);
  assert('canProceed is false',
    exp.result?.canProceed === false,
    `Got: ${exp.result?.canProceed}`);
  assert('Confidence near zero',
    exp.result?.value < 0.1,
    `Got: ${exp.result?.value}`);
}

async function testPatternConfidence() {
  console.log('\n=== Pattern Match (Tier 2, partial entities) ===');
  const r = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'pattern',
    rawConfidence: 0.85,
    queryLength: 35,
    hasAmbiguity: false,
    entityCompleteness: 0.75,
    missingRequired: false
  });
  const exp = r.explanation || {};
  const factors = exp.steps?.[1]?.factors || {};

  assert('source_reliability = 0.8 (pattern tier from pack)',
    factors.parser_tier_reliability?.value === 0.8,
    `Got: ${factors.parser_tier_reliability?.value}`);
  assert('Result is MODERATE',
    exp.result?.level === 'MODERATE',
    `Got: ${exp.result?.level}`);
  assert('canProceed is true',
    exp.result?.canProceed === true,
    `Got: ${exp.result?.canProceed}`);
}

async function testSynonymConfidence() {
  console.log('\n=== Synonym Match (Tier 2b) ===');
  const r = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'synonym',
    rawConfidence: 0.6,
    queryLength: 25,
    hasAmbiguity: false,
    entityCompleteness: 1.0,
    missingRequired: false
  });
  const exp = r.explanation || {};
  const factors = exp.steps?.[1]?.factors || {};

  assert('source_reliability = 0.6 (synonym tier from pack)',
    factors.parser_tier_reliability?.value === 0.6,
    `Got: ${factors.parser_tier_reliability?.value}`);
}

async function testVersionPinning() {
  console.log('\n=== Version Pinning in Parse Results ===');
  const r = await post('/api/healthcare/nls/parse', { text: '/care-gaps P003' });
  const trace = r.envelope?.payload?.trace || {};

  assert('confidenceModel pinned in trace',
    trace.confidenceModel === 'nls_intent_parsing_v1',
    `Got: ${trace.confidenceModel}`);
  assert('confidenceModelVersion pinned in trace',
    trace.confidenceModelVersion === '1.0.0',
    `Got: ${trace.confidenceModelVersion}`);
  assert('confidenceLevel in trace',
    ['HIGH', 'MODERATE', 'LOW', 'UNCERTAIN'].includes(trace.confidenceLevel),
    `Got: ${trace.confidenceLevel}`);
  assert('canProceed in trace',
    typeof trace.canProceed === 'boolean',
    `Got: ${trace.canProceed}`);
  assert('confidenceFactors breakdown in trace',
    trace.confidenceFactors && Object.keys(trace.confidenceFactors).length === 4,
    `Got: ${Object.keys(trace.confidenceFactors || {})}`);
}

async function testConfirmedConfidence() {
  console.log('\n=== Confirmed Intent (user-confirmed) ===');
  const r = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'confirmed',
    rawConfidence: 1.0,
    queryLength: 30,
    hasAmbiguity: false,
    entityCompleteness: 1.0,
    missingRequired: false
  });
  const exp = r.explanation || {};
  const factors = exp.steps?.[1]?.factors || {};

  assert('source_reliability = 1.0 (confirmed tier from pack)',
    factors.parser_tier_reliability?.value === 1,
    `Got: ${factors.parser_tier_reliability?.value}`);
  assert('Result is HIGH',
    exp.result?.level === 'HIGH',
    `Got: ${exp.result?.level}`);
}

async function testQueryClarityBrackets() {
  console.log('\n=== Query Clarity Brackets (from pack) ===');

  // Very short query (< 5 chars)
  const r1 = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'trigger', rawConfidence: 0.95, queryLength: 3,
    hasAmbiguity: false, entityCompleteness: 1.0, missingRequired: false
  });
  assert('queryLength 3 → clarity 0.3',
    r1.explanation?.steps?.[1]?.factors?.query_clarity?.value === 0.3,
    `Got: ${r1.explanation?.steps?.[1]?.factors?.query_clarity?.value}`);

  // Short query (< 15 chars)
  const r2 = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'trigger', rawConfidence: 0.95, queryLength: 10,
    hasAmbiguity: false, entityCompleteness: 1.0, missingRequired: false
  });
  assert('queryLength 10 → clarity 0.6',
    r2.explanation?.steps?.[1]?.factors?.query_clarity?.value === 0.6,
    `Got: ${r2.explanation?.steps?.[1]?.factors?.query_clarity?.value}`);

  // Medium query (< 50 chars)
  const r3 = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'trigger', rawConfidence: 0.95, queryLength: 30,
    hasAmbiguity: false, entityCompleteness: 1.0, missingRequired: false
  });
  assert('queryLength 30 → clarity 0.8',
    r3.explanation?.steps?.[1]?.factors?.query_clarity?.value === 0.8,
    `Got: ${r3.explanation?.steps?.[1]?.factors?.query_clarity?.value}`);

  // Long query (>= 50 chars)
  const r4 = await post('/api/healthcare/nls/confidence/explain', {
    matchType: 'trigger', rawConfidence: 0.95, queryLength: 80,
    hasAmbiguity: false, entityCompleteness: 1.0, missingRequired: false
  });
  assert('queryLength 80 → clarity 0.9',
    r4.explanation?.steps?.[1]?.factors?.query_clarity?.value === 0.9,
    `Got: ${r4.explanation?.steps?.[1]?.factors?.query_clarity?.value}`);
}

async function main() {
  console.log('NLS Confidence System — Complete Test Suite');
  console.log('============================================');
  console.log(`Target: ${BASE}`);

  try {
    await testDrugCheckExtraction();
    await testPatientSummary();
    await testCareGaps();
    await testConfidenceModelInfo();
    await testTriggerConfidence();
    await testLLMFallbackConfidence();
    await testNoMatchConfidence();
    await testPatternConfidence();
    await testSynonymConfidence();
    await testVersionPinning();
    await testConfirmedConfidence();
    await testQueryClarityBrackets();

    console.log('\n============================================');
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log('\nFailures:');
      failures.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
    }
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('\nFATAL ERROR:', error.message);
    console.log('Is the server running on port 4001?');
    process.exit(1);
  }
}

main();
