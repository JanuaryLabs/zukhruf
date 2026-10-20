import { type MotionValue, motion, useTransform } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';

import { compileGraph } from '../../compiler/diagram-compile.ts';
import type {
  NodeLayout,
  TextRun,
} from '../../layouts/graph/graph-layout-result.ts';
import { legacyGraphLayout } from '../../layouts/graph/legacy-graph-layout.ts';
import { FONT_FAMILY, TEXT_SHAPING } from '../../layouts/text/font.ts';
import type {
  Box,
  DiagramGraphLayout,
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
  nodeFrameFill,
  nodeFrameStroke,
  nodeFrameStrokeWidth,
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
  splitNotes,
} from '../shared/node-parts.tsx';
import { DiagramPaperRect } from '../shared/paper.tsx';
import { nodeTextParts, runFill } from '../shared/text-runs.ts';
import { formatZoom, normalizeZoom } from '../shared/viewport-zoom.ts';
import type { GraphRendererProps } from '../types.ts';

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
  const layout = legacyGraphLayout(ir);
  const { viewBox } = layout;
  const segments = buildSegments(ir.nodes.length, ir.edges.length);
  const seg = (kind: SegmentKind, index = 0) => {
    const segment = segments.find(
      (candidate) => candidate.kind === kind && candidate.index === index,
    );
    if (!segment) throw new Error(`segment ${kind}[${index}] missing`);
    return segment;
  };
  const groupsSeg = seg('groups');
  const indexedEdges = layout.edges
    .map((edgeLayout, index) => ({
      ...edgeLayout,
      index,
      segment: seg('edge', index),
      layer: edgeLayout.edge.layer ?? 'foreground',
    }))
    .filter(({ d }) => Boolean(d));
  const { graphNodes, notes } = splitNotes(layout.nodes);
  const nodes = graphNodes
    .map((nodeLayout, i) => ({ layout: nodeLayout, segment: seg('node', i) }))
    .filter(({ layout: { node } }) => !node.hidden);
  const boxNodes = nodes.filter(({ layout: { node } }) => !isSpecialNode(node));
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
      style={TEXT_SHAPING}
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
          {layout.groups.map((groupLayout) => (
            <GroupRect
              key={`group-${groupLayout.group.id}`}
              layout={groupLayout}
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
          {nodes.map(({ layout: nodeLayout, segment }) =>
            isSpecialNode(nodeLayout.node) ? (
              <SpecialNode
                key={`node-${nodeLayout.node.id}`}
                layout={nodeLayout}
                progress={progress}
                start={segment.start}
                end={segment.end}
              />
            ) : (
              <NodeStack
                key={`stack-${nodeLayout.node.id}`}
                layout={nodeLayout}
                progress={progress}
                start={segment.start}
                end={segment.end}
              />
            ),
          )}
        </svg>
        {boxNodes.map(({ layout: nodeLayout, segment }) => (
          <NodeBox
            key={`node-${nodeLayout.node.id}`}
            layout={nodeLayout}
            origin={viewBox}
            progress={progress}
            start={segment.start}
            end={segment.end}
          />
        ))}
        <svg {...svgLayer}>
          {boxNodes.map(({ layout: nodeLayout, segment }) => (
            <NodeReveal
              key={`node-marks-${nodeLayout.node.id}`}
              progress={progress}
              start={segment.start}
              end={segment.end}
            >
              <NodePorts layout={nodeLayout} />
              <NodeCaption layout={nodeLayout} />
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
          {indexedEdges.map((edgeLayout) => (
            <EdgeOverlay
              key={`edge-overlay-${edgeLayout.index}`}
              layout={edgeLayout}
              progress={progress}
              start={edgeLayout.segment.start}
              end={edgeLayout.segment.end}
            />
          ))}
          {notes.map((note) => (
            <AnnotationText
              key={note.node.id}
              note={note}
              annotations={ir.annotations}
              leaders={layout.leaders}
              progress={progress}
              start={ANNOTATION_REVEAL_START}
              end={1}
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
  layout,
  progress,
  start,
  end,
}: {
  layout: NodeLayout;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  const { node } = layout;
  const frame = node.frame ?? 'solid';
  if (layout.frames.length === 0) return null;
  return (
    <NodeReveal progress={progress} start={start} end={end}>
      <NodeStackFrames
        layout={layout}
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

/**
 * A node frame with its text drawn as absolutely placed runs, at the positions
 * the SVG output draws them. The frame is an inset shadow, not a border, so the
 * runs share the frame's origin.
 */
function NodeBox({
  layout,
  origin,
  progress,
  start,
  end,
}: {
  layout: NodeLayout;
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
  const { node, box, icon, text } = layout;
  const frame = node.frame ?? 'solid';
  const fill = nodeTextFill(node, frame, themeAccent);
  const { title, description, items } = nodeTextParts(layout);
  const lastRun = text.at(-1);

  return (
    <motion.div
      data-diagram-node={node.id}
      data-diagram-node-tone={node.tone}
      className="absolute"
      style={{
        left: box.x - origin.x,
        top: box.y - origin.y,
        width: box.w,
        height: box.h,
        boxSizing: 'border-box',
        borderRadius: layout.radius,
        ...(frame === 'none'
          ? {}
          : {
              backgroundColor: nodeFrameFill(node, frame),
              boxShadow: `inset 0 0 0 ${nodeFrameStrokeWidth(node)}px ${nodeFrameStroke(node, frame, themeAccent)}`,
              ...textureImage(nodeTexture(node, frame)),
            }),
        color: fill,
        opacity,
        y: translateY,
      }}
    >
      {node.icon && icon && (
        <svg
          width={icon.size}
          height={icon.size}
          className="absolute"
          style={{ left: icon.x - box.x, top: icon.y - box.y }}
          aria-hidden
        >
          <DiagramNodeIcon
            icon={node.icon}
            x={0}
            y={0}
            size={icon.size}
            color={node.textColor === 'accent' ? themeAccent : fill}
          />
        </svg>
      )}
      {title.map((run, i) => (
        <RunText
          key={i}
          run={run}
          origin={box}
          color={runFill(run, fill, themeAccent)}
        />
      ))}
      {description.length > 0 && (
        <div data-diagram-node-description={node.id}>
          {description.map((run, i) => (
            <RunText key={i} run={run} origin={box} />
          ))}
        </div>
      )}
      {items.map(({ run, bullet }, i) => (
        <div key={i} data-diagram-node-item={`${node.id}:${i}`}>
          <span
            className="absolute rounded-full bg-current"
            style={{
              left: bullet.x - box.x - 2.2,
              top: bullet.y - box.y - 2.2,
              width: 4.4,
              height: 4.4,
            }}
          />
          <RunText run={run} origin={box} />
        </div>
      ))}
      {node.content !== undefined && (
        <div
          className="absolute inset-x-0 bottom-0 flex flex-col items-center justify-center"
          style={{
            top: lastRun ? lastRun.bounds.y + lastRun.bounds.h - box.y : 0,
          }}
        >
          <div data-diagram-node-content={node.id}>{node.content}</div>
        </div>
      )}
    </motion.div>
  );
}

function RunText({
  run,
  origin,
  color,
}: {
  run: TextRun;
  origin: Box;
  color?: string;
}) {
  return (
    <span
      className="absolute whitespace-pre"
      style={{
        left: run.bounds.x - origin.x,
        top: run.bounds.y - origin.y,
        fontFamily: FONT_FAMILY[run.font.face],
        fontSize: run.font.size,
        fontWeight: run.font.weight,
        lineHeight: `${run.bounds.h}px`,
        letterSpacing: run.font.face === 'mono' ? 0.6 : undefined,
        color,
      }}
    >
      {run.text}
    </span>
  );
}
