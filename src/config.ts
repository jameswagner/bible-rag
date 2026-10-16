/** Corpus configuration: the shape of the hierarchy and the size limits per level. */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { InputError } from './errors.js';
import { get, isInt, isObject, parseFormat, show, strip } from './util.js';

export const MAX_LEVELS = 5;
export const MAX_CHUNK_TOKENS = 8000; // text-embedding-3-small accepts 8191 tokens; keep room for the heading line
export const MIN_INNERMOST_MAX = 16;
// [min_tokens, max_tokens] by distance from the innermost level, used when a level gives no limits.
const DEFAULT_LIMITS: [number, number][] = [[16, 320], [128, 1200], [512, 4800], [1024, 6000], [2048, 6000]];
export const LABEL_FIELDS = new Set(['name', 'Name', 'value']);

const NAME = /^[a-z][a-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOP_KEYS = new Set([
  'name', 'title', 'text_key', 'reference_style', 'embed_headings', 'leaf_separator',
  'levels', 'normalize', 'search',
]);
const LEVEL_KEYS = new Set(['name', 'key', 'min_tokens', 'max_tokens', 'optional', 'label']);

export type LevelConfig = {
  name: string;
  key: string;
  minTokens: number;
  maxTokens: number;
  optional: boolean;
  label: string | null;
};

export type CorpusConfig = {
  name: string;
  levels: LevelConfig[];
  textKey: string;
  title: string | null;
  referenceStyle: string;
  embedHeadings: boolean;
  leafSeparator: string;
  markers: string[];
  parentMaxTokens: number;
};

export const levelNames = (config: CorpusConfig): string[] => config.levels.map((level) => level.name);

/** A single leaf above this is split, so that it can always be packed with a small neighbour. */
export const atomMaxTokens = (config: CorpusConfig): number =>
  Math.floor(config.levels[config.levels.length - 1].maxTokens / 2);

export function depthOf(config: CorpusConfig, levelName: string): number {
  const index = config.levels.findIndex((level) => level.name === levelName);
  if (index < 0) {
    throw new InputError(`unknown level ${show(levelName)}; this corpus has levels ${show(levelNames(config))}`);
  }
  return index + 1;
}

function fail(message: string): never {
  throw new InputError(`corpus config: ${message}`);
}

function known(table: Record<string, unknown>, allowed: Set<string>, where: string): void {
  const unknown = Object.keys(table).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail(`unknown key(s) ${show(unknown)} in ${where}; allowed: ${show([...allowed].sort())}`);
}

function integer(value: unknown, what: string): number {
  if (!isInt(value)) fail(`${what} must be an integer, got ${show(value)}`);
  return value;
}

function table(raw: Record<string, unknown>, key: string, allowed: Set<string>): Record<string, unknown> {
  const value = get(raw, key, {});
  if (!isObject(value)) fail(`[${key}] must be a table`);
  known(value, allowed, `[${key}]`);
  return value;
}

function checkLabel(template: unknown, where: string): void {
  if (typeof template !== 'string' || !template) fail(`${where}: 'label' must be a non-empty string`);
  let fields: Set<string>;
  try {
    fields = new Set(parseFormat(template).flatMap((part) => ('field' in part ? [part.field] : [])));
  } catch (error) {
    fail(`${where}: bad label template ${show(template)} (${(error as Error).message})`);
  }
  const unknown = [...fields].filter((field) => !LABEL_FIELDS.has(field)).sort();
  if (unknown.length) {
    fail(`${where}: label uses unknown placeholder(s) ${show(unknown)}; allowed: ${show([...LABEL_FIELDS].sort())}`);
  }
}

export function configFromDict(raw: unknown): CorpusConfig {
  if (!isObject(raw)) fail('expected a table of settings');
  known(raw, TOP_KEYS, 'the top level');

  const name = raw.name;
  if (typeof name !== 'string' || !NAME.test(name)) {
    fail("'name' is required: lowercase letters, digits and underscores (it names the Qdrant collection)");
  }
  const textKey = get(raw, 'text_key', 'text');
  if (typeof textKey !== 'string' || !textKey) fail("'text_key' must be a non-empty string");

  const rawLevels = raw.levels;
  if (!Array.isArray(rawLevels) || rawLevels.length < 1 || rawLevels.length > MAX_LEVELS) {
    fail(`'levels' must list 1 to ${MAX_LEVELS} levels, outermost first`);
  }
  const count = rawLevels.length;
  const levels: LevelConfig[] = rawLevels.map((item: unknown, position) => {
    const where = `levels[${position}]`;
    if (!isObject(item)) fail(`${where} must be a table`);
    known(item, LEVEL_KEYS, where);
    const levelName = item.name;
    if (typeof levelName !== 'string' || !strip(levelName)) fail(`${where} needs a 'name'`);
    const key = get(item, 'key', levelName);
    if (typeof key !== 'string' || !key) fail(`${where}: 'key' must be a non-empty string`);
    const [defaultMin, defaultMax] = DEFAULT_LIMITS[count - 1 - position];
    const high = 'max_tokens' in item
      ? integer(item.max_tokens, `${where}.max_tokens`)
      : Math.max(defaultMax, 2 * integer(get(item, 'min_tokens', defaultMin), `${where}.min_tokens`));
    const low = 'min_tokens' in item
      ? integer(item.min_tokens, `${where}.min_tokens`)
      : Math.min(defaultMin, Math.floor(high / 2));
    if (low < 1 || low > Math.floor(high / 2)) {
      fail(
        `${where}: min_tokens must be between 1 and max_tokens // 2 (= ${Math.floor(high / 2)}), ` +
          'so that a tiny unit plus a neighbour always fits under the maximum',
      );
    }
    if (high > MAX_CHUNK_TOKENS) {
      fail(`${where}: max_tokens ${high} is above the embedding limit allowance of ${MAX_CHUNK_TOKENS}`);
    }
    const optional = get(item, 'optional', false);
    if (typeof optional !== 'boolean') fail(`${where}: 'optional' must be true or false`);
    const label = item.label ?? null;
    if (label !== null) checkLabel(label, where);
    return { name: strip(levelName), key, minTokens: low, maxTokens: high, optional, label: label as string | null };
  });

  const names = levels.map((level) => level.name);
  if (new Set(names).size !== names.length) fail('level names must be unique');
  const keys = levels.map((level) => level.key);
  if (new Set(keys).size !== keys.length) fail('each level needs its own record key');
  if (keys.includes(textKey)) fail(`text_key ${show(textKey)} is also used as a level key`);
  if (levels[levels.length - 1].maxTokens < MIN_INNERMOST_MAX) {
    fail(`the innermost level needs max_tokens of at least ${MIN_INNERMOST_MAX}`);
  }
  for (let i = 1; i < levels.length; i++) {
    const [outer, inner] = [levels[i - 1], levels[i]];
    if (outer.maxTokens < inner.maxTokens) {
      fail(
        `max_tokens must not shrink going outward: ${outer.name} (${outer.maxTokens}) ` +
          `< ${inner.name} (${inner.maxTokens})`,
      );
    }
  }

  const title = raw.title ?? null;
  if (title !== null && (typeof title !== 'string' || !strip(title))) fail("'title' must be a non-empty string when given");
  const style = get(raw, 'reference_style', 'default');
  if (typeof style !== 'string' || !IDENTIFIER.test(style)) {
    fail("'reference_style' must be the name of a style in src/references");
  }
  const embedHeadings = get(raw, 'embed_headings', true);
  if (typeof embedHeadings !== 'boolean') fail("'embed_headings' must be true or false");
  const separator = get(raw, 'leaf_separator', '\n');
  if (typeof separator !== 'string' || !separator) fail("'leaf_separator' must be a non-empty string");

  const normalize = table(raw, 'normalize', new Set(['markers']));
  const markers = get(normalize, 'markers', ['¶']);
  if (!Array.isArray(markers) || !markers.every((m) => typeof m === 'string' && strip(m))) {
    fail('normalize.markers must be a list of non-blank strings');
  }

  const search = table(raw, 'search', new Set(['parent_max_tokens']));
  const defaultParent = count > 1 ? levels[levels.length - 2].maxTokens : levels[levels.length - 1].maxTokens;
  const parentMax = integer(get(search, 'parent_max_tokens', defaultParent), 'search.parent_max_tokens');
  if (parentMax < 1) fail('search.parent_max_tokens must be positive');

  return {
    name,
    levels,
    textKey,
    title: title ? strip(title as string) : null,
    referenceStyle: style,
    embedHeadings,
    leafSeparator: separator,
    markers: markers as string[],
    parentMaxTokens: parentMax,
  };
}

export function loadConfig(path: string): CorpusConfig {
  const text = readFileSync(path, 'utf-8');
  let raw: unknown;
  try {
    raw = extname(path).toLowerCase() === '.json' ? JSON.parse(text) : parseToml(text);
  } catch (error) {
    throw new InputError(`corpus config: ${path} cannot be parsed (${(error as Error).message})`);
  }
  return configFromDict(raw);
}
