import type { Box, DiagramNode, Point } from '../../model/diagram-ir.ts';
import type { NodeLayout } from './graph-layout-result.ts';
import { labelLines, textBlock } from './text-block.ts';
import type { LayoutTokens } from './tokens.ts';

export type ContentPlacement = Pick<NodeLayout, 'text' | 'bullets'> &
  Partial<Pick<NodeLayout, 'icon' | 'appliance'>>;

/** What a node draws inside its frame: its measured size, the padding around it, and where it goes. */
export type NodeContent = {
  w: number;
  h: number;
  pad: { x: number; y: number };
  place(inner: Box): ContentPlacement;
};

/** Mirrors the connector pill drawn before content sizing: 10px side inset, 4px above and below the text, 28px tall at least. */
const CONNECTOR_PAD = { x: 10, y: 4 };
const CONNECTOR_MIN_HEIGHT = 28;

const NOTHING: ContentPlacement = { text: [], bullets: [] };

export function nodeContent(
  node: DiagramNode,
  tokens: LayoutTokens,
): NodeContent {
  switch (node.kind) {
    case 'junction':
      return junctionContent(tokens);
    case 'marker':
      return markerContent(node, tokens);
    case 'connector':
      return connectorContent(node, tokens);
    case 'appliance':
      return applianceContent(node, tokens);
    case 'note':
      return noteContent(node, tokens);
    default:
      return boxContent(node, tokens);
  }
}

function boxContent(node: DiagramNode, tokens: LayoutTokens): NodeContent {
  const pad =
    node.frame === 'none'
      ? { x: tokens.LABEL_GAP, y: tokens.LABEL_GAP }
      : { x: tokens.PAD_X, y: tokens.PAD_Y };
  const isCard =
    node.textAlign === 'start' ||
    node.description !== undefined ||
    (node.items?.length ?? 0) > 0;
  if (isCard) return { ...cardContent(node, tokens), pad };
  if (node.icon) return { ...iconRowContent(node, tokens), pad };
  const lines = textBlock(
    labelLines(node.label, node.textColor),
    tokens.fonts.boxLabel,
  );
  return {
    w: lines.w,
    h: lines.h,
    pad,
    place: (inner) => ({
      text: lines.place(centreX(inner), centredTop(inner, lines.h), 'middle'),
      bullets: [],
    }),
  };
}

function iconRowContent(
  node: DiagramNode,
  tokens: LayoutTokens,
): Omit<NodeContent, 'pad'> {
  const { ICON, ICON_GAP } = tokens;
  const title = textBlock(
    labelLines(node.label, node.textColor),
    tokens.fonts.title,
  );
  const w = title.w > 0 ? ICON + ICON_GAP + title.w : ICON;
  const h = Math.max(ICON, title.h);
  return {
    w,
    h,
    place: (inner) => {
      const x = inner.x + (inner.w - w) / 2;
      const y = centredTop(inner, h);
      return {
        icon: { x, y: y + (h - ICON) / 2, size: ICON },
        text: title.place(x + ICON + ICON_GAP, y + (h - title.h) / 2, 'start'),
        bullets: [],
      };
    },
  };
}

function cardContent(
  node: DiagramNode,
  tokens: LayoutTokens,
): Omit<NodeContent, 'pad'> {
  const { ICON, ICON_GAP, BLOCK_GAP, BULLET_INDENT } = tokens;
  const title = textBlock(
    labelLines(node.label, node.textColor),
    tokens.fonts.title,
  );
  const description = textBlock(
    labelLines(node.description, node.textColor),
    tokens.fonts.body,
  );
  const items = textBlock(
    labelLines(node.items, node.textColor),
    tokens.fonts.body,
  );
  let iconW = 0;
  if (node.icon) iconW = title.w > 0 ? ICON + ICON_GAP : ICON;
  const headerH = Math.max(node.icon ? ICON : 0, title.h);
  const sections = [
    { h: headerH, w: iconW + title.w },
    { h: description.h, w: description.w },
    { h: items.h, w: items.h > 0 ? BULLET_INDENT + items.w : 0 },
  ].filter((section) => section.h > 0);
  const bulletRise = tokens.fonts.body.size * 0.3;
  return {
    w: Math.max(0, ...sections.map((section) => section.w)),
    h:
      sections.reduce((sum, section) => sum + section.h, 0) +
      Math.max(0, sections.length - 1) * BLOCK_GAP,
    place: (inner) => {
      let top = inner.y;
      const next = (h: number) => {
        const at = top;
        if (h > 0) top += h + BLOCK_GAP;
        return at;
      };
      const headerTop = next(headerH);
      const descriptionTop = next(description.h);
      const itemsTop = next(items.h);
      const itemRuns = items.place(inner.x + BULLET_INDENT, itemsTop, 'start');
      return {
        ...(node.icon
          ? {
              icon: {
                x: inner.x,
                y: headerTop + (headerH - ICON) / 2,
                size: ICON,
              },
            }
          : {}),
        text: [
          ...title.place(
            inner.x + iconW,
            headerTop + (headerH - title.h) / 2,
            'start',
          ),
          ...description.place(inner.x, descriptionTop, 'start'),
          ...itemRuns,
        ],
        bullets: itemRuns.map((run) => ({
          x: inner.x + BULLET_INDENT / 4,
          y: run.y - bulletRise,
        })),
      };
    },
  };
}

function noteContent(node: DiagramNode, tokens: LayoutTokens): NodeContent {
  const lines = textBlock(
    labelLines(node.label, node.textColor ?? 'dim'),
    tokens.fonts.note,
  );
  return {
    w: lines.w,
    h: lines.h,
    pad: { x: tokens.LABEL_GAP, y: tokens.LABEL_GAP },
    place: (inner) => ({
      text: lines.place(inner.x, inner.y, 'start'),
      bullets: [],
    }),
  };
}

function markerContent(node: DiagramNode, tokens: LayoutTokens): NodeContent {
  const { MARKER_ICON, BLOCK_GAP } = tokens;
  const lines = textBlock(
    labelLines(node.label, node.textColor),
    tokens.fonts.marker,
  );
  const gap = lines.h > 0 ? BLOCK_GAP : 0;
  const h = MARKER_ICON + gap + lines.h;
  return {
    w: Math.max(MARKER_ICON, lines.w),
    h,
    pad: { x: tokens.LABEL_GAP, y: tokens.LABEL_GAP },
    place: (inner) => {
      const top = centredTop(inner, h);
      const cx = centreX(inner);
      return {
        icon: { x: cx - MARKER_ICON / 2, y: top, size: MARKER_ICON },
        text: lines.place(cx, top + MARKER_ICON + gap, 'middle'),
        bullets: [],
      };
    },
  };
}

function connectorContent(
  node: DiagramNode,
  tokens: LayoutTokens,
): NodeContent {
  const { CONNECTOR_ICON, BLOCK_GAP } = tokens;
  const lines = textBlock(
    labelLines(node.label, node.textColor),
    tokens.fonts.connector,
  );
  const iconW = node.icon ? CONNECTOR_ICON + (lines.w > 0 ? BLOCK_GAP : 0) : 0;
  const h = Math.max(CONNECTOR_MIN_HEIGHT - 2 * CONNECTOR_PAD.y, lines.h);
  return {
    w: iconW + lines.w,
    h,
    pad: CONNECTOR_PAD,
    place: (inner) => {
      const cy = inner.y + inner.h / 2;
      const top = cy - lines.h / 2;
      if (!node.icon) {
        return {
          text: lines.place(centreX(inner), top, 'middle'),
          bullets: [],
        };
      }
      return {
        icon: { x: inner.x, y: cy - CONNECTOR_ICON / 2, size: CONNECTOR_ICON },
        text: lines.place(inner.x + iconW, top, 'start'),
        bullets: [],
      };
    },
  };
}

function junctionContent(tokens: LayoutTokens): NodeContent {
  return {
    w: tokens.JUNCTION,
    h: tokens.JUNCTION,
    pad: { x: 0, y: 0 },
    place: () => NOTHING,
  };
}

function applianceContent(
  node: DiagramNode,
  tokens: LayoutTokens,
): NodeContent {
  const { APPLIANCE, LABEL_GAP } = tokens;
  const lines = textBlock(
    labelLines(node.label, node.textColor),
    tokens.fonts.appliance,
  );
  return {
    w: Math.max(APPLIANCE.w, lines.w + 2 * LABEL_GAP),
    h: APPLIANCE.h + (lines.h > 0 ? lines.h + LABEL_GAP : 0),
    pad: { x: 0, y: 0 },
    place: (inner) => {
      const glyph = {
        x: centreX(inner) - APPLIANCE.w / 2,
        y: inner.y,
        ...APPLIANCE,
      };
      return {
        appliance: applianceGlyph(node, glyph),
        text: lines.place(centreX(inner), glyph.y + glyph.h, 'middle'),
        bullets: [],
      };
    },
  };
}

/** The router glyph: a slanted body, an optional antenna and a row of jacks, as the renderers drew it before content sizing. */
function applianceGlyph(
  node: DiagramNode,
  glyph: Box,
): NonNullable<NodeLayout['appliance']> {
  const bodyX = glyph.x + 4;
  const bodyY = glyph.y + Math.max(12, Math.min(22, glyph.h * 0.28));
  const bodyW = glyph.w - 8;
  const bodyH = glyph.h - (bodyY - glyph.y) - 12;
  const slant = Math.max(4, Math.min(16, bodyW * 0.28, bodyH * 0.75));
  const body: Point[] = [
    { x: bodyX + slant, y: bodyY },
    { x: bodyX + bodyW, y: bodyY + 6 },
    { x: bodyX + bodyW - slant, y: bodyY + bodyH },
    { x: bodyX, y: bodyY + bodyH - 6 },
  ];
  const mastX = bodyX + slant + bodyW * 0.2;
  const antenna: [Point, Point][] =
    (node.antenna ?? true)
      ? [
          [
            { x: bodyX + slant + bodyW * 0.18, y: bodyY + 1 },
            { x: mastX - 3, y: glyph.y + 3 },
          ],
          [
            { x: mastX + 1, y: bodyY + 2 },
            { x: mastX + 1, y: glyph.y + 8 },
          ],
        ]
      : [];
  const jackCount = Math.max(0, Math.floor(node.appliancePorts ?? 4));
  const jackSpacing = Math.min(
    13,
    Math.max(8, (bodyW - slant - 42) / Math.max(jackCount, 1)),
  );
  const jacks = Array.from({ length: jackCount }, (_, index) => ({
    x: bodyX + slant + 16 + index * jackSpacing,
    y: bodyY + bodyH - 15,
    w: 5,
    h: 12,
  }));
  const face: [Point, Point] = [
    { x: bodyX + slant, y: bodyY + bodyH - 1 },
    { x: bodyX + bodyW - slant, y: bodyY + bodyH + 3 },
  ];
  // Through a variable, not a literal, so the return skips the excess-property check against NodeLayout['appliance'].
  const parts = { body, face, antenna, jacks };
  return parts;
}

function centreX(box: Box): number {
  return box.x + box.w / 2;
}

function centredTop(box: Box, h: number): number {
  return box.y + (box.h - h) / 2;
}
