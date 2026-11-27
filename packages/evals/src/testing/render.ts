import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { toString } from 'mdast-util-to-string';
import { gfmTable } from 'micromark-extension-gfm-table';

import type { Section } from '../index.ts';
import { HtmlRenderer, MarkdownRenderer, Page } from '../report/index.ts';

// A section on a page of its own, drawn by each renderer, and the Markdown as
// its reader reads it, parsed back, so the escapes of remark are not compared
// by hand: the text of the second-level heading, and each block below the
// headings, a table as its rows of cell texts and any other block as its kind.
export const render = (section: Section) => {
  const page = new Page('offers', [section]);
  const markdown = new MarkdownRenderer().render(page);
  const tree = fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const heading = tree.children.find(
    (node) => node.type === 'heading' && node.depth === 2,
  );
  return {
    html: new HtmlRenderer().render(page),
    markdown,
    heading: heading === undefined ? undefined : toString(heading),
    blocks: tree.children.flatMap((node): (string | string[][])[] => {
      if (node.type === 'heading') return [];
      if (node.type === 'table')
        return [
          node.children.map((row) =>
            row.children.map((cell) => toString(cell)),
          ),
        ];
      return [node.type];
    }),
  };
};
