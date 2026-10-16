/**
 * Turn a corpus into chunks at every level of its hierarchy.
 *
 * Per level, with that level's (min_tokens, max_tokens):
 *
 * - a unit that fits is one chunk ("unit");
 * - a unit above max_tokens is split at the boundaries of the next level down, recursively, and the
 *   pieces are packed into balanced parts ("split"), so nothing oversized is embedded whole;
 * - any chunk below min_tokens also gets a context window ("window") grown atom by atom, forward
 *   and backward in turn, until it reaches min_tokens. Windows may cross inner boundaries (chapter,
 *   section) but never the top-level unit.
 *
 * The unit and split chunks of a level tile the whole document, so every leaf is reachable at every
 * level. Windows are extra.
 */
import { bisectRight } from './util.js';
import { packBalanced } from './splitting.js';
import type { Corpus, Range } from './structure.js';

export type ChunkKind = 'unit' | 'split' | 'window';

export type Chunk = {
  depth: number; // 1 = outermost level
  level: string;
  kind: ChunkKind;
  start: number; // first atom, inclusive
  end: number; // last atom, inclusive
  tokens: number;
};

type Piece = [start: number, end: number, kind: ChunkKind];

export function percentile(sortedValues: number[], q: number): number {
  if (!sortedValues.length) return 0;
  const rank = Math.max(1, Math.ceil((q / 100) * sortedValues.length));
  return sortedValues[Math.min(rank, sortedValues.length) - 1];
}

export class ChunkPlan {
  readonly chunks: Chunk[] = [];
  private readonly pieceStarts = new Map<number, number[]>();
  private readonly pieceEnds = new Map<number, number[]>();

  constructor(readonly corpus: Corpus) {
    const seen = new Set<string>();
    corpus.config.levels.forEach((level, i) => {
      const depth = i + 1;
      const pieces: Piece[] = [];
      for (const [a, b] of corpus.runs(depth)) {
        const parts = this.split(a, b, depth, level.maxTokens);
        const kind = parts.length === 1 ? 'unit' : 'split';
        pieces.push(...parts.map(([s, e]): Piece => [s, e, kind]));
      }
      this.pieceStarts.set(depth, pieces.map((piece) => piece[0]));
      this.pieceEnds.set(depth, pieces.map((piece) => piece[1]));
      for (const [s, e, kind] of pieces) {
        seen.add(`${depth}:${s}:${e}`);
        this.chunks.push({ depth, level: level.name, kind, start: s, end: e, tokens: corpus.tokens(s, e) });
      }
      for (const [s, e] of this.windows(pieces, level.minTokens, level.maxTokens)) {
        if (!seen.has(`${depth}:${s}:${e}`)) {
          seen.add(`${depth}:${s}:${e}`);
          this.chunks.push({ depth, level: level.name, kind: 'window', start: s, end: e, tokens: corpus.tokens(s, e) });
        }
      }
    });
  }

  private split(firstLeaf: number, lastLeaf: number, depth: number, limit: number): Range[] {
    const corpus = this.corpus;
    const [start, end] = corpus.atomRange(firstLeaf, lastLeaf);
    if (corpus.tokens(start, end) <= limit) return [[start, end]];
    let items: Range[];
    if (depth >= corpus.nLevels) {
      items = [];
      for (let i = start; i <= end; i++) items.push([i, i]);
    } else {
      items = corpus.children(depth, firstLeaf, lastLeaf).flatMap(([a, b]) => this.split(a, b, depth + 1, limit));
    }
    const sizes = items.map(([s, e]) => corpus.tokens(s, e));
    return packBalanced(sizes, limit).map(([i, j]): Range => [items[i][0], items[j - 1][1]]);
  }

  private *windows(pieces: Piece[], low: number, high: number): Generator<Range> {
    const corpus = this.corpus;
    const atoms = corpus.atoms;
    let covered = -1; // end of the last window; a tiny piece inside it needs no window of its own
    for (const [s, e] of pieces) {
      let total = corpus.tokens(s, e);
      if (total >= low || e <= covered) continue;
      const [groupStart, groupEnd] = corpus.topGroup(s);
      let [ws, we, forward] = [s, e, true];
      while (total < low) {
        const canForward = we < groupEnd && total + atoms[we + 1].tokens <= high;
        const canBack = ws > groupStart && total + atoms[ws - 1].tokens <= high;
        if (!(canForward || canBack)) break;
        if (canForward && (forward || !canBack)) {
          we += 1;
          total += atoms[we].tokens;
        } else {
          ws -= 1;
          total += atoms[ws].tokens;
        }
        forward = !forward;
      }
      if (ws !== s || we !== e) {
        covered = we;
        yield [ws, we];
      }
    }
  }

  /** The unit/split chunk at `depth` that holds `atom` (used for parent expansion). */
  pieceAt(depth: number, atom: number): Range {
    const starts = this.pieceStarts.get(depth)!;
    const i = bisectRight(starts, atom) - 1;
    return [starts[i], this.pieceEnds.get(depth)![i]];
  }
}
