/**
 * Default style, no custom code needed by a corpus.
 *
 *     Policy Manual > Section 4 > Clause 2 to Clause 4
 *     Policy Manual > Section 5 > Clause 1 to Section 6 > Clause 9
 *
 * Numbers are labelled with the level name ("Section 4"); text values stand on their own
 * ("Preamble"). A level can override its label in the corpus config: label = "Part {value}".
 */
import { renderTemplate, type RefSpan, type Template } from './base.js';

const TEMPLATE: Template = {
  use_title: true,
  separators: [' > '],
  range_separator: ' to ',
  labels: { '*': 'auto' },
};

export function buildReference(span: RefSpan): string {
  return renderTemplate(span, TEMPLATE);
}
