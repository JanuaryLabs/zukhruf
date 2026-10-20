// Temporary adapter: it builds one GraphLayout from the current engine in
// graph-layout.ts, so that the renderers paint only from a GraphLayout before
// the content-sized grid engine replaces it. Step 6 of the redesign deletes
// this file together with graph-layout.ts.
import { validateGraph } from '../../compiler/diagram-compile.ts';
import type {
  Box,
  DiagramGraphIR,
  DiagramGroup,
  DiagramLabelLine,
  DiagramNode,
  DiagramTextColor,
  GraphLayoutSpec,
  Point,
} from '../../model/diagram-ir.ts';
import { centeredBaselineOffset } from '../text-metrics.ts';
import type { Font, FontFace, FontWeight } from '../text/font.ts';
import { fontAscent, fontDescent, measureText } from '../text/measure-text.ts';
import type {
  EdgeLayout,
  GraphLayout,
  GroupLayout,
  LeaderLayout,
  NodeLayout,
  PortLayout,
  TextAnchor,
  TextRun,
} from './graph-layout-result.ts';
import {
  EDGE_BADGE_ICON,
  GROUP_LABEL_H,
  type PortPlacement,
  type ResolvedDiagramAnnotation,
  type RoutedEdge,
  computePaths,
  edgeBadgeSize,
  edgeLabelFontSize,
  edgeLabelFrameBox,
  edgeLabelLineHeight,
  graphContentViewBox,
  groupBox,
  groupDividerLines,
  groupLabelHeight,
  groupLabelLines,
  groupPortPlacements,
  groupTitleGutterHeight,
  nodeBox,
  nodeCaptionBounds,
  nodeCaptionPlacement,
  nodeFrameRadius,
  nodePortPlacements,
  nodeStackCount,
  nodeStackFrameBox,
  nodeVisualBox,
  resolveGraphAnnotations,
  resolveGraphLayout,
} from './graph-layout.ts';

/** The prefix of the id of the note node that stands for a free annotation. */
export const ANNOTATION_NOTE_PREFIX = 'annotation:';

export function legacyGraphLayout(ir: DiagramGraphIR): GraphLayout {
  validateGraph(ir);
  const graph = resolveGraphLayout(ir);
  const routedEdges = computePaths(graph);
  const notes = resolveGraphAnnotations(graph).map(noteLayout);
  return {
    nodes: [
      ...graph.nodes.map((node) =>
        nodeLayout(node, nodeBox(node, graph.layout)),
      ),
      ...notes.map(({ note }) => note),
    ],
    groups: (graph.groups ?? []).map((group) => groupLayout(group, graph)),
    edges: routedEdges.map(edgeLayout),
    leaders: notes.flatMap(({ leaders }) => leaders),
    viewBox: graphContentViewBox(graph, routedEdges),
  };
}

type Line = { text: string; color?: DiagramTextColor; weight: FontWeight };

const FONT_WEIGHTS: FontWeight[] = [400, 500, 600, 700];

function fontWeight(value: number): FontWeight {
  const weight = FONT_WEIGHTS.find((candidate) => candidate === value);
  if (weight === undefined) {
    throw new Error(
      `Diagram font weight ${value} has no metrics; use 400, 500, 600 or 700.`,
    );
  }
  return weight;
}

function labelLines(
  label: DiagramNode['label'],
  defaultWeight: number,
): Line[] {
  return (Array.isArray(label) ? label : [label]).map((line) =>
    labelLine(line, defaultWeight),
  );
}

function labelLine(line: DiagramLabelLine, defaultWeight: number): Line {
  if (typeof line === 'string') {
    return { text: line, weight: fontWeight(defaultWeight) };
  }
  return {
    text: line.text,
    weight: fontWeight(line.fontWeight ?? defaultWeight),
    ...(line.textColor ? { color: line.textColor } : {}),
  };
}

function plainLines(texts: string[], weight: number): Line[] {
  const resolved = fontWeight(weight);
  return texts.map((text) => ({ text, weight: resolved }));
}

function textRun(
  line: Line,
  x: number,
  y: number,
  anchor: TextAnchor,
  font: Font,
  letterSpacing = 0,
): TextRun {
  const w =
    measureText(line.text, font) + letterSpacing * [...line.text].length;
  const left = anchor === 'start' ? x : anchor === 'middle' ? x - w / 2 : x - w;
  const ascent = fontAscent(font);
  return {
    text: line.text,
    x,
    y,
    anchor,
    font,
    ...(line.color ? { color: line.color } : {}),
    bounds: { x: left, y: y - ascent, w, h: ascent + fontDescent(font) },
  };
}

function textBlock(
  lines: Line[],
  block: {
    x: number;
    y: number;
    lineHeight: number;
    anchor: TextAnchor;
    face: FontFace;
    size: number;
    letterSpacing?: number;
  },
): TextRun[] {
  return lines.map((line, index) =>
    textRun(
      line,
      block.x,
      block.y + index * block.lineHeight,
      block.anchor,
      { face: block.face, size: block.size, weight: line.weight },
      block.letterSpacing,
    ),
  );
}

function nonEmpty(lines: Line[]) {
  return lines.filter((line) => line.text.length > 0);
}

function unionBox(boxes: Box[]): Box {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

type NodeContent = Pick<NodeLayout, 'text'> &
  Partial<Pick<NodeLayout, 'icon' | 'bullets' | 'appliance'>> & {
    radius?: number;
  };

function nodeLayout(node: DiagramNode, box: Box): NodeLayout {
  const content = nodeContent(node, box);
  const captionLayout = nodeCaption(node, box);
  const frames =
    (node.frame ?? 'solid') === 'none'
      ? []
      : Array.from({ length: nodeStackCount(node) - 1 }, (_, i) =>
          nodeStackFrameBox(node, box, i + 1),
        );
  const stacked = nodeVisualBox(node, box);
  return {
    node,
    box,
    visual: captionLayout ? unionBox([stacked, captionLayout.box]) : stacked,
    frames,
    radius: content.radius ?? nodeFrameRadius(node),
    ...(content.icon ? { icon: content.icon } : {}),
    text: content.text,
    bullets: content.bullets ?? [],
    ...(captionLayout ? { caption: captionLayout } : {}),
    ports: nodePortPlacements(node, box).map(portLayout),
    ...(content.appliance ? { appliance: content.appliance } : {}),
  };
}

function nodeContent(node: DiagramNode, box: Box): NodeContent {
  if (node.kind === 'appliance') return applianceContent(node, box);
  if (node.kind === 'connector') return connectorContent(node, box);
  if (node.kind === 'marker') return markerContent(node, box);
  if (node.kind === 'junction') return junctionContent(node, box);
  const descriptionLines = [node.description ?? []].flat();
  const hasBodyLayout =
    (node.textAlign ?? 'center') === 'start' ||
    Boolean(node.icon) ||
    descriptionLines.length > 0;
  return hasBodyLayout
    ? cardContent(node, box, descriptionLines)
    : centredLabelContent(node, box);
}

function centredLabelContent(node: DiagramNode, box: Box): NodeContent {
  const lines = labelLines(node.label, node.fontWeight ?? 500);
  const fontSize = node.fontSize ?? 12;
  const lineHeight = Math.max(12, fontSize + 2);
  const centerY = box.y + box.h / 2;
  return {
    text: textBlock(lines, {
      x: box.x + box.w / 2,
      y:
        centerY -
        ((lines.length - 1) * lineHeight) / 2 +
        centeredBaselineOffset(fontSize, 'mono'),
      lineHeight,
      anchor: 'middle',
      face: 'mono',
      size: fontSize,
      letterSpacing: 0.6,
    }),
  };
}

function cardContent(
  node: DiagramNode,
  box: Box,
  descriptionLines: string[],
): NodeContent {
  const titleLines = labelLines(node.label, node.fontWeight ?? 700);
  const itemLines = node.items ?? [];
  const hasText = titleLines.some((line) => line.text.length > 0);
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
  const bodyLineHeight = bodySize + (node.bodyLineGap ?? 3);
  const itemY =
    bodyY +
    (descriptionLines.length > 0
      ? descriptionLines.length * bodyLineHeight + 6
      : 0);
  const body = {
    lineHeight: bodyLineHeight,
    anchor: 'start',
    face: 'sans',
    size: bodySize,
  } as const;
  const items = textBlock(plainLines(itemLines, 400), {
    ...body,
    x: bodyX + 12,
    y: itemY,
  });
  return {
    ...(node.icon ? { icon: { x: iconX, y: iconY, size: iconSize } } : {}),
    text: [
      ...(hasText
        ? textBlock(titleLines, {
            x: titleX,
            y: titleY,
            lineHeight: titleLineHeight,
            anchor: 'start',
            face: 'sans',
            size: titleSize,
          })
        : []),
      ...textBlock(plainLines(descriptionLines, 400), {
        ...body,
        x: bodyX,
        y: bodyY,
      }),
      ...items,
    ],
    bullets: items.map((item) => ({ x: bodyX + 3, y: item.y - 3 })),
  };
}

function applianceContent(node: DiagramNode, box: Box): NodeContent {
  const fontSize = node.fontSize ?? 12;
  const bodyX = box.x + 4;
  const bodyY = box.y + Math.max(12, Math.min(22, box.h * 0.28));
  const bodyW = Math.max(36, box.w - 8);
  const bodyH = Math.max(24, box.h - (bodyY - box.y) - 12);
  const slant = Math.max(
    4,
    Math.min(node.slant ?? 16, bodyW * 0.28, bodyH * 0.75),
  );
  const jackCount = Math.max(0, Math.floor(node.appliancePorts ?? 4));
  const jackY = bodyY + bodyH - 15;
  const jackStartX = bodyX + slant + 16;
  const jackSpacing = Math.min(
    13,
    Math.max(8, (bodyW - slant - 42) / Math.max(jackCount, 1)),
  );
  const antenna: [Point, Point][] =
    (node.antenna ?? true)
      ? [
          [
            { x: bodyX + slant + bodyW * 0.18, y: bodyY + 1 },
            { x: bodyX + slant + bodyW * 0.2 - 3, y: box.y + 3 },
          ],
          [
            { x: bodyX + slant + bodyW * 0.2 + 1, y: bodyY + 2 },
            { x: bodyX + slant + bodyW * 0.2 + 1, y: box.y + 8 },
          ],
        ]
      : [];
  return {
    text: textBlock(nonEmpty(labelLines(node.label, node.fontWeight ?? 600)), {
      x: box.x + box.w / 2,
      y: bodyY + bodyH + Math.max(12, fontSize + 2),
      lineHeight: Math.max(12, fontSize + 2),
      anchor: 'middle',
      face: 'sans',
      size: fontSize,
    }),
    appliance: {
      body: [
        { x: bodyX + slant, y: bodyY },
        { x: bodyX + bodyW, y: bodyY + 6 },
        { x: bodyX + bodyW - slant, y: bodyY + bodyH },
        { x: bodyX, y: bodyY + bodyH - 6 },
      ],
      face: [
        { x: bodyX + slant, y: bodyY + bodyH - 1 },
        { x: bodyX + bodyW - slant, y: bodyY + bodyH + 3 },
      ],
      antenna,
      jacks: Array.from({ length: jackCount }, (_, i) => ({
        x: jackStartX + i * jackSpacing,
        y: jackY,
        w: 5,
        h: 12,
      })),
    },
  };
}

function connectorContent(node: DiagramNode, box: Box): NodeContent {
  const centerY = box.y + box.h / 2;
  const iconSize = node.iconSize ?? 18;
  const fontSize = node.fontSize ?? 10;
  const lineHeight = Math.max(12, fontSize + 2);
  const lines = nonEmpty(labelLines(node.label, node.fontWeight ?? 700));
  const iconX = box.x + 10;
  return {
    radius: node.rx ?? Math.min(12, box.h / 2),
    ...(node.icon
      ? { icon: { x: iconX, y: centerY - iconSize / 2, size: iconSize } }
      : {}),
    text: textBlock(lines, {
      x: node.icon ? iconX + iconSize + 8 : box.x + box.w / 2,
      y: centerY - ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.35,
      lineHeight,
      anchor: node.icon ? 'start' : 'middle',
      face: 'sans',
      size: fontSize,
    }),
  };
}

function markerContent(node: DiagramNode, box: Box): NodeContent {
  const iconSize = node.iconSize ?? 34;
  const fontSize = node.fontSize ?? 11;
  const lineHeight = Math.max(12, fontSize + 2);
  const lines = nonEmpty(labelLines(node.label, node.fontWeight ?? 700));
  const labelGap = lines.length > 0 ? 8 : 0;
  const totalHeight = iconSize + labelGap + lines.length * lineHeight;
  const cx = box.x + box.w / 2;
  const iconX = Math.round(cx - iconSize / 2);
  const iconY = Math.round(box.y + (box.h - totalHeight) / 2);
  return {
    radius: node.rx ?? 0,
    icon: { x: iconX, y: iconY, size: iconSize },
    text: textBlock(lines, {
      x: cx,
      y: iconY + iconSize + labelGap + fontSize,
      lineHeight,
      anchor: 'middle',
      face: 'sans',
      size: fontSize,
    }),
  };
}

function junctionContent(node: DiagramNode, box: Box): NodeContent {
  const lines = Array.isArray(node.label) ? node.label : [node.label];
  const weight = node.fontWeight ?? 600;
  return {
    radius: Math.max(4, Math.min(box.w, box.h) / 2),
    text: lines.some(Boolean)
      ? textBlock(
          lines.map((line) => ({
            text: typeof line === 'string' ? line : line.text,
            weight: fontWeight(weight),
          })),
          {
            x: box.x + box.w / 2,
            y: box.y + box.h / 2 - Math.max(8, box.h / 2 + 6),
            lineHeight: Math.max(12, (node.fontSize ?? 12) + 2),
            anchor: 'middle',
            face: 'mono',
            size: node.fontSize ?? 10,
          },
        )
      : [],
  };
}

function nodeCaption(node: DiagramNode, box: Box): NodeLayout['caption'] {
  const placement = nodeCaptionPlacement(node, box);
  const bounds = nodeCaptionBounds(node, box);
  if (!placement || !bounds) return undefined;
  const lines = plainLines(placement.lines, node.captionFontWeight ?? 600).map(
    (line) =>
      node.captionColor ? { ...line, color: node.captionColor } : line,
  );
  return {
    box: bounds,
    framed: Boolean(node.captionFrame),
    text: textBlock(lines, {
      x: placement.x,
      y: placement.y,
      lineHeight: placement.lineHeight,
      anchor: placement.align,
      face: 'sans',
      size: placement.fontSize,
    }),
  };
}

function portLayout(port: PortPlacement): PortLayout {
  return {
    id: port.id,
    side: port.side,
    point: { x: port.x, y: port.y },
    ...(port.label
      ? {
          label: textRun(
            { text: port.label, weight: 600 },
            port.labelX,
            port.labelY,
            port.labelAlign,
            { face: 'mono', size: 9, weight: 600 },
          ),
        }
      : {}),
  };
}

function groupLayout(group: DiagramGroup, graph: GraphLayoutSpec): GroupLayout {
  const rect = groupBox(group, graph.nodes, graph.layout, graph.groups);
  const bandHeight = group.titleBand ? groupTitleGutterHeight(group) : 0;
  const labelAlign = group.labelAlign ?? 'center';
  const labelInset = 16;
  return {
    group,
    depth: groupDepth(group, graph.groups ?? []),
    rect,
    ...(bandHeight > 0
      ? { band: { x: rect.x, y: rect.y, w: rect.w, h: bandHeight } }
      : {}),
    label: textBlock(plainLines(groupLabelLines(group), 600), {
      x:
        labelAlign === 'start'
          ? rect.x + labelInset
          : labelAlign === 'end'
            ? rect.x + rect.w - labelInset
            : rect.x + rect.w / 2,
      y:
        group.labelSide === 'bottom'
          ? rect.y + rect.h - groupLabelHeight(group) + GROUP_LABEL_H - 14
          : rect.y + GROUP_LABEL_H,
      lineHeight: 14,
      anchor: labelAlign === 'center' ? 'middle' : labelAlign,
      face: 'sans',
      size: 12,
    }),
    dividers: groupDividerLines(
      group,
      graph.nodes,
      graph.layout,
      graph.groups,
    ).map((line) => [
      { x: line.x1, y: line.y1 },
      { x: line.x2, y: line.y2 },
    ]),
    ports: groupPortPlacements(group, rect).map(portLayout),
  };
}

function groupDepth(group: DiagramGroup, groups: DiagramGroup[]): number {
  const parent = groups.find((candidate) => candidate.id === group.parent);
  return parent ? groupDepth(parent, groups) + 1 : 0;
}

function edgeLayout(routed: RoutedEdge): EdgeLayout {
  const { edge, labelPlacement, badgePlacement } = routed;
  const layout: EdgeLayout = {
    edge,
    exitSide: routed.exitSide,
    entrySide: routed.entrySide,
    points: routed.points,
    d: routed.d,
  };
  if (edge.label?.length && labelPlacement) {
    layout.label = {
      box: edgeLabelFrameBox(edge, labelPlacement),
      text: textBlock(plainLines(edge.label, 400), {
        x: labelPlacement.x,
        y: labelPlacement.y,
        lineHeight: edgeLabelLineHeight(edge),
        anchor: labelPlacement.align,
        face: 'mono',
        size: edgeLabelFontSize(edge),
      }),
      ...(labelPlacement.segmentIndex === undefined
        ? {}
        : { segment: labelPlacement.segmentIndex }),
    };
  }
  const badgeLines = edge.badgeLabel ?? [];
  if ((edge.badgeIcon || badgeLines.length > 0) && badgePlacement) {
    const { w, h } = edgeBadgeSize(edge);
    const left = badgePlacement.x - w / 2;
    const iconSize = edge.badgeIcon ? EDGE_BADGE_ICON : 0;
    const iconGap = edge.badgeIcon && badgeLines.length > 0 ? 8 : 0;
    layout.badge = {
      box: { x: left, y: badgePlacement.y - h / 2, w, h },
      ...(edge.badgeIcon
        ? {
            icon: {
              x: left + 8,
              y: badgePlacement.y - iconSize / 2,
              w: iconSize,
              h: iconSize,
            },
          }
        : {}),
      text: textBlock(plainLines(badgeLines, 600), {
        x: left + 8 + iconSize + iconGap,
        y: badgePlacement.y - ((badgeLines.length - 1) * 12) / 2 + 4,
        lineHeight: 12,
        anchor: 'start',
        face: 'sans',
        size: 10,
      }),
    };
  }
  return layout;
}

function noteLayout(
  annotation: ResolvedDiagramAnnotation,
  index: number,
): { note: NodeLayout; leaders: LeaderLayout[] } {
  const id = `${ANNOTATION_NOTE_PREFIX}${index}`;
  const fontSize = annotation.fontSize ?? 11;
  const lines = plainLines(annotation.text, annotation.fontWeight ?? 500).map(
    (line) => (annotation.color ? { ...line, color: annotation.color } : line),
  );
  const text = textBlock(lines, {
    x: annotation.x,
    y: annotation.y,
    lineHeight: fontSize + (annotation.lineGap ?? 4),
    anchor: annotation.align ?? 'middle',
    face: 'sans',
    size: fontSize,
  });
  const box =
    text.length > 0
      ? unionBox(text.map((run) => run.bounds))
      : { x: annotation.x, y: annotation.y, w: 0, h: 0 };
  return {
    note: {
      node: { id, kind: 'note', label: annotation.text, frame: 'none' },
      box,
      visual: box,
      frames: [],
      radius: 0,
      text,
      bullets: [],
      ports: [],
    },
    leaders: (annotation.leaders ?? []).map((leader) => ({
      note: id,
      target: leader.target,
      points: leader.points,
      d: leader.points
        .map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
        .join(' '),
    })),
  };
}
