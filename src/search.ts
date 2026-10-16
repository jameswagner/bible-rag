/** Dense search, parent expansion, and overlap removal. */
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { ChunkPlan } from './chunking.js';
import { depthOf, levelNames } from './config.js';
import type { Embedder } from './embedding.js';
import { InputError } from './errors.js';
import { DENSE, embedHash, embedText, modelSignature } from './indexer.js';
import { show } from './util.js';
import type { Corpus, Range } from './structure.js';

const PAYLOAD = ['level', 'depth', 'start', 'end', 'embed_hash'];

/** The collection was built from different data, config or embedding model. */
export class StaleIndexError extends Error {
  override name = 'StaleIndexError';
}

export type SearchResult = {
  reference: string; // names the returned text
  text: string;
  score: number;
  level: string; // level of the chunk that matched
  tokens: number;
  matched: string; // reference of the chunk that matched (differs from `reference` after expansion)
  start: number; // atom range of the returned text
  end: number;
  hitStart: number; // atom range of the chunk that matched
  hitEnd: number;
};

export type SearchOptions = {
  levels?: string[] | null;
  expand?: boolean;
  queryVector?: number[];
};

type Payload = { [key: string]: unknown };
type Candidate = { payload: Payload; score: number };

export class Searcher {
  private readonly signature: string;

  constructor(
    readonly corpus: Corpus,
    readonly plan: ChunkPlan,
    readonly embedder: Embedder,
    readonly client: QdrantClient,
    readonly collection: string,
  ) {
    this.signature = modelSignature(embedder);
  }

  async embedQuery(query: string): Promise<number[]> {
    return (await this.embedder.embed([query]))[0];
  }

  /** Return up to k non-overlapping results, scored by cosine similarity. */
  async search(query: string, k = 5, { levels = null, expand = true, queryVector }: SearchOptions = {}): Promise<SearchResult[]> {
    query = query.trim();
    if (!query) throw new InputError('query must not be empty');
    if (k < 1) throw new InputError('k must be at least 1');
    const config = this.corpus.config;
    let filter;
    if (levels !== null) {
      const names = [...new Set(levels)];
      if (!names.length) throw new InputError(`levels must name at least one of ${show(levelNames(config))}`);
      for (const name of names) depthOf(config, name); // throws for an unknown level
      filter = { must: [{ key: 'level', match: { any: names } }] };
    }
    queryVector ??= await this.embedQuery(query);
    const response = await this.client.query(this.collection, {
      query: queryVector, using: DENSE, filter, limit: Math.max(50, 10 * k),
      with_payload: PAYLOAD, with_vector: false,
    });
    const candidates = response.points.map((point) => ({ payload: point.payload ?? {}, score: point.score }));
    return this.assemble(candidates, k, expand);
  }

  /** Widen a hit to the chunk one level up that holds it, if the result fits the budget. */
  expand(depth: number, start: number, end: number): Range {
    if (depth <= 1) return [start, end];
    const corpus = this.corpus;
    let [ps, pe] = this.plan.pieceAt(depth - 1, start);
    const [qs, qe] = this.plan.pieceAt(depth - 1, end);
    if (ps !== qs || pe !== qe) {
      // a window straddling two parents: keep the one holding most of it
      if (corpus.tokens(start, Math.min(end, pe)) < corpus.tokens(Math.max(start, qs), end)) [ps, pe] = [qs, qe];
    }
    const wide: Range = [Math.min(start, ps), Math.max(end, pe)];
    if (corpus.tokens(...wide) > corpus.config.parentMaxTokens) return [start, end];
    return wide;
  }

  private check(payload: Payload, start: number, end: number): void {
    let stale = !(0 <= start && start <= end && end < this.corpus.atoms.length);
    if (!stale) {
      const expected = embedHash(this.signature, embedText(this.corpus, start, end));
      stale = payload.embed_hash !== expected;
    }
    if (stale) {
      throw new StaleIndexError(
        `collection ${show(this.collection)} does not match the loaded data, config or embedding model; ` +
          're-run `hsearch index --recreate`',
      );
    }
  }

  private assemble(candidates: Candidate[], k: number, expand: boolean): SearchResult[] {
    const corpus = this.corpus;
    const results: SearchResult[] = [];
    const taken: Range[] = [];
    for (const { payload, score } of candidates) {
      const [depth, start, end] = [Number(payload.depth), Number(payload.start), Number(payload.end)];
      if (!(0 <= start && start <= end && end < corpus.atoms.length)) this.check(payload, start, end);
      const shown = expand ? this.expand(depth, start, end) : ([start, end] as Range);
      // Best-first: anything that shares text with an accepted result is already represented.
      if (taken.some(([tStart, tEnd]) => shown[0] <= tEnd && tStart <= shown[1])) continue;
      this.check(payload, start, end);
      taken.push(shown);
      results.push({
        reference: corpus.reference(...shown),
        text: corpus.text(...shown),
        score,
        level: String(payload.level),
        tokens: corpus.tokens(...shown),
        matched: corpus.reference(start, end),
        start: shown[0],
        end: shown[1],
        hitStart: start,
        hitEnd: end,
      });
      if (results.length === k) break;
    }
    return results;
  }
}
