/**
 * Small text and number helpers. Whitespace handling, value formatting in messages and rounding
 * are defined here once so chunk boundaries, references and embed hashes stay stable.
 */

// Whitespace: wider than JS \s at the low end (\x1c-\x1f, \x85), and without ﻿.
const SPACE_CLASS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
export const SPACE_RUN = new RegExp(`[${SPACE_CLASS}]+`, 'g');
const ONE_SPACE = new RegExp(`^[${SPACE_CLASS}]$`);
const LEADING = new RegExp(`^[${SPACE_CLASS}]+`);
const TRAILING = new RegExp(`[${SPACE_CLASS}]+$`);
const NON_PRINTABLE = /[\p{C}\p{Z}]/u;

export const isSpace = (ch: string): boolean => ONE_SPACE.test(ch);

/** Split on runs of whitespace, dropping empty pieces. */
export const split = (text: string): string[] => text.split(SPACE_RUN).filter(Boolean);

export const lstrip = (text: string): string => text.replace(LEADING, '');

export const strip = (text: string): string => text.replace(LEADING, '').replace(TRAILING, '');

/** Quoted, escaped display form of the values that appear in messages: null, bools, numbers, strings, lists. */
export function show(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (typeof value !== 'string') return String(value);
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of value) {
    if (ch === '\\' || ch === quote) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch !== ' ' && NON_PRINTABLE.test(ch)) {
      const code = ch.codePointAt(0)!;
      const hex = code.toString(16).padStart(code < 0x100 ? 2 : code < 0x10000 ? 4 : 8, '0');
      out += `\\${code < 0x100 ? 'x' : code < 0x10000 ? 'u' : 'U'}${hex}`;
    } else out += ch;
  }
  return quote + out + quote;
}

/** Type name of a JSON value, for error messages. */
export function typeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  return Array.isArray(value) ? 'list' : 'dict';
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

export const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** Fixed-point formatting of the exact binary value, rounded half to even (toFixed rounds ties up). */
export function fixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : x < 0 ? '-inf' : 'nan';
  const [whole, fraction] = Math.abs(x).toFixed(100).split('.');
  const rest = fraction.slice(digits);
  const kept = BigInt(whole + fraction.slice(0, digits));
  const odd = kept % 2n === 1n;
  const up = rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || odd));
  const text = (kept + (up ? 1n : 0n)).toString().padStart(digits + 1, '0');
  const body = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  return x < 0 ? `-${body}` : body;
}

export function median(values: number[]): number {
  if (!values.length) throw new Error('no median for empty data');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function bisectLeft(items: number[], x: number, lo = 0, hi = items.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function bisectRight(items: number[], x: number, lo = 0, hi = items.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < items[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Compare the first `length` items of two arrays (the whole arrays when no length is given). */
export function arraysEqual(a: readonly unknown[], b: readonly unknown[], length?: number): boolean {
  const n = length ?? Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Characters in common by repeatedly taking the longest matching block, then recursing on each side. */
function matchingCharacters(a: string[], b: string[]): number {
  let total = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    let bestI = alo;
    let bestJ = blo;
    let bestSize = 0;
    let lengths = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue;
        const k = (lengths.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestSize) [bestI, bestJ, bestSize] = [i - k + 1, j - k + 1, k];
      }
      lengths = next;
    }
    if (!bestSize) continue;
    total += bestSize;
    queue.push([alo, bestI, blo, bestJ], [bestI + bestSize, ahi, bestJ + bestSize, bhi]);
  }
  return total;
}

/** The closest spellings to `word`, best first, for "did you mean" hints. */
export function closeMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const b = Array.from(word);
  const scored: [number, string][] = [];
  for (const x of possibilities) {
    const a = Array.from(x);
    const total = a.length + b.length;
    const ratio = total ? (2 * matchingCharacters(a, b)) / total : 1;
    if (ratio >= cutoff) scored.push([ratio, x]);
  }
  scored.sort(([r1, x1], [r2, x2]) => r2 - r1 || (x1 < x2 ? 1 : x1 > x2 ? -1 : 0));
  return scored.slice(0, n).map(([, x]) => x);
}

export type FormatPart = { literal: string } | { field: string };

/** Parse a template that uses plain {field} placeholders and {{ }} escapes. */
export function parseFormat(template: string): FormatPart[] {
  const parts: FormatPart[] = [];
  let literal = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if ((ch === '{' || ch === '}') && template[i + 1] === ch) {
      literal += ch;
      i++;
    } else if (ch === '}') {
      throw new Error("Single '}' encountered in format string");
    } else if (ch === '{') {
      const close = template.indexOf('}', i);
      if (close < 0) throw new Error("expected '}' before end of string");
      const field = template.slice(i + 1, close);
      if (/[{!:]/.test(field)) throw new Error('only plain {field} placeholders are supported');
      if (literal) parts.push({ literal });
      parts.push({ field });
      literal = '';
      i = close;
    } else {
      literal += ch;
    }
  }
  if (literal) parts.push({ literal });
  return parts;
}

export function format(template: string, values: Record<string, unknown>): string {
  return parseFormat(template)
    .map((part) => {
      if ('literal' in part) return part.literal;
      if (!(part.field in values)) throw new Error(`KeyError: ${show(part.field)}`);
      return String(values[part.field]);
    })
    .join('');
}

/** Read a key with a fallback: a key that is present keeps its value, even null. */
export const get = (table: Record<string, unknown>, key: string, fallback: unknown): unknown =>
  key in table ? table[key] : fallback;
