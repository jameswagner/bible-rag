/**
 * Reference styles, named in the corpus config as `reference_style = "<name>"`:
 *
 * - a TypeScript module exporting `buildReference(span: RefSpan): string`, registered in STYLES below, or
 * - `<name>.toml` in this folder, a template rendered by `renderTemplate` (see `outline.toml`).
 *
 * `default` and `bible` ship as modules. To add a template style, drop a `.toml` file next to this one;
 * to add a code style, add a module and one line to STYLES.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { InputError } from '../errors.js';
import { show } from '../util.js';
import { renderTemplate, type Builder, type Template } from './base.js';
import * as bible from './bible.js';
import * as defaultStyle from './default.js';

export type { Builder, LevelLabel, RefSpan, Template } from './base.js';
export { renderTemplate } from './base.js';

export const STYLE_DIR = dirname(fileURLToPath(import.meta.url));

const STYLES: { [name: string]: Builder } = {
  default: defaultStyle.buildReference,
  bible: bible.buildReference,
};

export function availableStyles(directory = STYLE_DIR): string[] {
  const templates = readdirSync(directory).filter((file) => extname(file) === '.toml');
  return [...new Set([...Object.keys(STYLES), ...templates.map((file) => basename(file, '.toml'))])].sort();
}

export function getBuilder(style: string, directory = STYLE_DIR): Builder {
  if (Object.hasOwn(STYLES, style)) return STYLES[style];
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(style)) {
    const templatePath = join(directory, `${style}.toml`);
    if (existsSync(templatePath)) {
      const template = parseToml(readFileSync(templatePath, 'utf-8')) as Template;
      return (span) => renderTemplate(span, template);
    }
  }
  throw new InputError(
    `unknown reference style ${show(style)}; available in ${directory}: ${show(availableStyles(directory))}`,
  );
}
