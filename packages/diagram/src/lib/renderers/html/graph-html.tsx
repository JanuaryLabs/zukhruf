import { type MotionValue, motion, useTransform } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';

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
  nodeStackCount,
  resolveGraphAnnotations,
  resolveGraphLayout,
} from '../../layouts/graph/graph-layout.ts';
import type {
  Box,
  DiagramGraphLayout,
  DiagramLabelLine,
  DiagramNode,
  DiagramTexture,
  DiagramViewport,
} from '../../model/diagram-ir.ts';
import {
  DIAGRAM_DOT,
  DIAGRAM_HATCH,
  DiagramFrame,
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
} from '../shared/graph-parts.tsx';
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
import { formatZoom, normalizeZoom } from '../shared/viewport-zoom.ts';
import type { GraphRendererProps } from '../types.ts';

const MONO = "ui-monospace, 'Geist Mono', monospace";
const SANS = 'ui-sans-serif, system-ui, sans-serif';

export type HtmlGraphDiagramProps = Omit<DiagramProps, 'viewport'> & {
  graph?: DiagramGraphLayout;
  viewport?: Omit<DiagramViewport, 'fit'>;
};

export function HtmlGraphDiagram({
  title,
  children,
  graph,
  viewport,
  paper,
  ...chrome
}: HtmlGraphDiagramProps) {
  const ir = compileGraph(children, graph);
  const lines = [title].flat();
  const zoom = normalizeZoom(viewport?.zoom);
  return (
    <DiagramFrame title={lines} {...chrome}>
      {(progress) => (
        <GraphHTML
          ir={ir}
          title={lines}
          progress={progress}
          zoom={zoom}
          paper={paper}
        />
      )}
    </DiagramFrame>
  );
}

function GraphHTML({
  ir,
  title,
  progress,
  zoom,
  paper,
}: Omit<GraphRendererProps, 'viewport'> & { zoom: number }) {
  const { stylePreset } = useDiagramTheme();
  validateGraph(ir);
  const graph = resolveGraphLayout(ir);
  const layout = graph.layout;
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
  const nodes = graph.nodes
    .map((node, i) => ({
      node,
      box: nodeBox(node, layout),
      segment: seg('node', i),
    }))
    .filter(({ node }) => !node.hidden);
  const boxNodes = nodes.filter(({ node }) => !isSpecialNode(node));
  const annotations = resolveGraphAnnotations(graph);
  const svgLayer = {
    className: 'pointer-events-none absolute inset-0 overflow-visible',
    width: viewBox.w,
    height: viewBox.h,
    viewBox: `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`,
    'aria-hidden': true,
  } as const;

  return (
    <div
      role="group"
      aria-label={title.join(' ')}
      className="w-full overflow-x-auto"
      data-diagram-style-preset={stylePreset}
      data-diagram-viewport-zoom={formatZoom(zoom)}
    >
      <div
        className="relative mx-auto"
        style={{ width: viewBox.w, height: viewBox.h, zoom }}
        data-diagram-html="graph"
      >
        <svg {...svgLayer}>
          <DiagramDefs />
          <DiagramPaperRect
            kind="graph"
            paper={paper}
            x={viewBox.x}
            y={viewBox.y}
            width={viewBox.w}
            height={viewBox.h}
          />
          {graph.groups?.map((group) => (
            <GroupRect
              key={`group-${group.id}`}
              group={group}
              box={groupBox(group, graph.nodes, layout, graph.groups)}
              dividers={groupDividerLines(
                group,
                graph.nodes,
                layout,
                graph.groups,
              )}
              progress={progress}
              start={groupsSeg.start}
              end={groupsSeg.end}
            />
          ))}
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
          {nodes.map(({ node, box, segment }) =>
            isSpecialNode(node) ? (
              <SpecialNode
                key={`node-${node.id}`}
                node={node}
                box={box}
                progress={progress}
                start={segment.start}
                end={segment.end}
              />
            ) : (
              <NodeStack
                key={`stack-${node.id}`}
                node={node}
                box={box}
                progress={progress}
                start={segment.start}
                end={segment.end}
              />
            ),
          )}
        </svg>
        {boxNodes.map(({ node, box, segment }) => (
          <NodeBox
            key={`node-${node.id}`}
            node={node}
            box={box}
            origin={viewBox}
            progress={progress}
            start={segment.start}
            end={segment.end}
          />
        ))}
        <svg {...svgLayer}>
          {boxNodes.map(({ node, box, segment }) => (
            <NodeReveal
              key={`node-marks-${node.id}`}
              progress={progress}
              start={segment.start}
              end={segment.end}
            >
              <NodePorts node={node} box={box} />
              <NodeCaption node={node} box={box} />
            </NodeReveal>
          ))}
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
      </div>
    </div>
  );
}

function NodeReveal({
  progress,
  start,
  end,
  children,
}: {
  progress: MotionValue<number>;
  start: number;
  end: number;
  children: ReactNode;
}) {
  const opacity = useTransform(progress, [start, end], [0, 1], { clamp: true });
  const translateY = useTransform(progress, [start, end], [-10, 0], {
    clamp: true,
  });
  return <motion.g style={{ opacity, y: translateY }}>{children}</motion.g>;
}

function NodeStack({
  node,
  box,
  progress,
  start,
  end,
}: {
  node: DiagramNode;
  box: Box;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  const frame = node.frame ?? 'solid';
  if (frame === 'none' || nodeStackCount(node) < 2) return null;
  return (
    <NodeReveal progress={progress} start={start} end={end}>
      <NodeStackFrames
        node={node}
        box={box}
        rx={nodeFrameRadius(node)}
        fill={nodeFrameFill(node, frame)}
        stroke={nodeFrameStroke(node, frame, themeAccent)}
        strokeWidth={nodeFrameStrokeWidth(node)}
      />
    </NodeReveal>
  );
}

function textureImage(
  texture: DiagramTexture,
): Pick<CSSProperties, 'backgroundImage' | 'backgroundSize'> {
  if (texture === 'dots') {
    return {
      backgroundImage: `radial-gradient(circle at 2px 2px, ${DIAGRAM_DOT} 0.7px, transparent 0.8px)`,
      backgroundSize: '6px 6px',
    };
  }
  if (texture === 'hatch') {
    return {
      backgroundImage: `repeating-linear-gradient(135deg, ${DIAGRAM_HATCH} 0 0.8px, transparent 0.8px 5.66px)`,
    };
  }
  return {};
}

function NodeBox({
  node,
  box,
  origin,
  progress,
  start,
  end,
}: {
  node: DiagramNode;
  box: Box;
  origin: Box;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  const opacity = useTransform(progress, [start, end], [0, 1], { clamp: true });
  const translateY = useTransform(progress, [start, end], [-10, 0], {
    clamp: true,
  });
  const frame = node.frame ?? 'solid';
  const fill = nodeTextFill(node, frame, themeAccent);
  const lines = Array.isArray(node.label) ? node.label : [node.label];
  const descriptionLines = [node.description ?? []].flat();
  const itemLines = node.items ?? [];
  const startAligned =
    (node.textAlign ?? 'center') === 'start' ||
    Boolean(node.icon) ||
    descriptionLines.length > 0;
  const iconSize = node.iconSize ?? 42;

  return (
    <motion.div
      data-diagram-node={node.id}
      data-diagram-node-tone={node.tone}
      className={
        startAligned
          ? 'absolute flex items-start gap-[22px] px-7 py-6'
          : 'absolute flex flex-col items-center justify-center gap-2 px-3 text-center'
      }
      style={{
        left: box.x - origin.x,
        top: box.y - origin.y,
        width: box.w,
        height: box.h,
        boxSizing: 'border-box',
        borderRadius: nodeFrameRadius(node),
        ...(frame === 'none'
          ? {}
          : {
              backgroundColor: nodeFrameFill(node, frame),
              border: `${nodeFrameStrokeWidth(node)}px solid ${nodeFrameStroke(node, frame, themeAccent)}`,
              ...textureImage(nodeTexture(node, frame)),
            }),
        color: fill,
        opacity,
        y: translateY,
      }}
    >
      {node.icon && (
        <svg
          width={iconSize}
          height={iconSize}
          className="shrink-0"
          aria-hidden
        >
          <DiagramNodeIcon
            icon={node.icon}
            x={0}
            y={0}
            size={iconSize}
            color={node.textColor === 'accent' ? themeAccent : fill}
          />
        </svg>
      )}
      <div
        className={startAligned ? 'flex min-w-0 flex-col gap-2' : 'contents'}
      >
        <NodeLabel
          node={node}
          lines={lines}
          fill={fill}
          themeAccent={themeAccent}
          startAligned={startAligned}
        />
        {descriptionLines.length > 0 && (
          <p
            data-diagram-node-description={node.id}
            className="text-pretty"
            style={{
              fontFamily: SANS,
              fontSize: node.bodyFontSize ?? 13,
              lineHeight: 1.35,
            }}
          >
            {descriptionLines.join(' ')}
          </p>
        )}
        {itemLines.length > 0 && (
          <ul
            className="flex list-disc flex-col gap-1 pl-4"
            style={{ fontFamily: SANS, fontSize: node.bodyFontSize ?? 13 }}
          >
            {itemLines.map((item, i) => (
              <li key={i} data-diagram-node-item={`${node.id}:${i}`}>
                {item}
              </li>
            ))}
          </ul>
        )}
        {node.content !== undefined && (
          <div data-diagram-node-content={node.id}>{node.content}</div>
        )}
      </div>
    </motion.div>
  );
}

function NodeLabel({
  node,
  lines,
  fill,
  themeAccent,
  startAligned,
}: {
  node: DiagramNode;
  lines: DiagramLabelLine[];
  fill: string;
  themeAccent: string;
  startAligned: boolean;
}) {
  const fontSize = node.fontSize ?? (startAligned ? 15 : 12);
  const defaultWeight = startAligned ? 700 : 500;
  return (
    <div
      className="text-balance"
      style={{
        fontFamily: startAligned ? SANS : MONO,
        fontSize,
        lineHeight: `${startAligned ? fontSize + 4 : Math.max(12, fontSize + 2)}px`,
        letterSpacing: startAligned ? undefined : 0.6,
      }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            color: labelLineFill(line, fill, themeAccent),
            fontWeight:
              typeof line === 'string'
                ? (node.fontWeight ?? defaultWeight)
                : (line.fontWeight ?? node.fontWeight ?? defaultWeight),
          }}
        >
          {typeof line === 'string' ? line : line.text}
        </div>
      ))}
    </div>
  );
}
