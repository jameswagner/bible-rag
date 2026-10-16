/** The corpus in memory: leaves, atoms, the unit runs at every level, and references. */
import type { CorpusConfig } from './config.js';
import { atomMaxTokens, levelNames } from './config.js';
import { InputError } from './errors.js';
import type { Path, Record } from './loader.js';
import { arraysEqual, bisectLeft, bisectRight, closeMatches, show } from './util.js';
import { getBuilder, type Builder, type LevelLabel, type RefSpan } from './references/index.js';
import { splitText } from './splitting.js';
import type { TokenCounter } from './tokens.js';

export type Range = [number, number];

/** The smallest indexable piece: a leaf, or one part of a leaf too big to embed comfortably. */
export type Atom = {
  ord: number;
  leaf: number;
  part: number; // 1-based position within its leaf
  parts: number; // how many atoms the leaf was split into
  text: string;
  tokens: number;
};

export type Leaf = {
  index: number;
  recordIndex: number;
  path: Path;
  firstAtom: number;
  lastAtom: number;
};

/**
 * Every chunk, result and gold reference is a contiguous range of atoms in this object.
 *
 * A "unit" at depth d is a maximal run of consecutive leaves sharing the first d path values.
 * Absent values (null) compare equal, so a preamble outside any part forms its own unnamed run.
 */
export class Corpus {
  readonly nLevels: number;
  readonly atoms: Atom[] = [];
  readonly leaves: Leaf[] = [];
  private readonly builder: Builder;
  private readonly labels: LevelLabel[];
  private readonly prefix: number[] = [0];
  private readonly starts = new Map<number, number[]>();
  private readonly startSets = new Map<number, Set<number>>();
  private units: Map<string, { key: Path; range: Range }> | null = null;

  constructor(
    readonly config: CorpusConfig,
    records: Record[],
    readonly counter: TokenCounter,
    builder?: Builder,
  ) {
    if (!records.length) throw new InputError('corpus has no records');
    this.nLevels = config.levels.length;
    this.builder = builder ?? getBuilder(config.referenceStyle);
    this.labels = config.levels.map((level) => ({ name: level.name, label: level.label }));

    const limit = atomMaxTokens(config);
    const counts = counter.countMany(records.map((record) => record.text));
    records.forEach((record, index) => {
      let pieces: [string, number][];
      if (counts[index] <= limit) {
        pieces = [[record.text, counts[index]]];
      } else {
        const texts = splitText(record.text, limit, (text) => counter.count(text));
        const sizes = counter.countMany(texts);
        pieces = texts.map((text, i) => [text, sizes[i]]);
      }
      const first = this.atoms.length;
      pieces.forEach(([text, n], i) => {
        this.atoms.push({ ord: this.atoms.length, leaf: index, part: i + 1, parts: pieces.length, text, tokens: Math.max(Math.trunc(n), 1) });
      });
      this.leaves.push({ index, recordIndex: record.index, path: record.path, firstAtom: first, lastAtom: this.atoms.length - 1 });
    });

    for (const atom of this.atoms) this.prefix.push(this.prefix[this.prefix.length - 1] + atom.tokens);
    for (let depth = 1; depth <= this.nLevels; depth++) {
      const starts = this.leaves
        .filter((leaf, i) => i === 0 || !arraysEqual(leaf.path, this.leaves[i - 1].path, depth))
        .map((leaf) => leaf.index);
      this.starts.set(depth, starts);
      this.startSets.set(depth, new Set(starts));
    }
  }

  // ---- sizes and text -------------------------------------------------

  /** Tokens in atoms start..end inclusive (sum of per-atom counts). */
  tokens(start: number, end: number): number {
    return this.prefix[end + 1] - this.prefix[start];
  }

  text(start: number, end: number): string {
    const out = [this.atoms[start].text];
    for (let i = start + 1; i <= end; i++) {
      const sameLeaf = this.atoms[i].leaf === this.atoms[i - 1].leaf;
      out.push(sameLeaf ? ' ' : this.config.leafSeparator, this.atoms[i].text);
    }
    return out.join('');
  }

  atomRange(firstLeaf: number, lastLeaf: number): Range {
    return [this.leaves[firstLeaf].firstAtom, this.leaves[lastLeaf].lastAtom];
  }

  // ---- unit runs ------------------------------------------------------

  runs(depth: number): Range[] {
    const starts = this.starts.get(depth)!;
    const last = this.leaves.length - 1;
    return starts.map((a, i) => [a, i + 1 < starts.length ? starts[i + 1] - 1 : last]);
  }

  runBounds(depth: number, leaf: number): Range {
    const starts = this.starts.get(depth)!;
    const i = bisectRight(starts, leaf) - 1;
    const last = i + 1 < starts.length ? starts[i + 1] - 1 : this.leaves.length - 1;
    return [starts[i], last];
  }

  /** The runs one level below `depth` inside the leaf range. */
  children(depth: number, firstLeaf: number, lastLeaf: number): Range[] {
    const starts = this.starts.get(depth + 1)!;
    const inside = starts.slice(bisectLeft(starts, firstLeaf), bisectRight(starts, lastLeaf));
    return inside.map((a, n) => [a, n + 1 < inside.length ? inside[n + 1] - 1 : lastLeaf]);
  }

  isFirst(depth: number, leaf: number): boolean {
    return this.startSets.get(depth)!.has(leaf);
  }

  isLast(depth: number, leaf: number): boolean {
    return leaf === this.leaves.length - 1 || this.startSets.get(depth)!.has(leaf + 1);
  }

  /** Atom range of the top-level unit holding this atom. Chunks never leave it. */
  topGroup(atom: number): Range {
    const [first, last] = this.runBounds(1, this.atoms[atom].leaf);
    return this.atomRange(first, last);
  }

  // ---- references -----------------------------------------------------

  span(start: number, end: number): RefSpan {
    const [first, last] = [this.atoms[start], this.atoms[end]];
    const [a, b] = [this.leaves[first.leaf], this.leaves[last.leaf]];
    let depth = this.nLevels;
    if (start === a.firstAtom && end === b.lastAtom) {
      for (let d = 1; d < this.nLevels; d++) {
        if (a.path[d - 1] !== null && b.path[d - 1] !== null && this.isFirst(d, a.index) && this.isLast(d, b.index)) {
          depth = d;
          break;
        }
      }
    }
    return { levels: this.labels, start: a.path, end: b.path, depth, title: this.config.title };
  }

  reference(start: number, end: number): string {
    const text = this.builder(this.span(start, end));
    const [first, last] = [this.atoms[start], this.atoms[end]];
    const notes: string[] = [];
    if (first.leaf === last.leaf) {
      if (first.parts > 1 && (first.part > 1 || last.part < last.parts)) {
        notes.push(
          first.part === last.part
            ? `part ${first.part}/${first.parts}`
            : `parts ${first.part}-${last.part}/${first.parts}`,
        );
      }
    } else {
      if (first.part > 1) notes.push(`from part ${first.part}/${first.parts}`);
      if (last.part < last.parts) notes.push(`to part ${last.part}/${last.parts}`);
    }
    return notes.length ? `${text} [${notes.join('; ')}]` : text;
  }

  // ---- looking units up by path (used for gold references) ------------

  private unitIndex(): Map<string, { key: Path; range: Range }> {
    if (this.units === null) {
      const units = new Map<string, { key: Path; range: Range }>();
      for (let depth = 1; depth <= this.nLevels; depth++) {
        for (const [a, b] of this.runs(depth)) {
          const key = this.leaves[a].path.slice(0, depth);
          const id = JSON.stringify(key);
          if (key[depth - 1] !== null && !units.has(id)) units.set(id, { key, range: [a, b] });
        }
      }
      this.units = units;
    }
    return this.units;
  }

  /** Leaf range of the unit named by a path prefix, e.g. ["Psalms", 23] or ["John", 3, 16]. */
  resolve(path: Path): Range {
    const names = levelNames(this.config);
    if (path.length < 1 || path.length > this.nLevels) {
      throw new InputError(`path ${show(path)} must name 1 to ${this.nLevels} levels (${names.join(', ')})`);
    }
    const units = this.unitIndex();
    const found = units.get(JSON.stringify(path));
    if (found) return found.range;
    for (let depth = 1; depth <= path.length; depth++) {
      const parent = path.slice(0, depth - 1);
      if (path[depth - 1] === null || units.has(JSON.stringify(path.slice(0, depth)))) continue;
      const siblings = [
        ...new Set(
          [...units.values()]
            .filter(({ key }) => key.length === depth && arraysEqual(key, parent, depth - 1))
            .map(({ key }) => String(key[depth - 1])),
        ),
      ].sort();
      const close = closeMatches(String(path[depth - 1]), siblings, 3, 0.5);
      const hint = close.length ? `; did you mean ${close.join(' / ')}?` : '';
      throw new InputError(`no ${names[depth - 1]} ${show(path[depth - 1])} under ${show(parent)}${hint}`);
    }
    throw new InputError(`path ${show(path)} does not name a unit`);
  }
}
