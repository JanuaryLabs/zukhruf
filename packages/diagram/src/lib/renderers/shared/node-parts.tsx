import { type MotionValue, motion, useTransform } from 'motion/react';

import {
  type ResolvedDiagramAnnotation,
  nodeCaptionBounds,
  nodeCaptionPlacement,
  nodePortPlacements,
  nodeStackCount,
  nodeStackFrameBox,
} from '../../layouts/graph/graph-layout.ts';
import type { DiagramNode, Box as SvgBox } from '../../model/diagram-ir.ts';
import {
  DIAGRAM_BG,
  DIAGRAM_DIM,
  DIAGRAM_NEUTRAL,
  DIAGRAM_TEXT,
  resolveDiagramToneFill,
  resolveDiagramToneStroke,
  useDiagramTheme,
} from '../../react/chrome/index.ts';
import {
  DiagramNodeIcon,
  PortMarkers,
  labelLineFill,
  nodeTextFill,
  textureFill,
} from './graph-parts.tsx';

export const ANNOTATION_REVEAL_START = 0.85;

export function isSpecialNode(node: DiagramNode) {
  return node.kind !== undefined && node.kind !== 'node';
}

export function SpecialNode({
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
  const fill = nodeTextFill(node, node.frame ?? 'solid', themeAccent);
  const lines = Array.isArray(node.label) ? node.label : [node.label];
  const fontSize = node.fontSize ?? 12;
  const lineHeight = Math.max(12, fontSize + 2);
  const centerY = box.y + box.h / 2;
  const cx = box.x + box.w / 2;
  if (node.kind === 'appliance') {
    const applianceStroke = node.accent
      ? themeAccent
      : node.tone
        ? resolveDiagramToneStroke(node.tone)
        : DIAGRAM_NEUTRAL;
    const applianceFill = node.tone
      ? resolveDiagramToneFill(node.tone)
      : DIAGRAM_BG;
    const applianceTexture = textureFill(node.texture ?? 'none', ids);
    const bodyX = box.x + 4;
    const bodyY = box.y + Math.max(12, Math.min(22, box.h * 0.28));
    const bodyW = Math.max(36, box.w - 8);
    const bodyH = Math.max(24, box.h - (bodyY - box.y) - 12);
    const slant = Math.max(
      4,
      Math.min(node.slant ?? 16, bodyW * 0.28, bodyH * 0.75),
    );
    const bodyPath = [
      `M ${bodyX + slant} ${bodyY}`,
      `L ${bodyX + bodyW} ${bodyY + 6}`,
      `L ${bodyX + bodyW - slant} ${bodyY + bodyH}`,
      `L ${bodyX} ${bodyY + bodyH - 6}`,
      'Z',
    ].join(' ');
    const showAntenna = node.antenna ?? true;
    const visualPortCount = Math.max(0, Math.floor(node.appliancePorts ?? 4));
    const portY = bodyY + bodyH - 15;
    const portStartX = bodyX + slant + 16;
    const portSpacing = Math.min(
      13,
      Math.max(8, (bodyW - slant - 42) / Math.max(visualPortCount, 1)),
    );
    const labelLines = lines.filter((line) =>
      typeof line === 'string' ? line.length > 0 : line.text.length > 0,
    );
    const labelY = bodyY + bodyH + Math.max(12, fontSize + 2);

    return (
      <motion.g
        data-diagram-appliance={node.id}
        style={{ opacity, y: translateY }}
      >
        {showAntenna && (
          <g data-diagram-appliance-antenna={node.id}>
            <line
              x1={bodyX + slant + bodyW * 0.18}
              y1={bodyY + 1}
              x2={bodyX + slant + bodyW * 0.2 - 3}
              y2={box.y + 3}
              stroke={applianceStroke}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
            <line
              x1={bodyX + slant + bodyW * 0.2 + 1}
              y1={bodyY + 2}
              x2={bodyX + slant + bodyW * 0.2 + 1}
              y2={box.y + 8}
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
          x1={bodyX + slant}
          y1={bodyY + bodyH - 1}
          x2={bodyX + bodyW - slant}
          y2={bodyY + bodyH + 3}
          stroke={applianceStroke}
          strokeWidth={1}
          strokeLinecap="round"
          opacity={0.85}
        />
        {Array.from({ length: visualPortCount }, (_, i) => (
          <rect
            key={i}
            data-diagram-appliance-port={`${node.id}:${i}`}
            x={portStartX + i * portSpacing}
            y={portY}
            width={5}
            height={12}
            rx={1}
            fill={DIAGRAM_BG}
            stroke={applianceStroke}
            strokeWidth={1}
          />
        ))}
        {labelLines.length > 0 && (
          <text
            data-diagram-appliance-label={node.id}
            x={cx}
            y={labelY}
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontSize={fontSize}
            fontWeight={node.fontWeight ?? 600}
            fill={fill}
          >
            {labelLines.map((line, i) => {
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
                      ? (node.fontWeight ?? 600)
                      : (line.fontWeight ?? node.fontWeight ?? 600)
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
  if (node.kind === 'connector') {
    const connectorStroke = node.accent
      ? themeAccent
      : node.tone
        ? resolveDiagramToneStroke(node.tone)
        : DIAGRAM_NEUTRAL;
    const connectorFill = node.tone
      ? resolveDiagramToneFill(node.tone)
      : DIAGRAM_BG;
    const connectorTexture = textureFill(
      node.texture ?? (node.tone ? 'dots' : 'none'),
      ids,
    );
    const connectorRx = node.rx ?? Math.min(12, box.h / 2);
    const connectorIconSize = node.iconSize ?? 18;
    const connectorFontSize = node.fontSize ?? 10;
    const connectorLineHeight = Math.max(12, connectorFontSize + 2);
    const connectorLines = lines.filter((line) =>
      typeof line === 'string' ? line.length > 0 : line.text.length > 0,
    );
    const hasConnectorText = connectorLines.length > 0;
    const iconX = box.x + 10;
    const iconY = centerY - connectorIconSize / 2;
    const textX = node.icon ? iconX + connectorIconSize + 8 : box.x + box.w / 2;
    const textAnchor = node.icon ? ('start' as const) : ('middle' as const);
    const textY =
      centerY -
      ((connectorLines.length - 1) * connectorLineHeight) / 2 +
      connectorFontSize * 0.35;

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
          rx={connectorRx}
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
            rx={connectorRx}
            fill={connectorTexture}
            pointerEvents="none"
          />
        )}
        {node.icon && (
          <DiagramNodeIcon
            icon={node.icon}
            x={iconX}
            y={iconY}
            size={connectorIconSize}
            color={fill}
          />
        )}
        {hasConnectorText && (
          <text
            data-diagram-connector-label={node.id}
            x={textX}
            y={textY}
            textAnchor={textAnchor}
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontSize={connectorFontSize}
            fontWeight={node.fontWeight ?? 700}
            fill={fill}
          >
            {connectorLines.map((line, i) => {
              const lineText = typeof line === 'string' ? line : line.text;
              const lineFill = labelLineFill(line, fill, themeAccent);
              return (
                <tspan
                  key={i}
                  x={textX}
                  dy={i === 0 ? 0 : connectorLineHeight}
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
        <NodePorts node={node} box={box} />
        <NodeCaption node={node} box={box} />
      </motion.g>
    );
  }
  if (node.kind === 'marker') {
    const markerIconSize = node.iconSize ?? 34;
    const markerFontSize = node.fontSize ?? 11;
    const markerLineHeight = Math.max(12, markerFontSize + 2);
    const markerLines = lines.filter((line) =>
      typeof line === 'string' ? line.length > 0 : line.text.length > 0,
    );
    const labelGap = markerLines.length > 0 ? 8 : 0;
    const labelBlockHeight = markerLines.length * markerLineHeight;
    const totalHeight = markerIconSize + labelGap + labelBlockHeight;
    const iconX = Math.round(cx - markerIconSize / 2);
    const iconY = Math.round(box.y + (box.h - totalHeight) / 2);
    const markerLabelY = iconY + markerIconSize + labelGap + markerFontSize;
    const markerStroke = node.accent
      ? themeAccent
      : node.tone
        ? resolveDiagramToneStroke(node.tone)
        : fill;

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
          rx={node.rx ?? 0}
          fill="transparent"
          stroke="none"
        />
        <DiagramNodeIcon
          icon={node.icon ?? 'ellipsis'}
          x={iconX}
          y={iconY}
          size={markerIconSize}
          color={markerStroke}
        />
        {markerLines.length > 0 && (
          <text
            data-diagram-marker-label={node.id}
            x={cx}
            y={markerLabelY}
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontSize={markerFontSize}
            fontWeight={node.fontWeight ?? 700}
            fill={fill}
          >
            {markerLines.map((line, i) => {
              const lineText = typeof line === 'string' ? line : line.text;
              const lineFill = labelLineFill(line, fill, themeAccent);
              return (
                <tspan
                  key={i}
                  x={cx}
                  dy={i === 0 ? 0 : markerLineHeight}
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
        <NodePorts node={node} box={box} />
        <NodeCaption node={node} box={box} />
      </motion.g>
    );
  }
  if (node.kind === 'junction') {
    const junctionStroke = node.accent
      ? themeAccent
      : node.tone
        ? resolveDiagramToneStroke(node.tone)
        : DIAGRAM_NEUTRAL;
    const junctionFill = node.accent
      ? themeAccent
      : node.tone
        ? resolveDiagramToneFill(node.tone)
        : DIAGRAM_BG;
    return (
      <motion.g style={{ opacity, y: translateY }}>
        <circle
          data-diagram-junction={node.id}
          cx={cx}
          cy={centerY}
          r={Math.max(4, Math.min(box.w, box.h) / 2)}
          fill={junctionFill}
          stroke={junctionStroke}
          strokeWidth={1.5}
        />
        {lines.some(Boolean) && (
          <text
            data-diagram-junction-label={node.id}
            x={cx}
            y={centerY - Math.max(8, box.h / 2 + 6)}
            textAnchor="middle"
            fontFamily="ui-monospace, 'Geist Mono', monospace"
            fontSize={node.fontSize ?? 10}
            fontWeight={node.fontWeight ?? 600}
            fill={fill}
          >
            {lines.map((line, i) => {
              const lineText = typeof line === 'string' ? line : line.text;
              return (
                <tspan key={i} x={cx} dy={i === 0 ? 0 : lineHeight}>
                  {lineText}
                </tspan>
              );
            })}
          </text>
        )}
        <NodeCaption node={node} box={box} />
      </motion.g>
    );
  }
  return null;
}

export function NodeStackFrames({
  node,
  box,
  rx,
  fill,
  stroke,
  strokeWidth,
}: {
  node: DiagramNode;
  box: SvgBox;
  rx: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}) {
  const stackCount = nodeStackCount(node);
  return Array.from({ length: stackCount - 1 }, (_, i) => {
    const level = stackCount - 1 - i;
    const stackBox = nodeStackFrameBox(node, box, level);
    return (
      <rect
        key={`stack-${level}`}
        data-diagram-node-stack={`${node.id}:${level}`}
        x={stackBox.x}
        y={stackBox.y}
        width={stackBox.w}
        height={stackBox.h}
        rx={rx}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  });
}

export function NodePorts({ node, box }: { node: DiagramNode; box: SvgBox }) {
  return (
    <PortMarkers ownerId={node.id} placements={nodePortPlacements(node, box)} />
  );
}

export function NodeCaption({ node, box }: { node: DiagramNode; box: SvgBox }) {
  const { accent: themeAccent } = useDiagramTheme();
  const placement = nodeCaptionPlacement(node, box);
  if (!placement) return null;
  const fill =
    node.captionColor === 'accent'
      ? themeAccent
      : node.captionColor === 'dim'
        ? DIAGRAM_DIM
        : DIAGRAM_TEXT;
  const frame = node.captionFrame ? nodeCaptionBounds(node, box) : null;
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
        x={placement.x}
        y={placement.y}
        textAnchor={placement.align}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize={placement.fontSize}
        fontWeight={node.captionFontWeight ?? 600}
        fill={fill}
      >
        {placement.lines.map((line, i) => (
          <tspan
            key={i}
            x={placement.x}
            dy={i === 0 ? 0 : placement.lineHeight}
          >
            {line}
          </tspan>
        ))}
      </text>
    </>
  );
}

export function AnnotationText({
  annotation,
  progress,
  start,
  end,
  index,
}: {
  annotation: ResolvedDiagramAnnotation;
  progress: MotionValue<number>;
  start: number;
  end: number;
  index: number;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  const opacity = useTransform(progress, [start, end], [0, 1], { clamp: true });
  const fill =
    annotation.color === 'accent'
      ? themeAccent
      : annotation.color === 'dim'
        ? DIAGRAM_DIM
        : DIAGRAM_TEXT;
  const align = annotation.align ?? 'middle';
  const fontSize = annotation.fontSize ?? 11;
  const fontWeight = annotation.fontWeight ?? 500;
  const lineGap = annotation.lineGap ?? 4;
  const annotationTargets = annotation.targets?.join('+');
  const annotationId =
    annotation.target || annotationTargets
      ? `${annotation.target ?? annotationTargets}:${annotation.anchor ?? 'top'}`
      : `free:${index}`;
  const leaders =
    annotation.leaders ??
    (annotation.leaderFrom && annotation.leaderTo
      ? [
          {
            target: annotation.target,
            anchor: annotation.anchor,
            route: 'straight',
            from: annotation.leaderFrom,
            to: annotation.leaderTo,
            points: [annotation.leaderFrom, annotation.leaderTo],
          },
        ]
      : []);
  return (
    <motion.g style={{ opacity }}>
      {leaders.map((leader, leaderIndex) =>
        leader.route === 'elbow' && leader.points.length > 2 ? (
          <path
            key={`${leader.target ?? 'free'}:${leaderIndex}`}
            data-diagram-annotation-leader={annotationId}
            data-diagram-annotation-leader-target={leader.target}
            data-diagram-annotation-leader-anchor={leader.anchor}
            data-diagram-annotation-leader-index={leaderIndex}
            data-diagram-annotation-leader-route={leader.route}
            d={annotationLeaderPath(leader.points)}
            fill="none"
            stroke={DIAGRAM_NEUTRAL}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <line
            key={`${leader.target ?? 'free'}:${leaderIndex}`}
            data-diagram-annotation-leader={annotationId}
            data-diagram-annotation-leader-target={leader.target}
            data-diagram-annotation-leader-anchor={leader.anchor}
            data-diagram-annotation-leader-index={leaderIndex}
            data-diagram-annotation-leader-route={leader.route}
            x1={leader.from.x}
            y1={leader.from.y}
            x2={leader.to.x}
            y2={leader.to.y}
            stroke={DIAGRAM_NEUTRAL}
            strokeWidth={1}
            strokeLinecap="round"
          />
        ),
      )}
      <text
        data-diagram-annotation={annotationId}
        data-diagram-annotation-target={annotation.target}
        data-diagram-annotation-targets={annotation.targets?.join(' ')}
        data-diagram-annotation-anchor={annotation.anchor}
        data-diagram-annotation-guide={annotation.guide}
        data-diagram-annotation-line-gap={annotation.lineGap}
        x={annotation.x}
        y={annotation.y}
        textAnchor={align}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize={fontSize}
        fontWeight={fontWeight}
        fill={fill}
      >
        {annotation.text.map((line, i) => (
          <tspan key={i} x={annotation.x} dy={i === 0 ? 0 : fontSize + lineGap}>
            {line}
          </tspan>
        ))}
      </text>
    </motion.g>
  );
}

function annotationLeaderPath(points: { x: number; y: number }[]) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}
