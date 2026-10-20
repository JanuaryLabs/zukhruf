import { useEffect, useMemo, useRef } from 'react';

import { compileGraph } from '../../compiler/diagram-compile.ts';
import type {
  GraphLayout,
  TextAnchor,
  TextRun,
} from '../../layouts/graph/graph-layout-result.ts';
import { layoutGraph } from '../../layouts/graph/layout.ts';
import {
  FONT_FAMILY,
  type Font,
  TEXT_SHAPING,
} from '../../layouts/text/font.ts';
import type {
  Box,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  DiagramPaper,
  DiagramTexture,
} from '../../model/diagram-ir.ts';
import {
  DIAGRAM_BG,
  DIAGRAM_DIM,
  DIAGRAM_NEUTRAL,
  DIAGRAM_TEXT,
  DiagramFrame,
  resolveDiagramToneFill,
  resolveDiagramToneStroke,
  useDiagramTheme,
} from '../../react/chrome/index.ts';
import type { DiagramProps } from '../../react/diagram-types.ts';
import {
  EDGE_STROKE_WIDTH,
  nodeFrameFill,
  nodeFrameStroke,
} from '../shared/graph-parts.tsx';
import { rejectNodeContent } from '../shared/node-content.ts';
import type { GraphRendererProps } from '../types.ts';
import { canvasViewportProps } from './canvas-viewport.ts';

function resolveCssColor(
  element: HTMLElement,
  value: string,
  fallback = '#111827',
) {
  const varMatch = value.match(/^var\((--[^,\s)]+)(?:,\s*(.*))?\)$/);
  const name = varMatch?.[1];
  if (name === undefined) return value;
  const resolved = window
    .getComputedStyle(element)
    .getPropertyValue(name)
    .trim();
  return resolved || varMatch?.[2]?.trim() || fallback;
}

function edgeDash(edge: DiagramEdge) {
  if (edge.lineStyle === 'dashed') return [6, 6];
  if (edge.lineStyle === 'dotted') return [1, 6];
  return [];
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  box: Box,
  radius: number,
) {
  const rx = Math.min(radius, box.w / 2, box.h / 2);
  ctx.beginPath();
  ctx.moveTo(box.x + rx, box.y);
  ctx.lineTo(box.x + box.w - rx, box.y);
  ctx.quadraticCurveTo(box.x + box.w, box.y, box.x + box.w, box.y + rx);
  ctx.lineTo(box.x + box.w, box.y + box.h - rx);
  ctx.quadraticCurveTo(
    box.x + box.w,
    box.y + box.h,
    box.x + box.w - rx,
    box.y + box.h,
  );
  ctx.lineTo(box.x + rx, box.y + box.h);
  ctx.quadraticCurveTo(box.x, box.y + box.h, box.x, box.y + box.h - rx);
  ctx.lineTo(box.x, box.y + rx);
  ctx.quadraticCurveTo(box.x, box.y, box.x + rx, box.y);
  ctx.closePath();
}

function applyTexture(
  ctx: CanvasRenderingContext2D,
  box: Box,
  texture: DiagramTexture | undefined,
) {
  if (!texture || texture === 'none') return;
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(17,24,39,0.12)';
  ctx.lineWidth = 0.8;
  if (texture === 'dots') {
    ctx.fillStyle = 'rgba(17,24,39,0.16)';
    for (let x = box.x + 3; x < box.x + box.w; x += 8) {
      for (let y = box.y + 3; y < box.y + box.h; y += 8) {
        ctx.beginPath();
        ctx.arc(x, y, 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    for (let x = box.x - box.h; x < box.x + box.w; x += 8) {
      ctx.beginPath();
      ctx.moveTo(x, box.y + box.h);
      ctx.lineTo(x + box.h, box.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

const GROUP_RADIUS = 18;

const CANVAS_ALIGN: Record<TextAnchor, CanvasTextAlign> = {
  start: 'left',
  middle: 'center',
  end: 'right',
};

function canvasFont(font: Font) {
  return `${font.weight} ${font.size}px ${FONT_FAMILY[font.face]}`;
}

/** Every font the canvas draws text in; canvas paints in a fallback font until each one has loaded. */
function canvasFonts(layout: GraphLayout): string[] {
  const runs = [
    ...layout.groups.flatMap(({ label }) => label),
    ...layout.edges.flatMap(({ label }) => label?.text ?? []),
    ...layout.nodes.flatMap(({ text }) => text),
  ];
  return [...new Set(runs.map((run) => canvasFont(run.font)))];
}

function drawTextRuns(ctx: CanvasRenderingContext2D, runs: TextRun[]) {
  ctx.textBaseline = 'alphabetic';
  for (const run of runs) {
    ctx.font = canvasFont(run.font);
    ctx.textAlign = CANVAS_ALIGN[run.anchor];
    ctx.fillText(run.text, run.x, run.y);
  }
}

function drawEdgeArrow(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 9;
  ctx.save();
  ctx.translate(to.x, to.y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-size, -size / 2);
  ctx.lineTo(0, 0);
  ctx.lineTo(-size, size / 2);
  ctx.stroke();
  ctx.restore();
}

type CanvasPalette = {
  accent: string;
  text: string;
  dim: string;
  neutral: string;
};

function groupStrokeColor(
  canvas: HTMLCanvasElement,
  group: DiagramGroup,
  palette: CanvasPalette,
) {
  if (group.frame === 'dashed') return palette.dim;
  if (group.accent) return palette.accent;
  if (group.tone) {
    return resolveCssColor(canvas, resolveDiagramToneStroke(group.tone));
  }
  return palette.neutral;
}

function edgeColor(edge: DiagramEdge, palette: CanvasPalette) {
  if (edge.accent) return palette.accent;
  if (edge.dim) return palette.dim;
  return palette.neutral;
}

function nodeTextColor(node: DiagramNode, palette: CanvasPalette) {
  if (node.textColor === 'accent') return palette.accent;
  if (node.textColor === 'dim') return palette.dim;
  return palette.text;
}

function drawGraphCanvas(
  canvas: HTMLCanvasElement,
  layout: GraphLayout,
  options: {
    accent: string;
    paper?: DiagramPaper | undefined;
  },
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { viewBox } = layout;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(viewBox.w * dpr);
  canvas.height = Math.round(viewBox.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fontKerning = TEXT_SHAPING.fontKerning;
  ctx.clearRect(0, 0, viewBox.w, viewBox.h);
  ctx.translate(-viewBox.x, -viewBox.y);

  const accent = resolveCssColor(canvas, options.accent, '#111827');
  const bg = resolveCssColor(canvas, DIAGRAM_BG, '#ffffff');
  const text = resolveCssColor(canvas, DIAGRAM_TEXT, '#111827');
  const dim = resolveCssColor(canvas, DIAGRAM_DIM, 'rgba(17,24,39,0.58)');
  const neutral = resolveCssColor(
    canvas,
    DIAGRAM_NEUTRAL,
    'rgba(17,24,39,0.82)',
  );
  const palette: CanvasPalette = { accent, text, dim, neutral };

  if (options.paper) {
    ctx.fillStyle = bg;
    ctx.fillRect(viewBox.x, viewBox.y, viewBox.w, viewBox.h);
  }

  for (const { group, rect, label } of layout.groups) {
    const stroke = groupStrokeColor(canvas, group, palette);
    const fill = group.tone
      ? resolveCssColor(canvas, resolveDiagramToneFill(group.tone))
      : 'transparent';
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash(group.frame === 'dashed' ? [7, 7] : []);
    ctx.strokeStyle = group.frame === 'none' ? 'transparent' : stroke;
    ctx.fillStyle = fill;
    drawRoundedRect(ctx, rect, GROUP_RADIUS);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    applyTexture(ctx, rect, group.texture);
    ctx.fillStyle = text;
    drawTextRuns(ctx, label);
  }

  for (const { edge, points, label } of layout.edges) {
    const [first, second] = points;
    const from = points.at(-2);
    const to = points.at(-1);
    if (!first || !second || !from || !to) continue;
    const color = edgeColor(edge, palette);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = EDGE_STROKE_WIDTH[edge.weight ?? 'regular'];
    ctx.setLineDash(edgeDash(edge));
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of points.slice(1)) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.restore();
    if ((edge.direction ?? 'forward') !== 'none') {
      drawEdgeArrow(ctx, from, to, color);
    }
    if (edge.direction === 'both') {
      drawEdgeArrow(ctx, second, first, color);
    }
    if (label) {
      ctx.save();
      ctx.fillStyle = text;
      drawTextRuns(ctx, label.text);
      ctx.restore();
    }
  }

  for (const { node, box, radius, text: runs } of layout.nodes) {
    if (node.hidden) continue;
    const frame = node.frame ?? 'solid';
    ctx.save();
    if (frame !== 'none') {
      ctx.lineWidth = 1.5;
      ctx.fillStyle = resolveCssColor(
        canvas,
        nodeFrameFill(node, frame),
        '#ffffff',
      );
      ctx.strokeStyle = resolveCssColor(
        canvas,
        nodeFrameStroke(node, frame, accent),
        '#111827',
      );
      drawRoundedRect(ctx, box, radius);
      ctx.fill();
      ctx.stroke();
      applyTexture(ctx, box, node.texture);
    }
    ctx.fillStyle = nodeTextColor(node, palette);
    drawTextRuns(ctx, runs);
    ctx.restore();
  }
}

export type CanvasGraphDiagramProps = DiagramProps;

export function CanvasGraphDiagram({
  title,
  children,
  viewport,
  paper,
  ...chrome
}: CanvasGraphDiagramProps) {
  const ir = compileGraph(children);
  rejectNodeContent(ir, 'CanvasGraphDiagram');
  const lines = [title].flat();
  return (
    <DiagramFrame title={lines} fit={viewport?.fit} {...chrome}>
      {(progress) => (
        <GraphCanvas
          ir={ir}
          title={lines}
          progress={progress}
          viewport={viewport}
          paper={paper}
        />
      )}
    </DiagramFrame>
  );
}

function GraphCanvas({
  ir,
  title,
  progress,
  viewport,
  paper,
}: GraphRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { accent } = useDiagramTheme();
  const layout = useMemo(() => layoutGraph(ir), [ir]);
  const viewportProps = canvasViewportProps(layout.viewBox, viewport);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawGraphCanvas(canvas, layout, { accent, paper });
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void Promise.all(
      canvasFonts(layout).map((font) => document.fonts.load(font)),
    ).then(() => {
      if (stopped) return;
      draw();
      unsubscribe = progress.on('change', draw);
    });
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }, [accent, layout, paper, progress]);

  return (
    <canvas
      ref={canvasRef}
      data-diagram-canvas="graph"
      data-diagram-canvas-viewbox={`${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.w} ${layout.viewBox.h}`}
      width={Math.round(layout.viewBox.w)}
      height={Math.round(layout.viewBox.h)}
      aria-label={title.join(' ')}
      role="img"
      {...viewportProps}
    />
  );
}
