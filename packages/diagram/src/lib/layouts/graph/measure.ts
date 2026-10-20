import type {
  Box,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  DiagramNodePort,
  DiagramSide,
} from '../../model/diagram-ir.ts';
import type { NodeLayout, TextRun } from './graph-layout-result.ts';
import { nodeContent } from './node-content.ts';
import { type TextBlock, labelLines, textBlock } from './text-block.ts';
import type { LayoutTokens } from './tokens.ts';

type Sides = Record<DiagramSide, number>;

export type MeasuredNode = {
  /** The smallest frame that holds the node's content. */
  frame: { w: number; h: number };
  /** How far the stacked frames and the caption reach outside the frame. */
  overhang: Sides;
  /** Whether the frame grows to fill its grid area. */
  stretch: boolean;
  /** Positions everything the node draws, given its final frame (at least `frame`). */
  place(box: Box): Omit<NodeLayout, 'node'>;
};

/** The distance from a port's point to its label: the port marker's radius plus a gap. */
const PORT_LABEL_OFFSET = 8;
const EDGE_LABEL_FRAME_PAD = 4;
/** Mirrors the badge drawn before content sizing: 8px side inset, 6px above and below, 24px content at least. */
const BADGE_PAD = { x: 8, y: 6 };
const BADGE_MIN_CONTENT = 24;

const SIDES: DiagramSide[] = ['top', 'right', 'bottom', 'left'];

export function measureNode(
  node: DiagramNode,
  tokens: LayoutTokens,
): MeasuredNode {
  const kind = node.kind ?? 'node';
  if (node.hidden && kind === 'node') return hiddenNode();

  const content = nodeContent(node, tokens);
  const ports = portGeometry(node.ports ?? [], tokens);
  const w = Math.max(
    content.w + 2 * content.pad.x + ports.inset.left + ports.inset.right,
    ports.minLength.top,
    ports.minLength.bottom,
  );
  const h = Math.max(
    content.h + 2 * content.pad.y + ports.inset.top + ports.inset.bottom,
    ports.minLength.left,
    ports.minLength.right,
  );

  const place = (box: Box): Omit<NodeLayout, 'node'> => {
    const inner = inset(inset(box, ports.inset), {
      top: content.pad.y,
      bottom: content.pad.y,
      left: content.pad.x,
      right: content.pad.x,
    });
    const frames = stackFrames(node, box, tokens);
    const caption = placeCaption(node, union([box, ...frames]), tokens);
    return {
      box,
      visual: union([box, ...frames, ...(caption ? [caption.box] : [])]),
      frames,
      radius: frameRadius(node, box, tokens),
      ...content.place(inner),
      ...(caption ? { caption } : {}),
      ports: ports.place(box),
    };
  };

  const { visual } = place({ x: 0, y: 0, w, h });
  return {
    frame: { w, h },
    overhang: {
      top: 0 - visual.y,
      left: 0 - visual.x,
      bottom: visual.y + visual.h - h,
      right: visual.x + visual.w - w,
    },
    stretch: kind === 'node' && (node.stretch ?? true),
    place,
  };
}

function hiddenNode(): MeasuredNode {
  return {
    frame: { w: 0, h: 0 },
    overhang: { top: 0, right: 0, bottom: 0, left: 0 },
    stretch: false,
    place: (box) => ({
      box,
      visual: box,
      frames: [],
      radius: 0,
      text: [],
      bullets: [],
      ports: [],
    }),
  };
}

function frameRadius(
  node: DiagramNode,
  box: Box,
  tokens: LayoutTokens,
): number {
  switch (node.kind) {
    case 'connector':
      return box.h / 2;
    case 'junction':
      return Math.min(box.w, box.h) / 2;
    case 'marker':
    case 'appliance':
    case 'note':
      return 0;
    default:
      if (node.frame === 'none') return 0;
      return node.frame === 'flat' ? tokens.FLAT_RADIUS : tokens.RADIUS;
  }
}

/**
 * Ports sit evenly along their side, with their labels inside the frame. A
 * side's labels push the content inward, and a side with k ports is long
 * enough for k + 1 port spacings.
 */
function portGeometry(ports: DiagramNodePort[], tokens: LayoutTokens) {
  const font = tokens.fonts.portLabel;
  const bySide = new Map(
    SIDES.map((side) => [
      side,
      ports
        .filter((port) => port.side === side)
        .map((port) => ({
          port,
          label: port.label
            ? textBlock(
                labelLines(port.label, port.accent ? 'accent' : undefined),
                font,
              )
            : undefined,
        })),
    ]),
  );
  const widest = (side: DiagramSide) =>
    Math.max(0, ...bySide.get(side)!.map(({ label }) => label?.w ?? 0));
  const tallest = (side: DiagramSide) =>
    Math.max(0, ...bySide.get(side)!.map(({ label }) => label?.h ?? 0));
  const labelDepth = (side: DiagramSide) => {
    const depth =
      side === 'left' || side === 'right' ? widest(side) : tallest(side);
    return depth > 0 ? PORT_LABEL_OFFSET + depth : 0;
  };
  const sideLength = (side: DiagramSide) => {
    const count = bySide.get(side)!.length;
    if (count === 0) return 0;
    const labelLength =
      side === 'top' || side === 'bottom' ? widest(side) : tallest(side);
    const pitch = Math.max(tokens.PORT_SPACING, labelLength + tokens.LABEL_GAP);
    return (count + 1) * pitch;
  };

  return {
    inset: sidesOf(labelDepth),
    minLength: sidesOf(sideLength),
    place: (box: Box): NodeLayout['ports'] =>
      SIDES.flatMap((side) => {
        const onSide = bySide.get(side)!;
        return onSide.map(({ port, label }, index) => {
          const fraction = (index + 1) / (onSide.length + 1);
          const point = portPoint(box, side, fraction);
          const run = label && placePortLabel(label, point, side)[0];
          return {
            id: port.id,
            side,
            point,
            ...(run ? { label: run } : {}),
          };
        });
      }),
  };
}

/** The point `fraction` of the way along `side` of `box`. */
function portPoint(
  box: Box,
  side: DiagramSide,
  fraction: number,
): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: box.x + box.w * fraction, y: box.y };
    case 'bottom':
      return { x: box.x + box.w * fraction, y: box.y + box.h };
    case 'left':
      return { x: box.x, y: box.y + box.h * fraction };
    case 'right':
      return { x: box.x + box.w, y: box.y + box.h * fraction };
  }
}

function placePortLabel(
  label: TextBlock,
  point: { x: number; y: number },
  side: DiagramSide,
): TextRun[] {
  switch (side) {
    case 'left':
      return label.place(
        point.x + PORT_LABEL_OFFSET,
        point.y - label.h / 2,
        'start',
      );
    case 'right':
      return label.place(
        point.x - PORT_LABEL_OFFSET,
        point.y - label.h / 2,
        'end',
      );
    case 'top':
      return label.place(point.x, point.y + PORT_LABEL_OFFSET, 'middle');
    case 'bottom':
      return label.place(
        point.x,
        point.y - PORT_LABEL_OFFSET - label.h,
        'middle',
      );
  }
}

/** The back frames of a stack, farthest first, each one STACK_STEP further in the stack direction. */
function stackFrames(node: DiagramNode, box: Box, tokens: LayoutTokens): Box[] {
  const count = Math.max(1, Math.floor(node.stack ?? 1));
  const kind = node.kind ?? 'node';
  if (count === 1 || kind !== 'node' || node.frame === 'none') return [];
  const direction = node.stackDirection ?? 'up-left';
  const dx = (direction.endsWith('left') ? -1 : 1) * tokens.STACK_STEP.x;
  const dy = (direction.startsWith('up') ? -1 : 1) * tokens.STACK_STEP.y;
  return Array.from({ length: count - 1 }, (_, index) => {
    const level = count - 1 - index;
    return { ...box, x: box.x + level * dx, y: box.y + level * dy };
  });
}

/** The caption sits beside `box`, the frame together with its stacked back frames. */
function placeCaption(
  node: DiagramNode,
  box: Box,
  tokens: LayoutTokens,
): NodeLayout['caption'] {
  const font = tokens.fonts.caption;
  const lines = textBlock(
    labelLines(
      [node.caption ?? []].flat().map((line) => line.trim()),
      node.captionColor,
    ),
    font,
  );
  if (lines.h === 0) return undefined;
  const framed = node.captionFrame ?? false;
  const pad = framed
    ? { x: 0.9 * font.size, y: 0.55 * font.size }
    : { x: 0, y: 0 };
  const w = lines.w + 2 * pad.x;
  const h = lines.h + 2 * pad.y;
  const gap = tokens.CAPTION_GAP;
  const side = node.captionSide ?? 'bottom';
  const centreX = box.x + (box.w - w) / 2;
  const centreY = box.y + (box.h - h) / 2;
  const captionBox: Box = {
    top: { x: centreX, y: box.y - gap - h, w, h },
    bottom: { x: centreX, y: box.y + box.h + gap, w, h },
    left: { x: box.x - gap - w, y: centreY, w, h },
    right: { x: box.x + box.w + gap, y: centreY, w, h },
  }[side];
  const top = captionBox.y + pad.y;
  let text: TextRun[];
  if (side === 'left') {
    text = lines.place(captionBox.x + w - pad.x, top, 'end');
  } else if (side === 'right') {
    text = lines.place(captionBox.x + pad.x, top, 'start');
  } else {
    text = lines.place(captionBox.x + w / 2, top, 'middle');
  }
  return { box: captionBox, framed, text };
}

export type MeasuredGroupTitle = {
  /** The height the title reserves on its side, BAND_PAD above and below included; 0 without a label. */
  height: number;
  place(rect: Box): { band?: Box; label: TextRun[] };
};

export function measureGroupTitle(
  group: DiagramGroup,
  tokens: LayoutTokens,
): MeasuredGroupTitle {
  const lines = textBlock(labelLines(group.label), tokens.fonts.groupLabel);
  const height = lines.h > 0 ? lines.h + 2 * tokens.BAND_PAD : 0;
  return {
    height,
    place(rect) {
      if (height === 0) return { label: [] };
      const y =
        group.labelSide === 'bottom' ? rect.y + rect.h - height : rect.y;
      const top = y + tokens.BAND_PAD;
      const align = group.labelAlign ?? 'center';
      let label: TextRun[];
      if (align === 'start') {
        label = lines.place(rect.x + tokens.PAD_X, top, 'start');
      } else if (align === 'end') {
        label = lines.place(rect.x + rect.w - tokens.PAD_X, top, 'end');
      } else {
        label = lines.place(rect.x + rect.w / 2, top, 'middle');
      }
      return group.titleBand
        ? { band: { x: rect.x, y, w: rect.w, h: height }, label }
        : { label };
    },
  };
}

export type MeasuredEdgeLabel = {
  w: number;
  h: number;
  place(box: Box): TextRun[];
};

export function measureEdgeLabel(
  edge: DiagramEdge,
  tokens: LayoutTokens,
): MeasuredEdgeLabel {
  const lines = textBlock(labelLines(edge.label), tokens.fonts.edgeLabel);
  const pad = edge.labelFrame ? EDGE_LABEL_FRAME_PAD : 0;
  return {
    w: lines.w + 2 * pad,
    h: lines.h + 2 * pad,
    place: (box) => lines.place(box.x + box.w / 2, box.y + pad, 'middle'),
  };
}

export type MeasuredEdgeBadge = {
  w: number;
  h: number;
  place(box: Box): { icon?: Box; text: TextRun[] };
};

export function measureEdgeBadge(
  edge: DiagramEdge,
  tokens: LayoutTokens,
): MeasuredEdgeBadge {
  const lines = textBlock(labelLines(edge.badgeLabel), tokens.fonts.badge);
  const icon = edge.badgeIcon ? tokens.BADGE_ICON : 0;
  const gap = icon > 0 && lines.w > 0 ? tokens.BLOCK_GAP : 0;
  const rowW = icon + gap + lines.w;
  return {
    w: Math.max(BADGE_MIN_CONTENT, rowW) + 2 * BADGE_PAD.x,
    h: Math.max(BADGE_MIN_CONTENT, lines.h) + 2 * BADGE_PAD.y,
    place(box) {
      const x = box.x + (box.w - rowW) / 2;
      const cy = box.y + box.h / 2;
      const text = lines.place(x + icon + gap, cy - lines.h / 2, 'start');
      return icon > 0
        ? { icon: { x, y: cy - icon / 2, w: icon, h: icon }, text }
        : { text };
    },
  };
}

function sidesOf(value: (side: DiagramSide) => number): Sides {
  return {
    top: value('top'),
    right: value('right'),
    bottom: value('bottom'),
    left: value('left'),
  };
}

function inset(box: Box, by: Sides): Box {
  return {
    x: box.x + by.left,
    y: box.y + by.top,
    w: box.w - by.left - by.right,
    h: box.h - by.top - by.bottom,
  };
}

function union(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}
