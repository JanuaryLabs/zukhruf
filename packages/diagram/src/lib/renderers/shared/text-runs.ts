import type {
  NodeLayout,
  TextRun,
} from '../../layouts/graph/graph-layout-result.ts';
import { DIAGRAM_DIM } from '../../react/chrome/index.ts';

/**
 * The distance from the previous run's baseline, which an SVG tspan carries as
 * `dy`. Rounded so that a float error in the subtraction does not leak into
 * the markup.
 */
export function baselineStep(runs: TextRun[], index: number): number {
  const run = runs[index];
  const previous = runs[index - 1];
  if (!run || !previous) return 0;
  return Number((run.y - previous.y).toFixed(6));
}

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
