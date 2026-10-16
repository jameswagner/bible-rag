/** Size-bounded splitting helpers shared by the leaf atomiser and the chunk planner. */
import { bisectLeft, SPACE_RUN, strip } from './util.js';

const SPACE = SPACE_RUN.source; // whitespace
const SPLITTERS = [
  new RegExp(`(?<=[.!?])${SPACE}`), // sentences
  new RegExp(`(?<=[;:,])${SPACE}`), // clauses
  new RegExp(SPACE), // words
];

/**
 * Group consecutive items into the fewest groups of at most `limit`, as evenly as possible.
 *
 * Returns half-open index ranges. The fewest groups come from a greedy pass; the cuts are then
 * moved to the boundaries nearest an even share, so there is no tiny trailing remainder. If that
 * would break the limit, the greedy grouping is returned instead.
 */
export function packBalanced(sizes: number[], limit: number): [number, number][] {
  const n = sizes.length;
  if (n === 0) return [];
  const fewest: [number, number][] = [];
  let start = 0;
  let total = 0;
  sizes.forEach((size, i) => {
    if (i > start && total + size > limit) {
      fewest.push([start, i]);
      [start, total] = [i, 0];
    }
    total += size;
  });
  fewest.push([start, n]);
  const k = fewest.length;
  if (k === 1) return fewest;

  const prefix = [0];
  for (const size of sizes) prefix.push(prefix[prefix.length - 1] + size);
  const bounds = [0];
  let previous = 0;
  for (let g = 1; g < k; g++) {
    const target = (prefix[n] * g) / k;
    const [low, high] = [previous + 1, n - (k - g)];
    let cut = bisectLeft(prefix, target, low, high + 1);
    if (cut > high) cut = high;
    else if (cut > low && target - prefix[cut - 1] <= prefix[cut] - target) cut -= 1;
    bounds.push(cut);
    previous = cut;
  }
  bounds.push(n);
  const balanced = bounds.slice(1).map((end, g): [number, number] => [bounds[g], end]);
  if (balanced.every(([i, j]) => prefix[j] - prefix[i] <= limit)) return balanced;
  return fewest;
}

/**
 * Split one oversized leaf into pieces of at most `limit` tokens.
 *
 * Sentence boundaries are tried first, then clause boundaries, then words. Pieces joined with a
 * single space give back the original text (which the loader has already single-spaced). Only a
 * whitespace-free run longer than the limit is cut mid-string.
 */
export function splitText(text: string, limit: number, count: (text: string) => number): string[] {
  text = strip(text);
  if (!text) return [];
  const chars = Array.from(text); // index by code point, not UTF-16 unit
  if (chars.length <= 1 || count(text) <= limit) return [text];
  for (const pattern of SPLITTERS) {
    const parts = text.split(pattern).filter(Boolean);
    if (parts.length < 2) continue;
    const pieces = parts.flatMap((part) => splitText(part, limit, count));
    const out: string[] = [];
    // +1 per piece leaves room for the joining space, which can cost a token.
    for (const [i, j] of packBalanced(pieces.map((piece) => count(piece) + 1), limit + 1)) {
      const joined = pieces.slice(i, j).join(' ');
      if (j - i > 1 && count(joined) > limit) out.push(...pieces.slice(i, j));
      else out.push(joined);
    }
    return out;
  }
  const half = Math.floor(chars.length / 2);
  return [
    ...splitText(chars.slice(0, half).join(''), limit, count),
    ...splitText(chars.slice(half).join(''), limit, count),
  ];
}
