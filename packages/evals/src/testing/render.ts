import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { toString } from 'mdast-util-to-string';
import { gfmTable } from 'micromark-extension-gfm-table';

import type { Section } from '../index.ts';
import { HtmlRenderer, MarkdownRenderer, Page } from '../report/index.ts';

// A section on a page of its own, drawn by each renderer, and its heading as a
// reader of the Markdown reads it: the text of the second-level heading,
// parsed back, so the escapes of remark are not compared by hand.
export const render = (section: Section) => {
  const page = new Page('offers', [section]);
  const markdown = new MarkdownRenderer().render(page);
  const heading = fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }).children.find((node) => node.type === 'heading' && node.depth === 2);
  return {
    html: new HtmlRenderer().render(page),
    markdown,
    heading: heading === undefined ? undefined : toString(heading),
  };
};
