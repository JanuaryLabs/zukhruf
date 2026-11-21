import { cn } from 'cn';
import { type MotionValue, motion, useTransform } from 'motion/react';
import type { ReactNode } from 'react';

import { compileGraph } from '../../compiler/diagram-compile.ts';
import type {
  NodeLayout,
  TextRun,
} from '../../layouts/graph/graph-layout-result.ts';
import { layoutGraph } from '../../layouts/graph/layout.ts';
import type { FontFace, FontWeight } from '../../layouts/text/font.ts';
import type {
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
  NOTE_REVEAL_START,
  NodeCaption,
  NodePorts,
  NodeStackFrames,
  NoteText,
  SpecialNode,
  isSpecialNode,
  splitNotes,
} from '../shared/node-parts.tsx';
import { DiagramPaperRect } from '../shared/paper.tsx';
import { nodeTextParts, runFill } from '../shared/text-runs.ts';
import { formatZoom, normalizeZoom } from '../shared/viewport-zoom.ts';
import type { GraphRendererProps } from '../types.ts';

export type HtmlGraphDiagramProps = Omit<DiagramProps, 'viewport'> & {
  viewport?: Omit<DiagramViewport, 'fit'>;
};

export function HtmlGraphDiagram({
  title,
  children,
  viewport,
  paper,
  ...chrome
}: HtmlGraphDiagramProps) {
  const ir = compileGraph(children);
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
  const layout = layoutGraph(ir);
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
      className="dgm-text-shaping w-full overflow-x-auto"
      data-diagram-style-preset={stylePreset}
      data-diagram-viewport-zoom={formatZoom(zoom)}
    >
      <div
        className="dgm-zoom relative mx-auto h-(--dgm-h) w-(--dgm-w)"
        style={{
          '--dgm-w': px(viewBox.w),
          '--dgm-h': px(viewBox.h),
          '--dgm-zoom': zoom,
        }}
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
        <div
          className="absolute top-(--dgm-y) left-(--dgm-x)"
          style={{ '--dgm-x': px(-viewBox.x), '--dgm-y': px(-viewBox.y) }}
        >
          {boxNodes.map(({ layout: nodeLayout, segment }) => (
            <NodeBox
              key={`node-${nodeLayout.node.id}`}
              layout={nodeLayout}
              progress={progress}
              start={segment.start}
              end={segment.end}
            />
          ))}
        </div>
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
            <NoteText
              key={note.node.id}
              note={note}
              leaders={layout.leaders}
              progress={progress}
              start={NOTE_REVEAL_START}
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
  const translateY = useTransform(progress, [start, end], ['-10px', '0px'], {
    clamp: true,
  });
  return (
    <motion.g
      opacity={opacity}
      className="translate-y-(--dgm-reveal-y)"
      style={{ '--dgm-reveal-y': translateY }}
    >
      {children}
    </motion.g>
  );
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

function px(value: number) {
  return `${value}px`;
}

function textureImage(texture: DiagramTexture): {
  image?: string;
  size?: string;
} {
  if (texture === 'dots') {
    return {
      image: `radial-gradient(circle at 2px 2px, ${DIAGRAM_DOT} 0.7px, transparent 0.8px)`,
      size: '6px 6px',
    };
  }
  if (texture === 'hatch') {
    return {
      image: `repeating-linear-gradient(135deg, ${DIAGRAM_HATCH} 0 0.8px, transparent 0.8px 5.66px)`,
    };
  }
  return {};
}

/**
 * A node frame and its text, each at the layout's own coordinates, in the
 * layer that GraphHTML moves to the viewBox origin. The runs are siblings of
 * the frame, so no position is relative to the frame.
 */
function NodeBox({
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
  const opacity = useTransform(progress, [start, end], [0, 1], { clamp: true });
  const translateY = useTransform(progress, [start, end], ['-10px', '0px'], {
    clamp: true,
  });
  const { node, box, icon, contentBox } = layout;
  const frame = node.frame ?? 'solid';
  const framed = frame !== 'none';
  const fill = nodeTextFill(node, frame, themeAccent);
  const texture = framed ? textureImage(nodeTexture(node, frame)) : {};
  const { title, description, items } = nodeTextParts(layout);

  return (
    <motion.div
      className="absolute top-0 left-0 translate-y-(--dgm-reveal-y) text-(--dgm-fill) opacity-(--dgm-reveal-opacity)"
      style={{
        '--dgm-fill': fill,
        '--dgm-reveal-opacity': opacity,
        '--dgm-reveal-y': translateY,
      }}
    >
      <div
        data-diagram-node={node.id}
        data-diagram-node-tone={node.tone}
        className={cn(
          'absolute top-(--dgm-y) left-(--dgm-x) box-border h-(--dgm-h) w-(--dgm-w) rounded-(--dgm-radius)',
          framed && 'bg-(--dgm-frame-fill) shadow-(--dgm-frame-shadow)',
          texture.image && 'bg-(image:--dgm-texture)',
          texture.size && 'bg-(length:--dgm-texture-size)',
        )}
        style={{
          '--dgm-x': px(box.x),
          '--dgm-y': px(box.y),
          '--dgm-w': px(box.w),
          '--dgm-h': px(box.h),
          '--dgm-radius': px(layout.radius),
          '--dgm-frame-fill': framed ? nodeFrameFill(node, frame) : undefined,
          '--dgm-frame-shadow': framed
            ? `inset 0 0 0 ${nodeFrameStrokeWidth(node)}px ${nodeFrameStroke(node, frame, themeAccent)}`
            : undefined,
          '--dgm-texture': texture.image,
          '--dgm-texture-size': texture.size,
        }}
      />
      {node.icon && icon && (
        <svg
          width={icon.size}
          height={icon.size}
          className="absolute top-(--dgm-y) left-(--dgm-x)"
          style={{ '--dgm-x': px(icon.x), '--dgm-y': px(icon.y) }}
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
        <RunText key={i} run={run} color={runFill(run, fill, themeAccent)} />
      ))}
      {description.length > 0 && (
        <div data-diagram-node-description={node.id}>
          {description.map((run, i) => (
            <RunText key={i} run={run} />
          ))}
        </div>
      )}
      {items.map(({ run, bullet }, i) => (
        <div key={i} data-diagram-node-item={`${node.id}:${i}`}>
          <span
            className="absolute top-(--dgm-y) left-(--dgm-x) size-dgm-bullet -translate-1/2 rounded-full bg-current"
            style={{ '--dgm-x': px(bullet.x), '--dgm-y': px(bullet.y) }}
          />
          <RunText run={run} />
        </div>
      ))}
      {node.content && contentBox && (
        <div
          data-diagram-node-content={node.id}
          className="absolute top-(--dgm-y) left-(--dgm-x) h-(--dgm-h) w-(--dgm-w)"
          style={{
            '--dgm-x': px(contentBox.x),
            '--dgm-y': px(contentBox.y),
            '--dgm-w': px(contentBox.w),
            '--dgm-h': px(contentBox.h),
          }}
        >
          {node.content.element}
        </div>
      )}
    </motion.div>
  );
}

const FONT_FACE_CLASS: Record<FontFace, string> = {
  sans: 'font-dgm-sans',
  mono: 'font-dgm-mono',
};

const FONT_WEIGHT_CLASS: Record<FontWeight, string> = {
  400: 'font-normal',
  500: 'font-medium',
  600: 'font-semibold',
  700: 'font-bold',
};

function RunText({ run, color }: { run: TextRun; color?: string }) {
  return (
    <span
      className={cn(
        'absolute top-(--dgm-y) left-(--dgm-x) text-(length:--dgm-font-size) leading-(--dgm-line-height) whitespace-pre',
        FONT_FACE_CLASS[run.font.face],
        FONT_WEIGHT_CLASS[run.font.weight],
        color && 'text-(--dgm-run-color)',
      )}
      style={{
        '--dgm-x': px(run.bounds.x),
        '--dgm-y': px(run.bounds.y),
        '--dgm-font-size': px(run.font.size),
        '--dgm-line-height': px(run.bounds.h),
        '--dgm-run-color': color,
      }}
    >
      {run.text}
    </span>
  );
}
