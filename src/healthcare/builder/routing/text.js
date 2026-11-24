/**
 * Text helpers for routing governance.
 *
 * Deterministic and dependency-free. Nothing here calls a model: these checks
 * run in the control plane, before a description ever reaches one.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from',
  'as', 'is', 'are', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'their', 'they', 'them',
  'when', 'use', 'used', 'using', 'not', 'do', 'does', 'don', 't', 'into', 'about', 'any', 'all',
  'can', 'will', 'should', 'user', 'users', 'asks', 'ask', 'wants', 'want', 'instead', 'such',
  'i', 'me', 'we', 'our', 'you', 'your', 'how', 'what', 'which', 'who', 'if', 'than', 'then', 'so',
  'also', 'only', 'one', 'via', 'per', 'e', 'g', 'eg', 'ie'
]);

/** Very small suffix stemmer; enough to match "reviews"/"reviewing"/"review". */
export function stem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4 && /(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w && !STOPWORDS.has(w))
    .map(stem);
}

export function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function estimateTokens(text, charsPerToken = 4) {
  return Math.ceil(String(text || '').length / charsPerToken);
}

function findPhrase(lower, phrases) {
  let best = null;
  for (const p of phrases) {
    const i = lower.indexOf(p);
    if (i !== -1 && (best === null || i < best.index)) best = { index: i, phrase: p };
  }
  return best;
}

/**
 * Split a description into its routing clauses.
 * Returns the "use when" text, the "not for" text, and the remaining text with
 * the not-for clause removed. The not-for clause names neighbours on purpose,
 * so it must be left out of similarity scoring or it would create the very
 * overlap it exists to prevent.
 */
export function parseClauses(description, clauses) {
  const text = String(description || '');
  const lower = text.toLowerCase();

  const useWhenHit = findPhrase(lower, clauses.useWhen);
  const notForHit = findPhrase(lower, clauses.notFor);

  const sentenceEnd = (from) => {
    const m = /[.;!?](\s|$)/.exec(text.slice(from));
    return m ? from + m.index + 1 : text.length;
  };

  let useWhen = null;
  if (useWhenHit) {
    const end = notForHit && notForHit.index > useWhenHit.index
      ? Math.min(sentenceEnd(useWhenHit.index), notForHit.index)
      : sentenceEnd(useWhenHit.index);
    useWhen = text.slice(useWhenHit.index + useWhenHit.phrase.length, end).trim();
  }

  let notFor = null;
  let routingText = text;
  if (notForHit) {
    const end = sentenceEnd(notForHit.index);
    notFor = text.slice(notForHit.index + notForHit.phrase.length, end).trim();
    routingText = (text.slice(0, notForHit.index) + ' ' + text.slice(end)).trim();
  }

  return { useWhen, notFor, routingText };
}

/** Text the router effectively "sees" for an entry, minus its not-for clause. */
export function routingTextOf(entry, clauses) {
  const { routingText } = parseClauses(entry.description, clauses);
  return `${String(entry.name || '').replace(/-/g, ' ')} ${routingText}`;
}

/**
 * Build TF-IDF vectors for a set of documents and return a cosine function.
 * Lexical similarity is a stand-in for how a model reads descriptions: good at
 * catching shared vocabulary, blind to paraphrase. Swap in embeddings through
 * the `similarity` option on the governance functions when available.
 */
export function buildTfidf(docs) {
  const tokenLists = docs.map(tokenize);
  const df = new Map();
  for (const toks of tokenLists) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = docs.length;
  const idf = t => Math.log((n + 1) / ((df.get(t) || 0) + 1)) + 1;

  const vectorize = (toks) => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * idf(t);
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) };
  };

  const vectors = tokenLists.map(vectorize);
  const cosine = (a, b) => {
    if (!a.norm || !b.norm) return 0;
    let dot = 0;
    const [small, large] = a.v.size < b.v.size ? [a, b] : [b, a];
    for (const [t, w] of small.v) {
      const o = large.v.get(t);
      if (o) dot += w * o;
    }
    return dot / (a.norm * b.norm);
  };

  return {
    vectors,
    vectorize: (text) => vectorize(tokenize(text)),
    cosine
  };
}
