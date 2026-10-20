import { type MotionValue, motion, useTransform } from 'motion/react';

import { compileGraph } from '../../compiler/diagram-compile.ts';
import type { NodeLayout } from '../../layouts/graph/graph-layout-result.ts';
import { layoutGraph } from '../../layouts/graph/layout.ts';
import { FONT_FAMILY, TEXT_SHAPING } from '../../layouts/text/font.ts';
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
  nodeFrameFill,
  nodeFrameStroke,
  nodeFrameStrokeWidth,
  nodeTextFill,
  nodeTexture,
  textureFill,
} from '../shared/graph-parts.tsx';
import { rejectNodeContent } from '../shared/node-content.ts';
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
import { RunSpans } from '../shared/run-spans.tsx';
import { nodeTextParts } from '../shared/text-runs.ts';
import type { DiagramEffects, GraphRendererProps } from '../types.ts';
import { GraphFlowEffects } from '../webgpu/graph-flow-effects.tsx';
import { svgViewportProps } from './viewport.ts';

function NodeRect({
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
  const { accent: themeAccent, ids } = useDiagramTheme();
  const opacity = useTransform(progress, [start, end], [0, 1], {
    clamp: true,
  });
  const translateY = useTransform(progress, [start, end], [-10, 0], {
    clamp: true,
  });
  const { node, box, radius } = layout;
  const frame = node.frame ?? 'solid';
  const strokeWidth = nodeFrameStrokeWidth(node);
  const stroke = nodeFrameStroke(node, frame, themeAccent);
  const boxFill = nodeFrameFill(node, frame);
  const texture = nodeTexture(node, frame);
  const texturePattern = textureFill(texture, ids);
  const fill = nodeTextFill(node, frame, themeAccent);
  if (node.hidden) return null;
  if (isSpecialNode(node)) {
    return (
      <SpecialNode
        layout={layout}
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
            layout={layout}
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
            rx={radius}
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
              rx={radius}
              fill={texturePattern}
              pointerEvents="none"
            />
          )}
        </>
      )}
      <NodeBody layout={layout} fill={fill} accent={themeAccent} />
      <NodePorts layout={layout} />
      <NodeCaption layout={layout} />
    </motion.g>
  );
}

function NodeBody({
  layout,
  fill,
  accent,
}: {
  layout: NodeLayout;
  fill: string;
  accent: string;
}) {
  const { node, icon } = layout;
  const { title, description, items } = nodeTextParts(layout);
  const [firstTitle] = title;
  const [firstDescription] = description;

  return (
    <>
      {node.icon && icon && (
        <DiagramNodeIcon
          icon={node.icon}
          x={icon.x}
          y={icon.y}
          size={icon.size}
          color={node.textColor === 'accent' ? accent : fill}
        />
      )}
      {firstTitle && (
        <text
          x={firstTitle.x}
          y={firstTitle.y}
          textAnchor={firstTitle.anchor}
          fontFamily={FONT_FAMILY[firstTitle.font.face]}
          fontSize={firstTitle.font.size}
          fontWeight={firstTitle.font.weight}
          fill={fill}
        >
          <RunSpans runs={title} fill={fill} accent={accent} />
        </text>
      )}
      {firstDescription && (
        <text
          data-diagram-node-description={node.id}
          x={firstDescription.x}
          y={firstDescription.y}
          textAnchor="start"
          fontFamily={FONT_FAMILY[firstDescription.font.face]}
          fontSize={firstDescription.font.size}
          fontWeight={firstDescription.font.weight}
          fill={fill}
        >
          <RunSpans runs={description} />
        </text>
      )}
      {items.length > 0 && (
        <g>
          {items.map(({ run, bullet }, i) => (
            <g key={i} data-diagram-node-item={`${node.id}:${i}`}>
              <circle cx={bullet.x} cy={bullet.y} r={2.2} fill={fill} />
              <text
                x={run.x}
                y={run.y}
                textAnchor="start"
                fontFamily={FONT_FAMILY[run.font.face]}
                fontSize={run.font.size}
                fontWeight={run.font.weight}
                fill={fill}
              >
                {run.text}
              </text>
            </g>
          ))}
        </g>
      )}
    </>
  );
}

export type SvgGraphDiagramProps = DiagramProps & {
  /** Moving signals over the graph edges, rendered with WebGPU. */
  effects?: DiagramEffects;
};

export function SvgGraphDiagram({
  title,
  children,
  viewport,
  paper,
  effects,
  ...chrome
}: SvgGraphDiagramProps) {
  const ir = compileGraph(children);
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

      {graphNodes.map((nodeLayout, i) => {
        const segNode = seg('node', i);
        return (
          <NodeRect
            key={`node-${nodeLayout.node.id}`}
            layout={nodeLayout}
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
  );
}
