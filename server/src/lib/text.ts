/**
 * Small, dependency-free text toolkit used by the AI layer: tokenisation, TF-IDF similarity
 * (near-duplicate detection, recurrence detection, retrieval re-ranking), a multinomial naive
 * Bayes classifier (intent/type classification trained on agent confirmations), and a lexicon
 * sentiment score. Deterministic and explainable by design.
 */

const STOP = new Set(
  `a an the and or but if then else of to in on at by for with from as is are was were be been being am
   i me my we our you your he she it its they them their this that these those there here what which who whom
   do does did doing have has had having can could would should will shall may might must not no nor so too very
   just about into over under again further once all any both each few more most other some such only own same
   than s t don now please hi hello dear regards kind thanks thank good morning afternoon evening sir madam
   would like want need also get got us re fw fwd`.split(/\s+/),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string, { keepStop = false } = {}): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && (keepStop || !STOP.has(t)))
    .map(stem);
}

export type Vec = Map<string, number>;

export function termFreq(tokens: string[]): Vec {
  const m: Vec = new Map();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export class TfIdf {
  private df = new Map<string, number>();
  private n = 0;
  constructor(docs: string[] = []) {
    for (const d of docs) this.add(d);
  }
  add(doc: string) {
    this.n++;
    for (const t of new Set(tokenize(doc))) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }
  idf(t: string) {
    return Math.log((1 + this.n) / (1 + (this.df.get(t) ?? 0))) + 1;
  }
  vector(doc: string): Vec {
    const tf = termFreq(tokenize(doc));
    const v: Vec = new Map();
    for (const [t, c] of tf) v.set(t, (1 + Math.log(c)) * this.idf(t));
    return v;
  }
}

export function cosine(a: Vec, b: Vec): number {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  for (const [t, x] of a) {
    const y = b.get(t);
    if (y) dot += x * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Similarity of two short texts within the context of a small corpus. */
export function similarity(a: string, b: string, corpus: string[] = []): number {
  const tf = new TfIdf([a, b, ...corpus]);
  return cosine(tf.vector(a), tf.vector(b));
}

export class NaiveBayes {
  private classCounts = new Map<string, number>();
  private tokenCounts = new Map<string, Map<string, number>>();
  private totals = new Map<string, number>();
  private vocab = new Set<string>();
  private docs = 0;

  train(label: string, text: string, weight = 1) {
    this.docs += weight;
    this.classCounts.set(label, (this.classCounts.get(label) ?? 0) + weight);
    const tc = this.tokenCounts.get(label) ?? new Map<string, number>();
    for (const t of tokenize(text)) {
      tc.set(t, (tc.get(t) ?? 0) + weight);
      this.totals.set(label, (this.totals.get(label) ?? 0) + weight);
      this.vocab.add(t);
    }
    this.tokenCounts.set(label, tc);
  }

  get labels() {
    return [...this.classCounts.keys()];
  }

  /** Returns labels with calibrated probabilities, best first. */
  predict(text: string): { label: string; p: number }[] {
    const tokens = tokenize(text).filter((t) => this.vocab.has(t));
    if (!this.docs) return [];
    const V = this.vocab.size || 1;
    const logs: { label: string; lp: number }[] = [];
    for (const [label, count] of this.classCounts) {
      let lp = Math.log(count / this.docs);
      const tc = this.tokenCounts.get(label)!;
      const total = this.totals.get(label) ?? 0;
      for (const t of tokens) lp += Math.log(((tc.get(t) ?? 0) + 1) / (total + V));
      logs.push({ label, lp });
    }
    const max = Math.max(...logs.map((l) => l.lp));
    const exps = logs.map((l) => ({ label: l.label, e: Math.exp(l.lp - max) }));
    const sum = exps.reduce((s, x) => s + x.e, 0);
    const out = exps.map((x) => ({ label: x.label, p: x.e / sum })).sort((a, b) => b.p - a.p);
    // No informative tokens: flatten confidence so the caller treats it as a guess.
    if (!tokens.length) return out.map((o) => ({ ...o, p: Math.min(o.p, 0.3) }));
    return out;
  }
}

const NEG = new Set(
  `unacceptable angry furious terrible awful worst disgusting ridiculous frustrated frustrating disappointed
   disappointing useless incompetent delay delayed late again still nobody never complaint complain urgent
   immediately escalate lawyer legal demurrage losing loss lost penalty fail failed failure poor bad wrong
   ignored ignore waiting chasing third fourth`.split(/\s+/),
);
const POS = new Set(`thank thanks great excellent appreciate appreciated helpful happy pleased resolved perfect good`.split(/\s+/));

/** Lexicon sentiment in [-1, 1]. Exclamation marks and capitals amplify. */
export function sentiment(text: string): number {
  const toks = (text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!toks.length) return 0;
  let s = 0;
  for (const t of toks) {
    if (NEG.has(t) || NEG.has(stem(t))) s -= 1;
    if (POS.has(t) || POS.has(stem(t))) s += 1;
  }
  const bangs = (text.match(/!/g) ?? []).length;
  const shouting = (text.match(/\b[A-Z]{4,}\b/g) ?? []).length;
  s -= Math.min(bangs, 3) * 0.5 + Math.min(shouting, 3) * 0.5;
  return Math.max(-1, Math.min(1, s / Math.max(4, Math.sqrt(toks.length) * 2)));
}

export function normalizeQuestion(q: string): string {
  return [...new Set(tokenize(q))].sort().join(' ');
}

/** Split into sentences for extractive answer composition. */
export function sentences(text: string): string[] {
  return (text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
