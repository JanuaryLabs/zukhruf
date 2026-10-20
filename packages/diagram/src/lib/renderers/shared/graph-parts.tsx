import { type MotionValue, motion, useTransform } from 'motion/react';

import type {
  EdgeLayout,
  GroupLayout,
  PortLayout,
} from '../../layouts/graph/graph-layout-result.ts';
import { FONT_FAMILY } from '../../layouts/text/font.ts';
import type {
  DiagramEdge,
  DiagramEdgeWeight,
  DiagramNode,
  DiagramNodeIcon as DiagramNodeIconName,
  DiagramNodePort,
  DiagramTexture,
  DiagramTone,
} from '../../model/diagram-ir.ts';
import {
  DIAGRAM_BG,
  DIAGRAM_DIM,
  DIAGRAM_NEUTRAL,
  DIAGRAM_ON_ACCENT,
  DIAGRAM_SURFACE_MUTED,
  DIAGRAM_TEXT,
  type DiagramIds,
  resolveDiagramToneFill,
  resolveDiagramToneStroke,
  useDiagramTheme,
} from '../../react/chrome/index.ts';
import { RunSpans } from './run-spans.tsx';

export function nodeFrameFill(node: DiagramNode, frame: DiagramNode['frame']) {
  if (frame === 'transparent') return 'transparent';
  if (frame === 'filled') return DIAGRAM_TEXT;
  if (node.tone) return resolveDiagramToneFill(node.tone);
  if (frame === 'flat') return DIAGRAM_SURFACE_MUTED;
  return DIAGRAM_BG;
}

export function nodeFrameStroke(
  node: DiagramNode,
  frame: DiagramNode['frame'],
  themeAccent: string,
) {
  if (frame === 'transparent' || frame === 'flat') return 'transparent';
  if (frame === 'filled') return DIAGRAM_TEXT;
  return accentToneStroke(node, themeAccent, DIAGRAM_NEUTRAL);
}

/** The theme accent, else the tone's stroke, else the fallback. */
export function accentToneStroke(
  subject: { accent?: boolean | undefined; tone?: DiagramTone | undefined },
  themeAccent: string,
  fallback: string,
) {
  if (subject.accent) return themeAccent;
  if (subject.tone) return resolveDiagramToneStroke(subject.tone);
  return fallback;
}

export function nodeTextFill(
  node: DiagramNode,
  frame: DiagramNode['frame'],
  themeAccent: string,
) {
  if (node.textColor === 'accent') return themeAccent;
  if (node.textColor === 'dim') return DIAGRAM_DIM;
  return frame === 'filled' ? DIAGRAM_ON_ACCENT : DIAGRAM_TEXT;
}

export function nodeFrameStrokeWidth(node: DiagramNode) {
  return node.frame === 'flat' ? 0 : 1.5;
}

export function nodeTexture(node: DiagramNode, frame: DiagramNode['frame']) {
  return node.texture ?? (frame === 'solid' ? 'dots' : 'none');
}

export function textureFill(texture: DiagramTexture, ids: DiagramIds) {
  if (texture === 'dots') return `url(#${ids.dots})`;
  if (texture === 'hatch') return `url(#${ids.hatch})`;
  return null;
}

function edgeDasharray(edge: DiagramEdge) {
  if (edge.lineStyle === 'dashed') return '6 6';
  if (edge.lineStyle === 'dotted') return '1 6';
  return undefined;
}

/** The stroke width of an edge of each weight. */
export const EDGE_STROKE_WIDTH: Record<DiagramEdgeWeight, number> = {
  regular: 1.5,
  bold: 3,
};

/** The corner radius a group frame is drawn with. */
const GROUP_RADIUS = 12;

function edgeStroke(edge: DiagramEdge, themeAccent: string) {
  if (edge.accent) return themeAccent;
  if (edge.dim) return DIAGRAM_DIM;
  return DIAGRAM_NEUTRAL;
}

function edgeMarkerId(edge: DiagramEdge, ids: DiagramIds) {
  if (edge.accent) return ids.arrowAccent;
  if (edge.dim) return ids.arrowDim;
  return ids.arrowNeutral;
}

function edgeLabelFill(edge: DiagramEdge, themeAccent: string) {
  if (edge.accent) return themeAccent;
  if (edge.dim) return DIAGRAM_DIM;
  return DIAGRAM_TEXT;
}

export type SegmentKind = 'groups' | 'node' | 'edge';
export type LayoutSegment = {
  kind: SegmentKind;
  index: number;
  start: number;
  end: number;
};

export function buildSegments(
  nodeCount: number,
  edgeCount: number,
): LayoutSegment[] {
  const slotCount = 1 + nodeCount + edgeCount;
  const step = 1 / slotCount;
  let i = 0;
  const segments: LayoutSegment[] = [];
  segments.push({ kind: 'groups', index: 0, start: i * step, end: ++i * step });
  for (let n = 0; n < nodeCount; n++) {
    segments.push({
      kind: 'node',
      index: n,
      start: i * step,
      end: ++i * step,
    });
  }
  for (let e = 0; e < edgeCount; e++) {
    segments.push({
      kind: 'edge',
      index: e,
      start: i * step,
      end: ++i * step,
    });
  }
  return segments;
}

export function DiagramNodeIcon({
  icon,
  x,
  y,
  size,
  color,
}: {
  icon: DiagramNodeIconName;
  x: number;
  y: number;
  size: number;
  color: string;
}) {
  const common = {
    fill: 'none',
    stroke: color,
    strokeWidth: 4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg
      data-diagram-node-icon={icon}
      x={x}
      y={y}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      overflow="visible"
    >
      {icon === 'certificate' && (
        <>
          <path {...common} d="M18 8h28l8 8v40H18z" />
          <path {...common} d="M46 8v10h10" />
          <path {...common} d="M25 24h20" />
          <path {...common} d="M25 34h14" />
          <circle {...common} cx="42" cy="45" r="7" />
          <path {...common} d="M38 52l-3 8 7-4 7 4-3-8" />
        </>
      )}
      {icon === 'cloudflare' && (
        <>
          <path
            {...common}
            d="M20 46h29c6 0 10-4 10-10s-4-10-10-10h-2C44 16 36 10 27 12c-8 1-14 8-14 17-6 1-10 5-10 11 0 4 3 6 8 6h9"
          />
          <path {...common} d="M21 36h28" />
          <path {...common} d="M28 27h17" />
        </>
      )}
      {icon === 'dashboard' && (
        <>
          <rect {...common} x="8" y="12" width="48" height="40" rx="6" />
          <path {...common} d="M16 24h10v10H16z" />
          <path {...common} d="M36 24h12" />
          <path {...common} d="M36 34h8" />
          <path {...common} d="M16 44h32" />
        </>
      )}
      {icon === 'file' && (
        <>
          <path {...common} d="M18 8h20l12 12v36H18z" />
          <path {...common} d="M38 8v14h14" />
          <path {...common} d="M25 34h20" />
          <path {...common} d="M25 44h14" />
        </>
      )}
      {icon === 'git' && (
        <>
          <path {...common} d="M32 6l26 26-26 26L6 32z" />
          <circle {...common} cx="23" cy="23" r="4" />
          <circle {...common} cx="41" cy="41" r="4" />
          <circle {...common} cx="41" cy="23" r="4" />
          <path {...common} d="M27 23h10" />
          <path {...common} d="M26 26l12 12" />
        </>
      )}
      {icon === 'gpu' && (
        <>
          <rect {...common} x="14" y="18" width="36" height="28" rx="4" />
          <rect {...common} x="24" y="26" width="16" height="12" rx="2" />
          <path {...common} d="M8 24h6M8 32h6M8 40h6M50 24h6M50 32h6M50 40h6" />
          <path
            {...common}
            d="M22 12v6M32 12v6M42 12v6M22 46v6M32 46v6M42 46v6"
          />
        </>
      )}
      {icon === 'user' && (
        <>
          <rect {...common} x="10" y="8" width="44" height="48" rx="8" />
          <circle {...common} cx="32" cy="25" r="9" />
          <path {...common} d="M17 53c3-11 9-16 15-16s12 5 15 16" />
        </>
      )}
      {icon === 'brain' && (
        <>
          <path
            {...common}
            d="M25 11c-8 0-13 5-13 12-5 2-8 7-8 13 0 8 6 14 14 14 2 5 7 8 13 8V11z"
          />
          <path
            {...common}
            d="M39 11c8 0 13 5 13 12 5 2 8 7 8 13 0 8-6 14-14 14-2 5-7 8-13 8V11z"
          />
          <path {...common} d="M18 25c4 0 7-2 9-5" />
          <path {...common} d="M46 25c-4 0-7-2-9-5" />
          <path {...common} d="M16 39c5-1 9 1 12 5" />
          <path {...common} d="M48 39c-5-1-9 1-12 5" />
        </>
      )}
      {icon === 'internet' && (
        <>
          <circle {...common} cx="32" cy="32" r="24" />
          <path {...common} d="M8 32h48" />
          <path {...common} d="M32 8c8 7 12 15 12 24s-4 17-12 24" />
          <path {...common} d="M32 8c-8 7-12 15-12 24s4 17 12 24" />
          <path {...common} d="M15 20h34M15 44h34" />
        </>
      )}
      {icon === 'istio' && (
        <>
          <path {...common} d="M14 54L32 8l18 46z" />
          <path {...common} d="M32 8v46" />
          <path {...common} d="M22 38h20" />
        </>
      )}
      {icon === 'kubernetes' && (
        <>
          <path {...common} d="M32 6l22 13v26L32 58 10 45V19z" />
          <circle {...common} cx="32" cy="32" r="9" />
          <path
            {...common}
            d="M32 14v9M32 41v9M16 23l8 5M40 36l8 5M48 23l-8 5M24 36l-8 5"
          />
        </>
      )}
      {icon === 'logs' && (
        <>
          <rect {...common} x="12" y="10" width="40" height="44" rx="5" />
          <path {...common} d="M20 23h24M20 32h24M20 41h16" />
          <path {...common} d="M20 14v8" />
        </>
      )}
      {icon === 'metrics' && (
        <>
          <path {...common} d="M10 52h44" />
          <path {...common} d="M18 52V34M32 52V20M46 52V28" />
          <path {...common} d="M14 28l13-10 10 9 13-15" />
        </>
      )}
      {icon === 'router' && (
        <>
          <rect {...common} x="10" y="30" width="44" height="16" rx="3" />
          <path {...common} d="M20 30l-6-16M44 30l6-16" />
          <path {...common} d="M20 38h2M29 38h2M38 38h2M47 38h2" />
          <path {...common} d="M16 52h32" />
        </>
      )}
      {icon === 'server' && (
        <>
          <rect {...common} x="12" y="10" width="40" height="14" rx="3" />
          <rect {...common} x="12" y="28" width="40" height="14" rx="3" />
          <rect {...common} x="12" y="46" width="40" height="8" rx="3" />
          <path {...common} d="M20 17h2M20 35h2M44 17h1M44 35h1" />
        </>
      )}
      {icon === 'shield' && (
        <>
          <path
            {...common}
            d="M32 6l22 9v15c0 14-8 23-22 28C18 53 10 44 10 30V15z"
          />
          <path {...common} d="M22 32l7 7 14-16" />
        </>
      )}
      {icon === 'storage' && (
        <>
          <ellipse {...common} cx="32" cy="16" rx="20" ry="8" />
          <path {...common} d="M12 16v30c0 4 9 8 20 8s20-4 20-8V16" />
          <path {...common} d="M12 31c0 4 9 8 20 8s20-4 20-8" />
        </>
      )}
      {icon === 'trace' && (
        <>
          <circle {...common} cx="14" cy="32" r="6" />
          <circle {...common} cx="32" cy="16" r="6" />
          <circle {...common} cx="50" cy="32" r="6" />
          <circle {...common} cx="32" cy="48" r="6" />
          <path {...common} d="M19 28l8-8M37 20l8 8M45 36l-8 8M27 44l-8-8" />
        </>
      )}
      {icon === 'tunnel' && (
        <>
          <circle {...common} cx="22" cy="32" r="14" />
          <circle {...common} cx="42" cy="32" r="14" />
          <path {...common} d="M8 32h48" />
          <path {...common} d="M22 18c7 7 7 21 0 28" />
          <path {...common} d="M42 18c-7 7-7 21 0 28" />
        </>
      )}
      {icon === 'eye' && (
        <>
          <path
            {...common}
            d="M6 32c7-12 16-18 26-18s19 6 26 18c-7 12-16 18-26 18S13 44 6 32z"
          />
          <circle {...common} cx="32" cy="32" r="9" />
        </>
      )}
      {icon === 'eye-off' && (
        <>
          <path {...common} d="M8 32c5-9 12-15 20-17" />
          <path {...common} d="M38 15c7 2 13 8 18 17-3 6-8 11-13 14" />
          <path {...common} d="M20 43c4 4 8 6 12 6 4 0 8-1 12-4" />
          <path {...common} d="M14 10l36 44" />
          <path {...common} d="M27 27c-2 4-1 9 3 11 3 2 8 1 10-2" />
        </>
      )}
      {icon === 'ellipsis' && (
        <>
          <circle cx="16" cy="32" r="4.8" fill={color} />
          <circle cx="32" cy="32" r="4.8" fill={color} />
          <circle cx="48" cy="32" r="4.8" fill={color} />
        </>
      )}
    </svg>
  );
}

export function GroupRect({
  layout,
  progress,
  start,
  end,
}: {
  layout: GroupLayout;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent, ids } = useDiagramTheme();
  const opacity = useTransform(progress, [start, end], [0, 1], {
    clamp: true,
  });
  const { group, rect: box, band, separator, label } = layout;
  const frame = group.frame ?? 'solid';
  const fill = group.fill ?? 'surface';
  const stroke = accentToneStroke(group, themeAccent, DIAGRAM_NEUTRAL);
  const dasharray = frame === 'dashed' ? '6 6' : undefined;
  const hasFrame = frame !== 'none';
  const hasFill = fill !== 'none';
  const surfaceFill =
    hasFill && group.tone ? resolveDiagramToneFill(group.tone) : DIAGRAM_BG;
  const texture = group.texture ?? (hasFill ? 'dots' : 'none');
  const texturePattern = hasFill ? textureFill(texture, ids) : null;
  const [firstLabel] = label;
  return (
    <motion.g style={{ opacity }}>
      <rect
        data-diagram-group={group.id}
        data-diagram-group-tone={group.tone}
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={GROUP_RADIUS}
        fill={hasFill ? surfaceFill : 'none'}
        stroke={hasFrame ? stroke : 'none'}
        strokeWidth={hasFrame ? 1 : 0}
        strokeDasharray={dasharray}
      />
      {texturePattern && (
        <rect
          data-diagram-group-texture={`${group.id}:${texture}`}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={GROUP_RADIUS}
          fill={texturePattern}
          pointerEvents="none"
        />
      )}
      {band && (
        <rect
          data-diagram-group-title-band={group.id}
          x={band.x}
          y={band.y}
          width={band.w}
          height={band.h}
          fill={hasFill ? surfaceFill : DIAGRAM_BG}
          pointerEvents="none"
        />
      )}
      {separator && (
        <line
          data-diagram-group-title-separator={group.id}
          x1={separator[0].x}
          y1={separator[0].y}
          x2={separator[1].x}
          y2={separator[1].y}
          stroke={stroke}
          strokeWidth={1}
          strokeDasharray={dasharray}
        />
      )}
      {layout.dividers.map(([from, to], i) => (
        <line
          key={i}
          x1={from.x}
          y1={from.y}
          x2={to.x}
          y2={to.y}
          stroke={group.accent ? themeAccent : DIAGRAM_NEUTRAL}
          strokeWidth={1}
          strokeDasharray={dasharray}
          data-diagram-group-divider={`${group.id}:${i}`}
        />
      ))}
      {firstLabel && (
        <text
          data-diagram-group-label={group.id}
          x={firstLabel.x}
          y={firstLabel.y}
          textAnchor={firstLabel.anchor}
          fontFamily={FONT_FAMILY[firstLabel.font.face]}
          fontSize={firstLabel.font.size}
          fontWeight={firstLabel.font.weight}
          fill={DIAGRAM_TEXT}
        >
          <RunSpans runs={label} />
        </text>
      )}
      <PortMarkers
        ownerId={group.id}
        ports={layout.ports}
        declared={group.ports}
      />
    </motion.g>
  );
}

export function EdgeStroke({
  d,
  edge,
  progress,
  start,
  end,
}: {
  d: string;
  edge: DiagramEdge;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent, ids } = useDiagramTheme();
  const stroke = edgeStroke(edge, themeAccent);
  const markerId = edgeMarkerId(edge, ids);
  const direction = edge.headless ? 'none' : (edge.direction ?? 'forward');
  const markerUrl = `url(#${markerId})`;
  const strokeWidth = EDGE_STROKE_WIDTH[edge.weight ?? 'regular'];
  const dasharray = edgeDasharray(edge);

  const drawEnd = start + (end - start) * 0.85;
  const pathLength = useTransform(progress, [start, drawEnd], [0, 1], {
    clamp: true,
  });
  const pathOpacity = useTransform(progress, [start, start + 0.001], [0, 1], {
    clamp: true,
  });

  return (
    <motion.path
      data-diagram-edge={`${edge.from}->${edge.to}`}
      data-diagram-edge-channel={edge.channel}
      data-diagram-edge-line-style={edge.lineStyle}
      data-diagram-edge-direction={direction}
      data-diagram-edge-layer={edge.layer ?? 'foreground'}
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeDasharray={dasharray}
      strokeLinejoin="round"
      strokeLinecap="round"
      markerStart={direction === 'both' ? markerUrl : undefined}
      markerEnd={
        direction === 'forward' || direction === 'both' ? markerUrl : undefined
      }
      style={
        dasharray
          ? { opacity: pathOpacity }
          : { pathLength, opacity: pathOpacity }
      }
    />
  );
}

export function EdgeOverlay({
  layout,
  progress,
  start,
  end,
}: {
  layout: EdgeLayout;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  const { edge, label, badge } = layout;
  const labelFill = edgeLabelFill(edge, themeAccent);
  const drawEnd = start + (end - start) * 0.85;
  const labelOpacity = useTransform(progress, [drawEnd, end], [0, 1], {
    clamp: true,
  });

  return (
    <>
      {label && (
        <EdgeLabel
          edge={edge}
          label={label}
          fill={labelFill}
          opacity={labelOpacity}
        />
      )}
      {badge && (
        <EdgeBadge
          edge={edge}
          badge={badge}
          fill={labelFill}
          opacity={labelOpacity}
        />
      )}
    </>
  );
}

function EdgeLabel({
  edge,
  label,
  fill,
  opacity,
}: {
  edge: DiagramEdge;
  label: NonNullable<EdgeLayout['label']>;
  fill: string;
  opacity: MotionValue<number>;
}) {
  const { box } = label;
  const [first] = label.text;
  if (!first) return null;

  return (
    <motion.g style={{ opacity }}>
      {edge.labelFrame && (
        <rect
          data-diagram-edge-label-frame={`${edge.from}->${edge.to}`}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={box.h / 2}
          fill={DIAGRAM_BG}
          stroke={fill}
          strokeWidth={0.75}
        />
      )}
      <text
        data-diagram-edge-label={`${edge.from}->${edge.to}`}
        x={first.x}
        y={first.y}
        textAnchor={first.anchor}
        fontFamily={FONT_FAMILY[first.font.face]}
        fontSize={first.font.size}
        fill={fill}
      >
        <RunSpans runs={label.text} />
      </text>
    </motion.g>
  );
}

function EdgeBadge({
  edge,
  badge,
  fill,
  opacity,
}: {
  edge: DiagramEdge;
  badge: NonNullable<EdgeLayout['badge']>;
  fill: string;
  opacity: MotionValue<number>;
}) {
  const { box, icon, text } = badge;
  const [first] = text;

  return (
    <motion.g
      data-diagram-edge-badge={`${edge.from}->${edge.to}`}
      style={{ opacity }}
    >
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={10}
        fill={DIAGRAM_BG}
        stroke={fill}
        strokeWidth={1}
      />
      {edge.badgeIcon && icon && (
        <DiagramNodeIcon
          icon={edge.badgeIcon}
          x={icon.x}
          y={icon.y}
          size={icon.w}
          color={fill}
        />
      )}
      {first && (
        <text
          x={first.x}
          y={first.y}
          textAnchor={first.anchor}
          fontFamily={FONT_FAMILY[first.font.face]}
          fontSize={first.font.size}
          fontWeight={first.font.weight}
          fill={fill}
        >
          <RunSpans runs={text} />
        </text>
      )}
    </motion.g>
  );
}

export function PortMarkers({
  ownerId,
  ports,
  declared,
}: {
  ownerId: string;
  ports: PortLayout[];
  declared: DiagramNodePort[] | undefined;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  if (ports.length === 0) return null;
  return (
    <>
      {ports.map((port) => {
        const accent = declared?.find(({ id }) => id === port.id)?.accent;
        const stroke = accent ? themeAccent : DIAGRAM_NEUTRAL;
        const fill = accent ? themeAccent : DIAGRAM_BG;
        return (
          <g
            key={port.id}
            data-diagram-port={`${ownerId}:${port.id}`}
            data-diagram-port-side={port.side}
          >
            <circle
              cx={port.point.x}
              cy={port.point.y}
              r={4}
              fill={fill}
              stroke={stroke}
              strokeWidth={1.5}
            />
            {port.label && (
              <text
                x={port.label.x}
                y={port.label.y}
                textAnchor={port.label.anchor}
                fontFamily={FONT_FAMILY[port.label.font.face]}
                fontSize={port.label.font.size}
                fontWeight={port.label.font.weight}
                fill={stroke}
              >
                {port.label.text}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}
