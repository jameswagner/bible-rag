/** Load a flat list of records, normalise it, and say exactly what was changed. */
import { readFileSync } from 'node:fs';
import type { CorpusConfig, LevelConfig } from './config.js';
import { InputError } from './errors.js';
import { arraysEqual, isInt, isObject, isSpace, lstrip, median, show, split, typeName } from './util.js';

export type PathValue = string | number | null;
export type Path = PathValue[];

const INVISIBLE = new Set(['​', '‌', '‍', '⁠', '﻿', '­']);
const PLAIN = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?\'"()-');
const CONTROL = /^\p{Cc}$/u;
const SPACE_RUN = / {2,}/g;

// Everything the loader may change, in the order it is reported.
export const CHANGES = {
  bom: 'byte-order mark removed from the start of the file',
  unicode_nfc: 'text re-composed to Unicode NFC',
  invisible: 'invisible or control characters removed (zero-width, soft hyphen, ...)',
  leading_marker: 'leading paragraph marker stripped',
  inner_marker: 'paragraph marker removed from inside the text',
  odd_space: 'tab, newline or non-breaking space replaced by a plain space',
  space_run: 'run of spaces collapsed to one',
  trimmed: 'leading or trailing space trimmed',
  level_trimmed: 'whitespace tidied in a level value',
  level_empty: 'empty level value treated as absent',
  level_digits: 'numeric string converted to an integer level value',
  // JSON.parse cannot tell 3.0 from 3, so whole-number floats are accepted without a report entry.
} as const;

export type ChangeKind = keyof typeof CHANGES;

export type Record = {
  index: number; // position in the input file
  path: Path; // one value per level, outermost first; null where the level is absent
  text: string;
};

export type Change = {
  description: string;
  count: number;
  examples: [number, string, string][];
};

function clip(value: unknown, width = 48): string {
  const text = Array.from(typeof value === 'string' ? value : show(value));
  return show(text.length <= width ? text.join('') : text.slice(0, width).join('') + '...');
}

export class NormalizationReport {
  records = 0;
  readonly changes = new Map<ChangeKind, Change>();
  readonly observations: string[] = [];

  constructor(readonly source = '<memory>') {}

  note(kind: ChangeKind, index: number, before: unknown, after: unknown): void {
    let change = this.changes.get(kind);
    if (!change) {
      change = { description: CHANGES[kind], count: 0, examples: [] };
      this.changes.set(kind, change);
    }
    change.count += 1;
    if (change.examples.length < 3) change.examples.push([index, clip(before), clip(after)]);
  }

  count(kind: ChangeKind): number {
    return this.changes.get(kind)?.count ?? 0;
  }

  summary(): string {
    const total = [...this.changes.values()].reduce((sum, change) => sum + change.count, 0);
    return (
      `loaded ${this.records} records from ${this.source}: ` +
      `${total} normalisations of ${this.changes.size} kinds, ${this.observations.length} observations`
    );
  }

  render(): string {
    const lines = [`Loaded ${this.records} records from ${this.source}`, '', 'Normalised (the indexed text differs from the file):'];
    if (!this.changes.size) lines.push('  nothing; the file was already clean');
    for (const kind of Object.keys(CHANGES) as ChangeKind[]) {
      const change = this.changes.get(kind);
      if (!change) continue;
      lines.push(`  ${String(change.count).padStart(7)}  ${change.description}`);
      for (const [index, before, after] of change.examples) {
        lines.push(`           e.g. record ${index}: ${before} -> ${after}`);
      }
    }
    lines.push('', 'Observed (left as it is):');
    lines.push(...(this.observations.length ? this.observations.map((item) => `  ${item}`) : ['  nothing unusual']));
    return lines.join('\n');
  }
}

function normalizeText(text: string, markers: string[], index: number, report: NormalizationReport): string {
  const composed = text.normalize('NFC');
  if (composed !== text) report.note('unicode_nfc', index, text, composed);
  let visible = '';
  for (const ch of composed) {
    if (!INVISIBLE.has(ch) && (isSpace(ch) || !CONTROL.test(ch))) visible += ch;
  }
  if (visible !== composed) report.note('invisible', index, composed, visible);

  text = visible;
  let stripped = false;
  for (let again = true; again; ) {
    again = false;
    const head = lstrip(text);
    const marker = markers.find((m) => head.startsWith(m));
    if (marker !== undefined) {
      text = lstrip(head.slice(marker.length));
      stripped = again = true;
    }
  }
  if (stripped) report.note('leading_marker', index, visible, text);
  for (const marker of markers) {
    if (text.includes(marker)) {
      const cleaned = text.replaceAll(marker, ' ');
      report.note('inner_marker', index, text, cleaned);
      text = cleaned;
    }
  }

  let plain = '';
  for (const ch of text) plain += ch !== ' ' && isSpace(ch) ? ' ' : ch;
  if (plain !== text) report.note('odd_space', index, text, plain);
  const single = plain.replace(SPACE_RUN, ' ');
  if (single !== plain) report.note('space_run', index, plain, single);
  const final = single.replace(/^ +| +$/g, '');
  if (final !== single) report.note('trimmed', index, single, final);
  return final;
}

function normalizeValue(value: unknown, level: LevelConfig, index: number, report: NormalizationReport): PathValue {
  if (value === null || value === undefined) return null;
  const where = `record ${index}: level ${show(level.name)} (key ${show(level.key)})`;
  if (typeof value === 'boolean') throw new InputError(`${where} must be a string or an integer, got a boolean`);
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value;
    throw new InputError(`${where} must be a string or an integer, got ${show(value)}`);
  }
  if (typeof value === 'string') {
    const tidy = split(value.normalize('NFC')).join(' ');
    if (tidy !== value) report.note('level_trimmed', index, value, tidy);
    if (!tidy) {
      report.note('level_empty', index, value, null);
      return null;
    }
    if (/^[0-9]+$/.test(tidy)) {
      report.note('level_digits', index, tidy, Number(tidy));
      return Number(tidy);
    }
    return tidy;
  }
  throw new InputError(`${where} must be a string or an integer, got ${typeName(value)}`);
}

const where = (path: Path, levels: LevelConfig[]): string =>
  levels.map((level, i) => `${level.name}=${show(path[i])}`).join(', ');

/** Records must be in document order: every named unit is one contiguous run. */
function checkStructure(records: Record[], levels: LevelConfig[]): void {
  const n = levels.length;
  const seen: Set<PathValue>[] = levels.map(() => new Set());
  let previous: Path | null = null;
  for (const record of records) {
    const path = record.path;
    let depth = 0;
    if (previous !== null) while (depth < n && path[depth] === previous[depth]) depth++;
    if (depth === n) {
      throw new InputError(
        `record ${record.index}: same position as the previous record (${where(path, levels)}); ` +
          'every record needs its own place in the hierarchy',
      );
    }
    const value = path[depth];
    if (value !== null) {
      if (seen[depth].has(value)) {
        throw new InputError(
          `record ${record.index}: ${levels[depth].name} ${show(value)} appears again after other content ` +
            `(${where(path, levels)}); records must be in document order with each unit contiguous`,
        );
      }
      seen[depth].add(value);
    }
    for (let deeper = depth + 1; deeper < n; deeper++) {
      seen[deeper] = path[deeper] === null ? new Set() : new Set([path[deeper]]);
    }
    previous = path;
  }
}

/** Entries by descending count, ties in first-seen order. */
const mostCommon = <T>(counts: Map<T, number>): [T, number][] => [...counts].sort((a, b) => b[1] - a[1]);

function observe(records: Record[], config: CorpusConfig, extra: Map<string, number>, report: NormalizationReport): void {
  config.levels.forEach((level, i) => {
    const depth = i + 1;
    const units = records.filter((record, r) => r === 0 || !arraysEqual(record.path, records[r - 1].path, depth)).length;
    const absent = records.filter((record) => record.path[depth - 1] === null).length;
    let line = `level ${show(level.name)}: ${units} units`;
    if (absent) line += `; ${absent} records sit outside any ${level.name} (ragged)`;
    report.observations.push(line);
    const irregular: [number, number, number][] = [];
    for (let r = 1; r < records.length; r++) {
      const [before, after] = [records[r - 1].path, records[r].path];
      if (!arraysEqual(before, after, depth - 1)) continue;
      const [a, b] = [before[depth - 1], after[depth - 1]];
      if (isInt(a) && isInt(b) && b !== a && b !== a + 1) irregular.push([records[r].index, a, b]);
    }
    if (irregular.length) {
      const shown = irregular.slice(0, 3).map(([r, a, b]) => `record ${r}: ${a} -> ${b}`).join(', ');
      report.observations.push(
        `level ${show(level.name)}: numbering skips or goes backwards ${irregular.length} times (${shown})`,
      );
    }
  });

  const lengths = records.map((record) => split(record.text).length);
  // First index of the min and of the max.
  const low = lengths.reduce((best, n, i) => (n < lengths[best] ? i : best), 0);
  const high = lengths.reduce((best, n, i) => (n > lengths[best] ? i : best), 0);
  report.observations.push(
    `text length in words: min ${lengths[low]} (record ${records[low].index}), ` +
      `median ${median(lengths)}, max ${lengths[high]} (record ${records[high].index})`,
  );
  const odd = new Map<string, number>();
  for (const record of records) {
    for (const ch of record.text) if (!PLAIN.has(ch)) odd.set(ch, (odd.get(ch) ?? 0) + 1);
  }
  if (odd.size) {
    // JS has no Unicode name table, so characters are shown by code point.
    const shown = mostCommon(odd)
      .slice(0, 12)
      .map(([ch, count]) => `${show(ch)} x${count} (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`)
      .join(', ');
    const more = odd.size > 12 ? ` and ${odd.size - 12} more` : '';
    report.observations.push(`characters beyond plain letters, digits and basic punctuation: ${shown}${more}`);
  }
  for (const [key, count] of [...extra].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    report.observations.push(`key ${show(key)} is present on ${count} records but not used by the config`);
  }
}

export function parseRecords(
  raw: unknown,
  config: CorpusConfig,
  report = new NormalizationReport(),
): [Record[], NormalizationReport] {
  if (!Array.isArray(raw)) throw new InputError(`input must be a JSON array of records, got ${typeName(raw)}`);
  if (!raw.length) throw new InputError('input contains no records');
  const known = new Set([...config.levels.map((level) => level.key), config.textKey]);
  const extra = new Map<string, number>();
  const records: Record[] = raw.map((item: unknown, index): Record => {
    if (!isObject(item)) throw new InputError(`record ${index}: expected an object, got ${typeName(item)}`);
    if (!(config.textKey in item)) throw new InputError(`record ${index}: missing text key ${show(config.textKey)}`);
    const text = item[config.textKey];
    if (typeof text !== 'string') {
      throw new InputError(`record ${index}: ${show(config.textKey)} must be a string, got ${typeName(text)}`);
    }
    const clean = normalizeText(text, config.markers, index, report);
    if (!clean) throw new InputError(`record ${index}: text is empty after normalization`);
    const path = config.levels.map((level) => normalizeValue(item[level.key], level, index, report));
    config.levels.forEach((level, i) => {
      if (path[i] === null && !level.optional) {
        throw new InputError(
          `record ${index}: missing value for level ${show(level.name)} (key ${show(level.key)}); ` +
            'mark the level optional = true if the structure is ragged',
        );
      }
    });
    for (const key of Object.keys(item)) if (!known.has(key)) extra.set(key, (extra.get(key) ?? 0) + 1);
    return { index, path, text: clean };
  });
  checkStructure(records, config.levels);
  observe(records, config, extra, report);
  report.records = records.length;
  return [records, report];
}

export function loadRecords(path: string, config: CorpusConfig): [Record[], NormalizationReport] {
  let data = readFileSync(path);
  const report = new NormalizationReport(path);
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    data = data.subarray(3);
    report.note('bom', 0, '﻿', '');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch (error) {
    throw new InputError(`${path}: not valid UTF-8 JSON (${(error as Error).message})`);
  }
  return parseRecords(raw, config, report);
}
