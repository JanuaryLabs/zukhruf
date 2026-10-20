import type { TextRun } from '../../layouts/graph/graph-layout-result.ts';
import { runFill } from './text-runs.ts';

export function RunSpans({
  runs,
  fill,
  accent,
}: {
  runs: TextRun[];
  /** Set it to give each line its own fill and weight. */
  fill?: string;
  accent?: string;
}) {
  return runs.map((run, i) => (
    <tspan
      key={i}
      x={run.x}
      y={run.y}
      {...(fill === undefined
        ? {}
        : {
            fill: runFill(run, fill, accent ?? fill),
            fontWeight: run.font.weight,
          })}
    >
      {run.text}
    </tspan>
  ));
}
