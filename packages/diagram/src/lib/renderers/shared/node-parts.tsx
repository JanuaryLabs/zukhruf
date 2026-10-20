import { type MotionValue, motion, useTransform } from 'motion/react';

import type {
  LeaderLayout,
  NodeLayout,
  TextRun,
} from '../../layouts/graph/graph-layout-result.ts';
import { FONT_FAMILY } from '../../layouts/text/font.ts';
import type { DiagramNode, DiagramTextColor } from '../../model/diagram-ir.ts';
import {
  DIAGRAM_BG,
  DIAGRAM_DIM,
  DIAGRAM_NEUTRAL,
  DIAGRAM_TEXT,
  resolveDiagramToneFill,
  useDiagramTheme,
} from '../../react/chrome/index.ts';
import {
  DiagramNodeIcon,
  PortMarkers,
  accentToneStroke,
  nodeTextFill,
  textureFill,
} from './graph-parts.tsx';
import { RunSpans } from './run-spans.tsx';

export const NOTE_REVEAL_START = 0.85;

export function isSpecialNode(node: DiagramNode) {
  return node.kind !== undefined && node.kind !== 'node';
}

function isNote(layout: NodeLayout) {
  return layout.node.kind === 'note';
}

/** Splits the framed nodes from the notes, which draw last, over the edges. */
export function splitNotes(nodes: NodeLayout[]) {
  return {
    graphNodes: nodes.filter((layout) => !isNote(layout)),
    notes: nodes.filter(isNote),
  };
}

function textAttrs(first: TextRun) {
  return {
    x: first.x,
    y: first.y,
    textAnchor: first.anchor,
    fontFamily: FONT_FAMILY[first.font.face],
    fontSize: first.font.size,
    fontWeight: first.font.weight,
  };
}

function junctionFillColor(node: DiagramNode, themeAccent: string) {
  if (node.accent) return themeAccent;
  if (node.tone) return resolveDiagramToneFill(node.tone);
  return DIAGRAM_BG;
}

export function SpecialNode({
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
  const { node, box, radius, icon, text, appliance } = layout;
  const fill = nodeTextFill(node, node.frame ?? 'solid', themeAccent);
  const [first] = text;
  if (node.kind === 'appliance' && appliance) {
    const applianceStroke = accentToneStroke(
      node,
      themeAccent,
      DIAGRAM_NEUTRAL,
    );
    const applianceFill = node.tone
      ? resolveDiagramToneFill(node.tone)
      : DIAGRAM_BG;
    const applianceTexture = textureFill(node.texture ?? 'none', ids);
    const bodyPath = [
      ...appliance.body.map(
        (point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`,
      ),
      'Z',
    ].join(' ');
    const [faceFrom, faceTo] = appliance.face;
    const [rod, mast] = appliance.antenna;

    return (
      <motion.g
        data-diagram-appliance={node.id}
        style={{ opacity, y: translateY }}
      >
        {rod && mast && (
          <g data-diagram-appliance-antenna={node.id}>
            <line
              x1={rod[0].x}
              y1={rod[0].y}
              x2={rod[1].x}
              y2={rod[1].y}
              stroke={applianceStroke}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
            <line
              x1={mast[0].x}
              y1={mast[0].y}
              x2={mast[1].x}
              y2={mast[1].y}
              stroke={applianceStroke}
              strokeWidth={1}
              strokeLinecap="round"
            />
          </g>
        )}
        <path
          data-diagram-node={node.id}
          data-diagram-node-tone={node.tone}
          data-diagram-appliance-body={node.id}
          d={bodyPath}
          fill={applianceFill}
          stroke={applianceStroke}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {applianceTexture && (
          <path
            data-diagram-node-texture={`${node.id}:${node.texture ?? 'none'}`}
            d={bodyPath}
            fill={applianceTexture}
            pointerEvents="none"
          />
        )}
        <line
          data-diagram-appliance-face={node.id}
          x1={faceFrom.x}
          y1={faceFrom.y}
          x2={faceTo.x}
          y2={faceTo.y}
          stroke={applianceStroke}
          strokeWidth={1}
          strokeLinecap="round"
          opacity={0.85}
        />
        {appliance.jacks.map((jack, i) => (
          <rect
            key={i}
            data-diagram-appliance-port={`${node.id}:${i}`}
            x={jack.x}
            y={jack.y}
            width={jack.w}
            height={jack.h}
            rx={1}
            fill={DIAGRAM_BG}
            stroke={applianceStroke}
            strokeWidth={1}
          />
        ))}
        {first && (
          <text
            data-diagram-appliance-label={node.id}
            {...textAttrs(first)}
            fill={fill}
          >
            <RunSpans runs={text} fill={fill} accent={themeAccent} />
          </text>
        )}
        <NodePorts layout={layout} />
        <NodeCaption layout={layout} />
      </motion.g>
    );
  }
  if (node.kind === 'connector') {
    const connectorStroke = accentToneStroke(
      node,
      themeAccent,
      DIAGRAM_NEUTRAL,
    );
    const connectorFill = node.tone
      ? resolveDiagramToneFill(node.tone)
      : DIAGRAM_BG;
    const connectorTexture = textureFill(
      node.texture ?? (node.tone ? 'dots' : 'none'),
      ids,
    );

    return (
      <motion.g style={{ opacity, y: translateY }}>
        <rect
          data-diagram-node={node.id}
          data-diagram-connector={node.id}
          data-diagram-node-tone={node.tone}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={radius}
          fill={connectorFill}
          stroke={connectorStroke}
          strokeWidth={1.25}
        />
        {connectorTexture && (
          <rect
            data-diagram-node-texture={`${node.id}:${node.texture ?? 'dots'}`}
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            rx={radius}
            fill={connectorTexture}
            pointerEvents="none"
          />
        )}
        {node.icon && icon && (
          <DiagramNodeIcon
            icon={node.icon}
            x={icon.x}
            y={icon.y}
            size={icon.size}
            color={fill}
          />
        )}
        {first && (
          <text
            data-diagram-connector-label={node.id}
            {...textAttrs(first)}
            fill={fill}
          >
            <RunSpans runs={text} fill={fill} accent={themeAccent} />
          </text>
        )}
        <NodePorts layout={layout} />
        <NodeCaption layout={layout} />
      </motion.g>
    );
  }
  if (node.kind === 'marker' && icon) {
    const markerStroke = accentToneStroke(node, themeAccent, fill);

    return (
      <motion.g
        data-diagram-marker={node.id}
        style={{ opacity, y: translateY }}
      >
        <rect
          data-diagram-node={node.id}
          data-diagram-marker-bounds={node.id}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={radius}
          fill="transparent"
          stroke="none"
        />
        <DiagramNodeIcon
          icon={node.icon ?? 'ellipsis'}
          x={icon.x}
          y={icon.y}
          size={icon.size}
          color={markerStroke}
        />
        {first && (
          <text
            data-diagram-marker-label={node.id}
            {...textAttrs(first)}
            fill={fill}
          >
            <RunSpans runs={text} fill={fill} accent={themeAccent} />
          </text>
        )}
        <NodePorts layout={layout} />
        <NodeCaption layout={layout} />
      </motion.g>
    );
  }
  if (node.kind === 'junction') {
    const junctionStroke = accentToneStroke(node, themeAccent, DIAGRAM_NEUTRAL);
    const junctionFill = junctionFillColor(node, themeAccent);
    return (
      <motion.g style={{ opacity, y: translateY }}>
        <rect
          data-diagram-junction={node.id}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={radius}
          fill={junctionFill}
          stroke={junctionStroke}
          strokeWidth={1.5}
        />
        {first && (
          <text
            data-diagram-junction-label={node.id}
            {...textAttrs(first)}
            fill={fill}
          >
            <RunSpans runs={text} />
          </text>
        )}
        <NodeCaption layout={layout} />
      </motion.g>
    );
  }
  return null;
}

export function NodeStackFrames({
  layout,
  fill,
  stroke,
  strokeWidth,
}: {
  layout: NodeLayout;
  fill: string;
  stroke: string;
  strokeWidth: number;
}) {
  const { node, frames, radius } = layout;
  return frames
    .map((frame, i) => ({ frame, level: i + 1 }))
    .reverse()
    .map(({ frame, level }) => (
      <rect
        key={`stack-${level}`}
        data-diagram-node-stack={`${node.id}:${level}`}
        x={frame.x}
        y={frame.y}
        width={frame.w}
        height={frame.h}
        rx={radius}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    ));
}

export function NodePorts({ layout }: { layout: NodeLayout }) {
  return (
    <PortMarkers
      ownerId={layout.node.id}
      ports={layout.ports}
      declared={layout.node.ports}
    />
  );
}

function textColorFill(color: DiagramTextColor | undefined, accent: string) {
  if (color === 'accent') return accent;
  if (color === 'dim') return DIAGRAM_DIM;
  return DIAGRAM_TEXT;
}

export function NodeCaption({ layout }: { layout: NodeLayout }) {
  const { accent: themeAccent } = useDiagramTheme();
  const { node, caption } = layout;
  const [first] = caption?.text ?? [];
  if (!caption || !first) return null;
  const fill = textColorFill(node.captionColor, themeAccent);
  const frame = caption.framed ? caption.box : null;
  return (
    <>
      {frame && (
        <rect
          data-diagram-node-caption-frame={node.id}
          x={frame.x}
          y={frame.y}
          width={frame.w}
          height={frame.h}
          rx={frame.h / 2}
          fill={DIAGRAM_BG}
          stroke={fill}
          strokeWidth={1}
        />
      )}
      <text
        data-diagram-node-caption={node.id}
        {...textAttrs(first)}
        fill={fill}
      >
        <RunSpans runs={caption.text} />
      </text>
    </>
  );
}

export function NoteText({
  note,
  leaders,
  progress,
  start,
  end,
}: {
  note: NodeLayout;
  leaders: LeaderLayout[];
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  const opacity = useTransform(progress, [start, end], [0, 1], { clamp: true });
  const { node, text } = note;
  const [first] = text;
  return (
    <motion.g style={{ opacity }}>
      {leaders
        .filter((leader) => leader.note === node.id)
        .map((leader) => (
          <path
            key={leader.target}
            data-diagram-note-leader={node.id}
            data-diagram-note-leader-target={leader.target}
            d={leader.d}
            fill="none"
            stroke={DIAGRAM_NEUTRAL}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      {first && (
        <text
          data-diagram-note={node.id}
          data-diagram-note-target={node.target}
          {...textAttrs(first)}
          fill={DIAGRAM_TEXT}
        >
          <RunSpans runs={text} fill={DIAGRAM_TEXT} accent={themeAccent} />
        </text>
      )}
    </motion.g>
  );
}
