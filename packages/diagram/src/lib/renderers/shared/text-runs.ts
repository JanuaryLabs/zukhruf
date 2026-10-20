import type {
  NodeLayout,
  TextRun,
} from '../../layouts/graph/graph-layout-result.ts';
import { DIAGRAM_DIM } from '../../react/chrome/index.ts';

export function runFill(run: TextRun, fill: string, themeAccent: string) {
  if (run.color === 'accent') return themeAccent;
  if (run.color === 'dim') return DIAGRAM_DIM;
  return fill;
}

/**
 * A node's runs in the order the layout writes them: title lines, then
 * description lines, then one run per bulleted item.
 */
export function nodeTextParts({ node, text, bullets }: NodeLayout) {
  const descriptionCount = [node.description ?? []].flat().length;
  const itemStart = text.length - bullets.length;
  const descriptionStart = itemStart - descriptionCount;
  return {
    title: text.slice(0, descriptionStart),
    description: text.slice(descriptionStart, itemStart),
    items: bullets.flatMap((bullet, i) => {
      const run = text[itemStart + i];
      return run ? [{ run, bullet }] : [];
    }),
  };
}
