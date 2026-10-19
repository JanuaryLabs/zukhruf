import { useEffect, useMemo, useRef } from 'react';

import { compileGraph, validateGraph } from '../../compiler/diagram-compile.ts';
import {
  computePaths,
  graphContentViewBox,
  groupBox,
  groupLabelLines,
  nodeBox,
  nodeFrameRadius,
  resolveGraphLayout,
} from '../../layouts/graph/graph-layout.ts';
import type {
  Box,
  DiagramEdge,
  DiagramGraphLayout,
  DiagramLabelLine,
  DiagramPaper,
  DiagramTexture,
  GraphLayoutSpec,
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
import { nodeFrameFill, nodeFrameStroke } from '../shared/graph-parts.tsx';
import { rejectNodeContent } from '../shared/node-content.ts';
import type { GraphRendererProps } from '../types.ts';
import { canvasViewportProps } from './canvas-viewport.ts';

type CanvasGraphModel = {
  graph: GraphLayoutSpec;
  routedEdges: ReturnType<typeof computePaths>;
  viewBox: Box;
};

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

function linesForLabel(label: string | DiagramLabelLine[]) {
  return (Array.isArray(label) ? label : [label]).map((line) =>
    typeof line === 'string' ? line : line.text,
  );
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

function drawTextLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  firstY: number,
  lineHeight: number,
  align: CanvasTextAlign,
) {
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, index) => {
    ctx.fillText(line, x, firstY + index * lineHeight);
  });
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

function drawGraphCanvas(
  canvas: HTMLCanvasElement,
  model: CanvasGraphModel,
  options: {
    accent: string;
    paper?: DiagramPaper | undefined;
  },
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(model.viewBox.w * dpr);
  canvas.height = Math.round(model.viewBox.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, model.viewBox.w, model.viewBox.h);
  ctx.translate(-model.viewBox.x, -model.viewBox.y);

  const accent = resolveCssColor(canvas, options.accent, '#111827');
  const bg = resolveCssColor(canvas, DIAGRAM_BG, '#ffffff');
  const text = resolveCssColor(canvas, DIAGRAM_TEXT, '#111827');
  const dim = resolveCssColor(canvas, DIAGRAM_DIM, 'rgba(17,24,39,0.58)');
  const neutral = resolveCssColor(
    canvas,
    DIAGRAM_NEUTRAL,
    'rgba(17,24,39,0.82)',
  );

  if (options.paper) {
    ctx.fillStyle = bg;
    ctx.fillRect(
      model.viewBox.x,
      model.viewBox.y,
      model.viewBox.w,
      model.viewBox.h,
    );
  }

  for (const group of model.graph.groups ?? []) {
    const box = groupBox(
      group,
      model.graph.nodes,
      model.graph.layout,
      model.graph.groups,
    );
    const stroke =
      group.frame === 'dashed'
        ? dim
        : group.accent
          ? accent
          : group.tone
            ? resolveCssColor(canvas, resolveDiagramToneStroke(group.tone))
            : neutral;
    const fill = group.tone
      ? resolveCssColor(canvas, resolveDiagramToneFill(group.tone))
      : 'transparent';
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash(group.frame === 'dashed' ? [7, 7] : []);
    ctx.strokeStyle = group.frame === 'none' ? 'transparent' : stroke;
    ctx.fillStyle = fill;
    drawRoundedRect(ctx, box, group.rx ?? 18);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    applyTexture(ctx, box, group.texture);
    ctx.fillStyle = text;
    ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif';
    drawTextLines(
      ctx,
      groupLabelLines(group),
      box.x + box.w / 2,
      box.y + 20,
      15,
      'center',
    );
  }

  for (const routed of model.routedEdges) {
    const [first, second] = routed.points;
    const from = routed.points.at(-2);
    const to = routed.points.at(-1);
    if (!first || !second || !from || !to) continue;
    const color = routed.edge.accent ? accent : routed.edge.dim ? dim : neutral;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = routed.edge.strokeWidth ?? 1.5;
    ctx.setLineDash(edgeDash(routed.edge));
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of routed.points.slice(1)) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.restore();
    if ((routed.edge.direction ?? 'forward') !== 'none') {
      drawEdgeArrow(ctx, from, to, color);
    }
    if (routed.edge.direction === 'both') {
      drawEdgeArrow(ctx, second, first, color);
    }
    if (routed.edge.label?.length && routed.labelPlacement) {
      ctx.save();
      ctx.fillStyle = text;
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      drawTextLines(
        ctx,
        routed.edge.label,
        routed.labelPlacement.x,
        routed.labelPlacement.y,
        12,
        routed.labelPlacement.align === 'middle'
          ? 'center'
          : routed.labelPlacement.align,
      );
      ctx.restore();
    }
  }

  for (const node of model.graph.nodes) {
    if (node.hidden) continue;
    const box = nodeBox(node, model.graph.layout);
    const frame = node.frame ?? 'solid';
    const fill = resolveCssColor(canvas, nodeFrameFill(node, frame), '#ffffff');
    const stroke = resolveCssColor(
      canvas,
      nodeFrameStroke(node, frame, accent),
      '#111827',
    );
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    drawRoundedRect(ctx, box, nodeFrameRadius(node));
    ctx.fill();
    ctx.stroke();
    applyTexture(ctx, box, node.texture);
    ctx.fillStyle =
      node.textColor === 'accent'
        ? accent
        : node.textColor === 'dim'
          ? dim
          : text;
    const fontSize = node.fontSize ?? 12;
    const lineHeight = Math.max(12, fontSize + 2);
    const lines = linesForLabel(node.label);
    ctx.font = `${node.fontWeight ?? 600} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    const textAlign = node.textAlign ?? 'center';
    const x = textAlign === 'start' ? box.x + 16 : box.x + box.w / 2;
    const y =
      box.y + box.h / 2 - ((lines.length - 1) * lineHeight) / 2 + fontSize / 2;
    drawTextLines(
      ctx,
      lines,
      x,
      y,
      lineHeight,
      textAlign === 'start' ? 'left' : 'center',
    );
    ctx.restore();
  }
}

export type CanvasGraphDiagramProps = DiagramProps & {
  graph?: DiagramGraphLayout;
};

export function CanvasGraphDiagram({
  title,
  children,
  graph,
  viewport,
  paper,
  ...chrome
}: CanvasGraphDiagramProps) {
  const ir = compileGraph(children, graph);
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
  validateGraph(ir);
  const model = useMemo<CanvasGraphModel>(() => {
    const graph = resolveGraphLayout(ir);
    const routedEdges = computePaths(graph);
    const viewBox = graphContentViewBox(graph, routedEdges);
    return { graph, routedEdges, viewBox };
  }, [ir]);
  const viewportProps = canvasViewportProps(model.viewBox, viewport);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawGraphCanvas(canvas, model, { accent, paper });
    draw();
    return progress.on('change', draw);
  }, [accent, model, paper, progress]);

  return (
    <canvas
      ref={canvasRef}
      data-diagram-canvas="graph"
      data-diagram-canvas-viewbox={`${model.viewBox.x} ${model.viewBox.y} ${model.viewBox.w} ${model.viewBox.h}`}
      width={Math.round(model.viewBox.w)}
      height={Math.round(model.viewBox.h)}
      aria-label={title.join(' ')}
      role="img"
      {...viewportProps}
    />
  );
}
