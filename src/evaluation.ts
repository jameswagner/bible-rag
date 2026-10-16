/** Ablation harness: which parts help which kind of query, without rewarding chunk size. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { percentile } from './chunking.js';
import { levelNames } from './config.js';
import { InputError } from './errors.js';
import type { Path } from './loader.js';
import { fixed, isObject, median, show } from './util.js';
import type { Searcher, SearchResult } from './search.js';
import type { Corpus, Range } from './structure.js';

export const F1_THRESHOLD = 0.5;
export const CUTOFFS = [1, 3, 5] as const;

export type EvalQuery = {
  id: string;
  type: string;
  query: string;
  gold: Range[]; // acceptable answers, as atom ranges
  goldRefs: string[];
};

/** A gold answer is a unit path (["John", 3, 16], ["Psalms", 23]) or {"from": path, "to": path}. */
export function resolveGold(corpus: Corpus, spec: unknown): Range {
  let first: number;
  let last: number;
  if (isObject(spec)) {
    const keys = Object.keys(spec).sort();
    if (keys.length !== 2 || keys[0] !== 'from' || keys[1] !== 'to') {
      throw new InputError(`a gold range needs exactly 'from' and 'to', got ${show(keys)}`);
    }
    [first] = corpus.resolve(spec.from as Path);
    [, last] = corpus.resolve(spec.to as Path);
    if (first > last) throw new InputError(`gold range ${JSON.stringify(spec)} ends before it starts`);
  } else if (Array.isArray(spec)) {
    [first, last] = corpus.resolve(spec);
  } else {
    throw new InputError(`gold must be a path list or a from/to object, got ${show(spec)}`);
  }
  return corpus.atomRange(first, last);
}

export function loadQueries(path: string, corpus: Corpus): EvalQuery[] {
  const queries: EvalQuery[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  readFileSync(path, 'utf-8').split(/\r?\n/).forEach((rawLine, i) => {
    const number = i + 1;
    const line = rawLine.trim();
    if (!line) return;
    let item: { [key: string]: unknown };
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new InputError(`${path}:${number}: not valid JSON (${(error as Error).message})`);
    }
    const missing = ['id', 'type', 'query', 'gold'].filter((key) => !(key in item));
    if (missing.length) throw new InputError(`${path}:${number}: missing ${show(missing)}`);
    const id = String(item.id);
    if (seen.has(id)) throw new InputError(`${path}:${number}: duplicate id ${show(id)}`);
    seen.add(id);
    if (!Array.isArray(item.gold) || !item.gold.length) throw new InputError(`${path}:${number}: 'gold' must be a non-empty list`);
    const ranges: Range[] = [];
    for (const spec of item.gold) {
      try {
        ranges.push(resolveGold(corpus, spec));
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        problems.push(`${id}: ${error.message}`);
      }
    }
    queries.push({
      id, type: String(item.type), query: String(item.query),
      gold: ranges, goldRefs: ranges.map((r) => corpus.reference(...r)),
    });
  });
  if (problems.length) {
    throw new InputError(`gold references that do not resolve against this corpus:\n  ${problems.join('\n  ')}`);
  }
  if (!queries.length) throw new InputError(`${path}: no queries`);
  return queries;
}

/** Token-level F1 between a returned range and a gold range (both inclusive atom ranges). */
export function tokenF1(corpus: Corpus, result: Range, gold: Range): number {
  const [low, high] = [Math.max(result[0], gold[0]), Math.min(result[1], gold[1])];
  if (low > high) return 0;
  const shared = corpus.tokens(low, high);
  const precision = shared / corpus.tokens(...result);
  const recall = shared / corpus.tokens(...gold);
  return (2 * precision * recall) / (precision + recall);
}

export class Variant {
  constructor(
    readonly granularity: string, // "multi" or one level name
    readonly expand: boolean,
  ) {}

  get levels(): string[] | null {
    return this.granularity === 'multi' ? null : [this.granularity];
  }

  cells(): string[] {
    return [this.granularity, this.expand ? 'parent' : 'hit only'];
  }

  describe(): string {
    return this.cells().join(', ');
  }
}

export function variantsFor(names: string[]): Variant[] {
  const singles = [...names].reverse(); // innermost first
  const granularities = singles.length > 1 ? ['multi', ...singles] : singles;
  return granularities.flatMap((g) => [new Variant(g, false), new Variant(g, true)]);
}

export type QueryScore = {
  id: string;
  type: string;
  firstHit: number | null; // rank of the first size-aware hit
  firstOverlap: number | null; // rank of the first result sharing any text with a gold range
  tokensTop5: number;
  sizes: number[];
  latencyMs: number;
  topReference: string;
};

export function scoreQuery(corpus: Corpus, query: EvalQuery, results: SearchResult[], latencyMs: number): QueryScore {
  let firstHit: number | null = null;
  let firstOverlap: number | null = null;
  results.forEach((result, i) => {
    const rank = i + 1;
    const span: Range = [result.start, result.end];
    if (firstOverlap === null && query.gold.some((g) => span[0] <= g[1] && g[0] <= span[1])) firstOverlap = rank;
    if (firstHit === null && Math.max(...query.gold.map((g) => tokenF1(corpus, span, g))) >= F1_THRESHOLD) firstHit = rank;
  });
  const top = results.slice(0, 5);
  return {
    id: query.id, type: query.type, firstHit, firstOverlap,
    tokensTop5: top.reduce((sum, r) => sum + r.tokens, 0),
    sizes: top.map((r) => r.tokens),
    latencyMs,
    topReference: top.length ? top[0].reference : '',
  };
}

export type Row = { [metric: string]: number };

export function summarise(scores: QueryScore[]): Row {
  const n = scores.length;
  if (n === 0) throw new InputError('no queries to summarise');
  const row: Row = { n };
  for (const cutoff of CUTOFFS) {
    row[`hit@${cutoff}`] = scores.filter((s) => s.firstHit !== null && s.firstHit <= cutoff).length / n;
  }
  row.mrr = scores.reduce((sum, s) => sum + (s.firstHit ? 1 / s.firstHit : 0), 0) / n;
  row['any@5'] = scores.filter((s) => s.firstOverlap !== null && s.firstOverlap <= 5).length / n;
  row['tokens@5'] = scores.reduce((sum, s) => sum + s.tokensTop5, 0) / n;
  const sizes = scores.flatMap((s) => s.sizes).sort((a, b) => a - b);
  row.size_p50 = percentile(sizes, 50);
  row.size_p90 = percentile(sizes, 90);
  row.latency_ms = median(scores.map((s) => s.latencyMs));
  return row;
}

export class Ablation {
  constructor(
    readonly corpus: string,
    readonly model: string,
    readonly k: number,
    readonly repeats: number,
    readonly queries: EvalQuery[],
    readonly variants: Variant[],
    readonly scores: Map<Variant, QueryScore[]>,
    readonly embedMs: number,
  ) {}

  get types(): string[] {
    return [...new Set(this.queries.map((query) => query.type))];
  }

  table(qtype: string | null = null): Map<Variant, Row> {
    return new Map(
      this.variants.map((variant) => [
        variant,
        summarise(this.scores.get(variant)!.filter((s) => qtype === null || s.type === qtype)),
      ]),
    );
  }
}

export async function runAblation(
  searcher: Searcher,
  queries: EvalQuery[],
  { k = 10, repeats = 3, variants, progress }: {
    k?: number;
    repeats?: number;
    variants?: Variant[];
    progress?: (done: number, total: number) => void;
  } = {},
): Promise<Ablation> {
  if (!queries.length) throw new InputError('no queries');
  const corpus = searcher.corpus;
  variants ??= variantsFor(levelNames(corpus.config));
  repeats = Math.max(1, repeats);
  const vectors = new Map<string, number[]>();
  const embedMs: number[] = [];
  for (const query of queries) {
    // one embedding per query, reused by every variant
    const started = performance.now();
    vectors.set(query.id, await searcher.embedQuery(query.query));
    embedMs.push(performance.now() - started);
  }
  const scores = new Map<Variant, QueryScore[]>();
  for (const [i, variant] of variants.entries()) {
    const rows: QueryScore[] = [];
    for (const query of queries) {
      const timings: number[] = [];
      let results: SearchResult[] = [];
      for (let r = 0; r < repeats; r++) {
        const started = performance.now();
        results = await searcher.search(query.query, k, {
          levels: variant.levels, expand: variant.expand, queryVector: vectors.get(query.id),
        });
        timings.push(performance.now() - started);
      }
      rows.push(scoreQuery(corpus, query, results, median(timings)));
    }
    scores.set(variant, rows);
    progress?.(i + 1, variants.length);
  }
  return new Ablation(corpus.config.name, searcher.embedder.model, k, repeats, [...queries], variants, scores, median(embedMs));
}

/** Compare tuples of numbers element by element. */
const byKeys = <T>(key: (item: T) => number[]) => (a: T, b: T): number => {
  const [ka, kb] = [key(a), key(b)];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
};

/**
 * Best variant by size-aware MRR, then hit@1, then fewer tokens, then lower latency.
 *
 * Also returns the variants within half a query's worth of MRR of the best: at this sample size
 * they cannot be told apart.
 */
export function recommend(table: Map<Variant, Row>): [Variant, Row, Variant[], number] {
  const ranked = [...table].sort(
    byKeys(([, row]) => [-row.mrr, -row['hit@1'], row['tokens@5'], row.latency_ms]),
  );
  const [bestVariant, best] = ranked[0];
  const tolerance = 0.5 / best.n;
  const near = ranked.slice(1).filter(([, row]) => best.mrr - row.mrr <= tolerance).map(([variant]) => variant);
  return [bestVariant, best, near, tolerance];
}

export function macroBest(ablation: Ablation): [Variant, number] {
  const tables = ablation.types.map((qtype) => ablation.table(qtype));
  const averages = new Map(
    ablation.variants.map((v) => [v, tables.reduce((sum, t) => sum + t.get(v)!.mrr, 0) / tables.length]),
  );
  const overall = ablation.table();
  const key = (v: Variant) => [-averages.get(v)!, overall.get(v)!['tokens@5']];
  const best = ablation.variants.reduce((winner, v) => (byKeys(key)(v, winner) < 0 ? v : winner));
  return [best, averages.get(best)!];
}

function markdownTable(headers: string[], rows: unknown[][]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => ' --- ').join('|')}|`,
    ...rows.map((row) => `| ${row.map(String).join(' | ')} |`),
  ];
}

export function renderReport(ablation: Ablation): string {
  const counts = new Map<string, number>();
  for (const query of ablation.queries) counts.set(query.type, (counts.get(query.type) ?? 0) + 1);
  const countText = `{${[...counts].map(([type, n]) => `${show(type)}: ${n}`).join(', ')}}`;
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const out = [
    `# Evaluation: ${ablation.corpus}`, '',
    `Generated ${now} UTC; dense model \`${ablation.model}\`.`,
    `${ablation.queries.length} queries: ${countText}. Top ${ablation.k} results per query.`, '',
    `A hit requires token-range F1 >= ${F1_THRESHOLD} against a gold passage. ` +
      'This penalizes results that are too broad or too narrow. Parent expansion is scored on the returned text.',
    'Latency excludes query embeddings, which are computed once per query for this evaluation and reused ' +
      `across variants (median embedding time: ${fixed(ablation.embedMs, 0)} ms). ` +
      `Search latency is the median of ${ablation.repeats} runs per query.`, '',
  ];
  for (const qtype of [null, ...ablation.types]) {
    out.push(`## ${qtype ?? 'All queries'}`, '');
    out.push(
      ...markdownTable(
        ['levels', 'context', 'hit@1', 'hit@3', 'hit@5', 'MRR', 'tokens in top 5', 'latency ms'],
        [...ablation.table(qtype)].map(([variant, row]) => [
          ...variant.cells(),
          ...['hit@1', 'hit@3', 'hit@5', 'mrr'].map((key) => fixed(row[key], 2)),
          fixed(row['tokens@5'], 0),
          fixed(row.latency_ms, 1),
        ]),
      ),
    );
    out.push('');
  }
  const [best, average] = macroBest(ablation);
  out.push(
    `Best overall setting on this query set: **${best.describe()}** (macro MRR ${fixed(average, 2)}).`,
    'This is a small evaluation set; treat small differences cautiously.', '', '## Per-query results', '',
  );
  out.push(
    ...markdownTable(
      ['id', 'type', 'first hit rank', 'top result', 'acceptable answers'],
      ablation.scores.get(best)!.map((score, i) => [
        score.id, score.type, score.firstHit || '-', score.topReference || '-', ablation.queries[i].goldRefs.join('; '),
      ]),
    ),
  );
  return out.join('\n') + '\n';
}

export function resultsJson(ablation: Ablation): { [key: string]: unknown } {
  const block = (qtype: string | null) =>
    [...ablation.table(qtype)].map(([v, row]) => ({ granularity: v.granularity, expand: v.expand, ...row }));
  return {
    corpus: ablation.corpus, model: ablation.model, k: ablation.k, f1_threshold: F1_THRESHOLD,
    all: block(null),
    by_type: Object.fromEntries(ablation.types.map((qtype) => [qtype, block(qtype)])),
    first_hit_rank: Object.fromEntries(
      ablation.variants.map((v) => [
        v.describe(),
        Object.fromEntries(ablation.scores.get(v)!.map((s) => [s.id, s.firstHit])),
      ]),
    ),
  };
}

export function writeReport(ablation: Ablation, outPath: string): string {
  const text = renderReport(ablation);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text, 'utf-8');
  const jsonPath = outPath.slice(0, outPath.length - extname(outPath).length) + '.json';
  writeFileSync(jsonPath, JSON.stringify(resultsJson(ablation), null, 2), 'utf-8');
  return text;
}
