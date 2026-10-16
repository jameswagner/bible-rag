/**
 * Standard Bible references: "Genesis 1:29-31", "Genesis 1:29-4:6", "Genesis 1", "Genesis 1-3".
 *
 * The innermost three levels are read as book, chapter, verse. Levels above the book are not printed.
 */
import type { Path } from '../loader.js';
import { arraysEqual } from '../util.js';
import type { RefSpan } from './base.js';

const numbers = (values: Path): string => values.filter((value) => value !== null).join(':');

function point(path: Path, title: string | null): string {
  const book = path[0] !== null ? String(path[0]) : (title ?? '');
  return `${book} ${numbers(path.slice(1))}`.trim();
}

export function buildReference(span: RefSpan): string {
  const offset = Math.max(0, span.levels.length - 3);
  if (span.depth <= offset) {
    // the range is a whole unit above book level
    const [first, last] = [span.start[span.depth - 1], span.end[span.depth - 1]];
    if (first === null) return span.title || '(untitled)';
    return first === last ? String(first) : `${first}-${last}`;
  }
  const start = span.start.slice(offset, span.depth);
  const end = span.end.slice(offset, span.depth);
  const left = point(start, span.title);
  if (arraysEqual(start, end)) return left || '(untitled)';
  if (start[0] !== end[0]) {
    // not expected: references do not cross the top level
    return `${left}-${point(end, span.title)}`;
  }
  let shared = 1;
  while (shared < start.length && start[shared] === end[shared]) shared++;
  const tail = numbers(end.slice(shared));
  return tail ? `${left}-${tail}` : left;
}
