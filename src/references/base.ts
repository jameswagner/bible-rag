/** What a reference builder receives, and the template renderer used by `.toml` styles. */
import type { Path, PathValue } from '../loader.js';
import { format, strip } from '../util.js';

export type LevelLabel = {
  name: string;
  label: string | null; // optional label template from the corpus config, e.g. "Part {value}"
};

/**
 * A contiguous range of leaves to be named.
 *
 * `start` and `end` are the full paths of the first and last leaf (one value per level, null
 * where a level is absent). `depth` says how many levels are needed to name the range exactly:
 * a range that is precisely one chapter has depth 2 in a book/chapter/verse corpus, so styles
 * print "Genesis 1" rather than "Genesis 1:1-31".
 */
export type RefSpan = {
  levels: LevelLabel[];
  start: Path;
  end: Path;
  depth: number;
  title: string | null;
};

export type Builder = (span: RefSpan) => string;

/** A `.toml` style. Keys keep their TOML spelling. */
export type Template = {
  use_title?: boolean;
  separators?: string[] | string;
  title_separator?: string;
  range_separator?: string;
  unnumbered?: string;
  labels?: { [level: string]: string };
};

export function displayName(levelName: string): string {
  const text = strip(levelName.replaceAll('_', ' '));
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

export function formatLabel(template: string, levelName: string, value: PathValue): string {
  if (template === 'auto') {
    // "Section 4" for numbers, the bare value for names
    return typeof value === 'number' ? `${displayName(levelName)} ${value}` : String(value);
  }
  return format(template, { name: levelName, Name: displayName(levelName), value });
}

/**
 * Render `shared prefix + start remainder + range separator + end remainder`.
 *
 * Template keys (all optional):
 *   use_title        prefix the corpus title (default true)
 *   separators       list; item i goes between level i and level i+1, the last one repeats
 *   title_separator  between the title and the first label (default: separators[0])
 *   range_separator  between the two ends of a range (default " to ")
 *   unnumbered       placeholder for an end that has no label at all
 *   labels           table of level name -> label template; "*" is the fallback; "auto" or a
 *                    string using {value}, {name}, {Name}. A label in the corpus config wins.
 */
export function renderTemplate(span: RefSpan, template: Template): string {
  const labels = template.labels ?? {};
  let separators = template.separators || [' > '];
  if (typeof separators === 'string') separators = [separators];
  if (!separators.length) separators = [' > '];
  const rangeSeparator = template.range_separator ?? ' to ';
  const titleSeparator = template.title_separator ?? separators[0];
  const unnumbered = template.unnumbered ?? '(unnumbered)';
  const title = (template.use_title ?? true) && span.title ? span.title : '';

  const separator = (position: number): string =>
    separators[Math.min(Math.max(position - 1, 0), separators.length - 1)];

  const pieces = (path: Path): [number, string][] => {
    const out: [number, string][] = [];
    for (let position = 0; position < span.depth; position++) {
      const value = path[position];
      if (value === null) continue;
      const level = span.levels[position];
      const chosen = level.label || labels[level.name] || labels['*'] || 'auto';
      out.push([position, formatLabel(chosen, level.name, value)]);
    }
    return out;
  };

  const join = (items: [number, string][]): string =>
    items.map(([position, label], n) => (n ? separator(position) : '') + label).join('');

  let common = 0;
  while (common < span.depth && span.start[common] === span.end[common]) common++;
  const [start, end] = [pieces(span.start), pieces(span.end)];
  const head = start.filter(([position]) => position < common);
  let prefix = title;
  if (head.length) prefix += (prefix ? titleSeparator : '') + join(head);
  if (common === span.depth) return prefix || unnumbered;

  const tailStart = start.filter(([position]) => position >= common);
  const tailEnd = end.filter(([position]) => position >= common);
  const first = (tailStart.length ? tailStart : tailEnd.length ? tailEnd : [[common, '']])[0][0] as number;
  const connector = !prefix ? '' : !head.length ? titleSeparator : separator(first);
  return `${prefix}${connector}${join(tailStart) || unnumbered}${rangeSeparator}${join(tailEnd) || unnumbered}`;
}
