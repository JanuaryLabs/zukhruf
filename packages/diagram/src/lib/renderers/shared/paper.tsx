import type { DiagramPaper, DiagramPaperFill } from '../../model/diagram-ir.ts';
import {
  DIAGRAM_BG,
  DIAGRAM_BORDER,
  DIAGRAM_SURFACE_MUTED,
} from '../../react/chrome/theme.ts';

type ResolvedDiagramPaper = {
  fill: DiagramPaperFill;
  stroke: boolean;
  rx: number;
};

function resolveDiagramPaper(
  paper: DiagramPaper | undefined,
): ResolvedDiagramPaper | null {
  if (!paper) return null;
  if (paper === true) {
    return { fill: 'background', stroke: false, rx: 0 };
  }
  if (
    paper.fill !== undefined &&
    paper.fill !== 'background' &&
    paper.fill !== 'surface'
  ) {
    throw new Error(
      `Diagram paper fill must be "background" or "surface", got "${paper.fill}".`,
    );
  }
  const rx = paper.rx ?? 0;
  if (!Number.isFinite(rx) || rx < 0) {
    throw new Error(
      `Diagram paper rx must be a non-negative finite number, got ${rx}.`,
    );
  }
  return {
    fill: paper.fill ?? 'background',
    stroke: paper.stroke ?? false,
    rx,
  };
}

function paperFill(fill: DiagramPaperFill) {
  return fill === 'surface' ? DIAGRAM_SURFACE_MUTED : DIAGRAM_BG;
}

export function DiagramPaperRect({
  kind,
  paper,
  x = 0,
  y = 0,
  width,
  height,
}: {
  kind: 'graph' | 'timeline';
  paper: DiagramPaper | undefined;
  x?: number;
  y?: number;
  width: number;
  height: number;
}) {
  const resolved = resolveDiagramPaper(paper);
  if (!resolved) return null;
  return (
    <rect
      data-diagram-paper={kind}
      data-diagram-paper-fill={resolved.fill}
      x={x}
      y={y}
      width={width}
      height={height}
      rx={resolved.rx}
      fill={paperFill(resolved.fill)}
      stroke={resolved.stroke ? DIAGRAM_BORDER : 'none'}
      strokeWidth={resolved.stroke ? 1 : 0}
    />
  );
}
