import { type MotionValue, motion, useTransform } from 'motion/react';

import { compileGraph, validateGraph } from '../../compiler/diagram-compile.ts';
import {
  type RoutedEdge,
  computePaths,
  graphContentViewBox,
  groupBox,
  groupDividerLines,
  nodeBox,
  nodeFrameRadius,
  nodeFrameStrokeWidth,
  resolveGraphAnnotations,
  resolveGraphLayout,
} from '../../layouts/graph/graph-layout.ts';
import { centeredBaselineOffset } from '../../layouts/text-metrics.ts';
import { FONT_FAMILY, TEXT_SHAPING } from '../../layouts/text/font.ts';
import type {
  DiagramGraphLayout,
  DiagramLabelLine,
  DiagramNode,
  Box as SvgBox,
} from '../../model/diagram-ir.ts';
import {
  DiagramFrame,
  type DiagramMode,
  useDiagramTheme,
} from '../../react/chrome/index.ts';
import type { DiagramProps } from '../../react/diagram-types.ts';
import { DiagramDefs } from '../shared/defs.tsx';
import {
  DiagramNodeIcon,
  EdgeOverlay,
  EdgeStroke,
  GroupRect,
  type SegmentKind,
  buildSegments,
  labelLineFill,
  nodeFrameFill,
  nodeFrameStroke,
  nodeTextFill,
  nodeTexture,
  textureFill,
} from '../shared/graph-parts.tsx';
import { rejectNodeContent } from '../shared/node-content.ts';
import {
  ANNOTATION_REVEAL_START,
  AnnotationText,
  NodeCaption,
  NodePorts,
  NodeStackFrames,
  SpecialNode,
  isSpecialNode,
} from '../shared/node-parts.tsx';
import { DiagramPaperRect } from '../shared/paper.tsx';
import type { DiagramEffects, GraphRendererProps } from '../types.ts';
import { GraphFlowEffects } from '../webgpu/graph-flow-effects.tsx';
import { svgViewportProps } from './viewport.ts';

function NodeRect({
  node,
  box,
  progress,
  start,
  end,
}: {
  node: DiagramNode;
  box: SvgBox;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent, ids } = useDiagramTheme();
  const opacity = useTransform(progress, [start, end], [0, 1], {
    clamp: true,
  });
  const translateY = useTransform(progress, [start, end], [-10, 0], {
    clamp: true,
  });
  const frame = node.frame ?? 'solid';
  const rx = nodeFrameRadius(node);
  const strokeWidth = nodeFrameStrokeWidth(node);
  const stroke = nodeFrameStroke(node, frame, themeAccent);
  const boxFill = nodeFrameFill(node, frame);
  const texture = nodeTexture(node, frame);
  const texturePattern = textureFill(texture, ids);
  const fill = nodeTextFill(node, frame, themeAccent);
  const lines = Array.isArray(node.label) ? node.label : [node.label];
  const descriptionLines =
    node.description === undefined
      ? []
      : Array.isArray(node.description)
        ? node.description
        : [node.description];
  const itemLines = node.items ?? [];
  const fontSize = node.fontSize ?? 12;
  const lineHeight = Math.max(12, fontSize + 2);
  const centerY = box.y + box.h / 2;
  const firstLineY =
    centerY -
    ((lines.length - 1) * lineHeight) / 2 +
    centeredBaselineOffset(fontSize, 'mono');
  const cx = box.x + box.w / 2;
  const textAlign = node.textAlign ?? 'center';
  const hasBodyLayout =
    textAlign === 'start' || Boolean(node.icon) || descriptionLines.length > 0;
  if (node.hidden) return null;
  if (isSpecialNode(node)) {
    return (
      <SpecialNode
        node={node}
        box={box}
        progress={progress}
        start={start}
        end={end}
      />
    );
  }
  return (
    <motion.g style={{ opacity, y: translateY }}>
      {frame !== 'none' && (
        <>
          <NodeStackFrames
            node={node}
            box={box}
            rx={rx}
            fill={boxFill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <rect
            data-diagram-node={node.id}
            data-diagram-node-tone={node.tone}
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            rx={rx}
            fill={boxFill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          {texturePattern && (
            <rect
              data-diagram-node-texture={`${node.id}:${texture}`}
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              rx={rx}
              fill={texturePattern}
              pointerEvents="none"
            />
          )}
        </>
      )}
      {hasBodyLayout ? (
        <NodeBodyLayout
          node={node}
          box={box}
          titleLines={lines}
          descriptionLines={descriptionLines}
          itemLines={itemLines}
          fill={fill}
          accent={themeAccent}
        />
      ) : (
        <text
          x={cx}
          y={firstLineY}
          textAnchor="middle"
          fontFamily={FONT_FAMILY.mono}
          fontSize={fontSize}
          fontWeight={node.fontWeight ?? 500}
          fill={fill}
          letterSpacing={0.6}
        >
          {lines.map((line, i) => {
            const lineText = typeof line === 'string' ? line : line.text;
            const lineFill = labelLineFill(line, fill, themeAccent);
            return (
              <tspan
                key={i}
                x={cx}
                dy={i === 0 ? 0 : lineHeight}
                fill={lineFill}
                fontWeight={
                  typeof line === 'string'
                    ? (node.fontWeight ?? 500)
                    : (line.fontWeight ?? node.fontWeight ?? 500)
                }
              >
                {lineText}
              </tspan>
            );
          })}
        </text>
      )}
      <NodePorts node={node} box={box} />
      <NodeCaption node={node} box={box} />
    </motion.g>
  );
}

function NodeBodyLayout({
  node,
  box,
  titleLines,
  descriptionLines,
  itemLines,
  fill,
  accent,
}: {
  node: DiagramNode;
  box: SvgBox;
  titleLines: DiagramLabelLine[];
  descriptionLines: string[];
  itemLines: string[];
  fill: string;
  accent: string;
}) {
  const hasText = titleLines.some((line) =>
    typeof line === 'string' ? line.length > 0 : line.text.length > 0,
  );
  const iconSize = node.iconSize ?? (node.icon === 'ellipsis' ? 34 : 42);
  const cardPadX = 28;
  const headerGap = 22;
  const hasBody = descriptionLines.length > 0 || itemLines.length > 0;
  const hasHeaderIcon = Boolean(node.icon && hasText && hasBody);
  const iconX =
    hasText || hasBody ? box.x + cardPadX : box.x + box.w / 2 - iconSize / 2;
  const iconY =
    hasText || hasBody ? box.y + 28 : box.y + box.h / 2 - iconSize / 2;
  const titleX = node.icon ? iconX + iconSize + headerGap : box.x + cardPadX;
  const bodyX = hasHeaderIcon ? box.x + cardPadX : titleX;
  const titleSize = node.fontSize ?? 15;
  const titleLineHeight = titleSize + 4;
  const titleY = hasBody
    ? box.y + 44
    : box.y +
      box.h / 2 -
      ((titleLines.length - 1) * titleLineHeight) / 2 +
      titleSize * 0.35;
  const bodySize = node.bodyFontSize ?? Math.max(11, titleSize - 2);
  const bodyY = titleY + titleLines.length * titleLineHeight + 8;
  const bodyLineGap = node.bodyLineGap ?? 3;
  const bodyLineHeight = bodySize + bodyLineGap;
  const itemY =
    bodyY +
    (descriptionLines.length > 0
      ? descriptionLines.length * bodyLineHeight + 6
      : 0);

  return (
    <>
      {node.icon && (
        <DiagramNodeIcon
          icon={node.icon}
          x={iconX}
          y={iconY}
          size={iconSize}
          color={node.textColor === 'accent' ? accent : fill}
        />
      )}
      {hasText && (
        <text
          x={titleX}
          y={titleY}
          textAnchor="start"
          fontFamily={FONT_FAMILY.sans}
          fontSize={titleSize}
          fontWeight={node.fontWeight ?? 700}
          fill={fill}
        >
          {titleLines.map((line, i) => {
            const lineText = typeof line === 'string' ? line : line.text;
            const lineFill = labelLineFill(line, fill, accent);
            return (
              <tspan
                key={i}
                x={titleX}
                dy={i === 0 ? 0 : titleLineHeight}
                fill={lineFill}
                fontWeight={
                  typeof line === 'string'
                    ? (node.fontWeight ?? 700)
                    : (line.fontWeight ?? node.fontWeight ?? 700)
                }
              >
                {lineText}
              </tspan>
            );
          })}
        </text>
      )}
      {descriptionLines.length > 0 && (
        <text
          data-diagram-node-description={node.id}
          data-diagram-node-body-font-size={node.bodyFontSize}
          data-diagram-node-body-line-gap={node.bodyLineGap}
          x={bodyX}
          y={bodyY}
          textAnchor="start"
          fontFamily={FONT_FAMILY.sans}
          fontSize={bodySize}
          fontWeight={400}
          fill={fill}
        >
          {descriptionLines.map((line, i) => (
            <tspan key={i} x={bodyX} dy={i === 0 ? 0 : bodyLineHeight}>
              {line}
            </tspan>
          ))}
        </text>
      )}
      {itemLines.length > 0 && (
        <g>
          {itemLines.map((line, i) => {
            const y = itemY + i * bodyLineHeight;
            return (
              <g
                key={i}
                data-diagram-node-item={`${node.id}:${i}`}
                data-diagram-node-body-font-size={node.bodyFontSize}
                data-diagram-node-body-line-gap={node.bodyLineGap}
                transform={`translate(0 ${y})`}
              >
                <circle cx={bodyX + 3} cy={-3} r={2.2} fill={fill} />
                <text
                  x={bodyX + 12}
                  y={0}
                  textAnchor="start"
                  fontFamily={FONT_FAMILY.sans}
                  fontSize={bodySize}
                  fontWeight={400}
                  fill={fill}
                >
                  {line}
                </text>
              </g>
            );
          })}
        </g>
      )}
    </>
  );
}

export type SvgGraphDiagramProps = DiagramProps & {
  graph?: DiagramGraphLayout;
  /** Moving signals over the graph edges, rendered with WebGPU. */
  effects?: DiagramEffects;
};

export function SvgGraphDiagram({
  title,
  children,
  graph,
  viewport,
  paper,
  effects,
  ...chrome
}: SvgGraphDiagramProps) {
  const ir = compileGraph(children, graph);
  rejectNodeContent(ir, 'SvgGraphDiagram');
  const lines = [title].flat();
  return (
    <DiagramFrame title={lines} fit={viewport?.fit} {...chrome}>
      {(progress, mode) => (
        <GraphSVG
          ir={ir}
          title={lines}
          progress={progress}
          viewport={viewport}
          paper={paper}
          effects={effects}
          mode={mode}
        />
      )}
    </DiagramFrame>
  );
}

function GraphSVG({
  ir,
  title,
  progress,
  viewport,
  paper,
  effects,
  mode,
}: GraphRendererProps & {
  effects?: DiagramEffects | undefined;
  mode: DiagramMode;
}) {
  const { stylePreset } = useDiagramTheme();
  validateGraph(ir);
  const graph = resolveGraphLayout(ir);
  const layout = graph.layout;

  const nodeBoxes = new Map<string, SvgBox>();
  for (const n of graph.nodes) nodeBoxes.set(n.id, nodeBox(n, layout));

  const groupBoxes = new Map<string, SvgBox>();
  for (const g of graph.groups ?? [])
    groupBoxes.set(g.id, groupBox(g, graph.nodes, layout, graph.groups));
  const annotations = resolveGraphAnnotations(graph);

  const segments = buildSegments(graph.nodes.length, graph.edges.length);
  const seg = (kind: SegmentKind, index = 0) => {
    const segment = segments.find(
      (candidate) => candidate.kind === kind && candidate.index === index,
    );
    if (!segment) throw new Error(`segment ${kind}[${index}] missing`);
    return segment;
  };

  const groupsSeg = seg('groups');
  const routedEdges: RoutedEdge[] = computePaths(graph);
  const indexedEdges = routedEdges
    .map((routedEdge, index) => ({
      ...routedEdge,
      index,
      segment: seg('edge', index),
      layer: routedEdge.edge.layer ?? 'foreground',
    }))
    .filter(({ d }) => Boolean(d));
  const viewBox = graphContentViewBox(graph, routedEdges);
  const viewportProps = svgViewportProps(viewBox, viewport);

  return (
    <svg
      data-diagram-style-preset={stylePreset}
      {...viewportProps}
      style={{ ...viewportProps.style, ...TEXT_SHAPING }}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={title.join(' ')}
    >
      <title>{title.join(' ')}</title>
      <DiagramDefs />
      <DiagramPaperRect
        kind="graph"
        paper={paper}
        x={viewBox.x}
        y={viewBox.y}
        width={viewBox.w}
        height={viewBox.h}
      />

      {(graph.groups ?? []).map((g) => {
        const box = groupBoxes.get(g.id);
        if (!box) return null;
        return (
          <GroupRect
            key={`group-${g.id}`}
            group={g}
            box={box}
            dividers={groupDividerLines(g, graph.nodes, layout, graph.groups)}
            progress={progress}
            start={groupsSeg.start}
            end={groupsSeg.end}
          />
        );
      })}

      {indexedEdges
        .filter(({ layer }) => layer === 'background')
        .map(({ d, edge, index, segment }) => (
          <EdgeStroke
            key={`edge-background-${index}`}
            d={d}
            edge={edge}
            progress={progress}
            start={segment.start}
            end={segment.end}
          />
        ))}

      {graph.nodes.map((node, i) => {
        const box = nodeBoxes.get(node.id);
        if (!box) return null;
        const segNode = seg('node', i);
        return (
          <NodeRect
            key={`node-${node.id}`}
            node={node}
            box={box}
            progress={progress}
            start={segNode.start}
            end={segNode.end}
          />
        );
      })}

      {indexedEdges
        .filter(({ layer }) => layer === 'foreground')
        .map(({ d, edge, index, segment }) => (
          <EdgeStroke
            key={`edge-foreground-${index}`}
            d={d}
            edge={edge}
            progress={progress}
            start={segment.start}
            end={segment.end}
          />
        ))}

      {effects && (
        <GraphFlowEffects
          edges={indexedEdges}
          viewBox={viewBox}
          progress={progress}
          mode={mode}
          playhead={typeof effects === 'object' ? effects.flow : undefined}
        />
      )}

      {indexedEdges.map(
        ({ edge, labelPlacement, badgePlacement, index, segment }) => (
          <EdgeOverlay
            key={`edge-overlay-${index}`}
            edge={edge}
            labelPlacement={labelPlacement}
            badgePlacement={badgePlacement}
            progress={progress}
            start={segment.start}
            end={segment.end}
          />
        ),
      )}

      {annotations.map((annotation, i) => (
        <AnnotationText
          key={`annot-${i}`}
          annotation={annotation}
          progress={progress}
          start={ANNOTATION_REVEAL_START}
          end={1}
          index={i}
        />
      ))}
    </svg>
  );
}
