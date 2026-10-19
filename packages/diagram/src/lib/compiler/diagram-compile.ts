import {
  Children,
  Fragment,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from 'react';

import type {
  DiagramAnnotation,
  DiagramEdge,
  DiagramFrameElement,
  DiagramGraphIR,
  DiagramGraphLayout,
  DiagramGuide,
  DiagramLabelLine,
  DiagramLane,
  DiagramNode,
  DiagramSignal,
  DiagramSignalBox,
  DiagramTimelineSpec,
  DiagramWaypoint,
} from '../model/diagram-ir.ts';
import type {
  DiagramApplianceProps,
  DiagramConnectorProps,
  DiagramContentProps,
  DiagramEdgeProps,
  DiagramEntryProps,
  DiagramExitProps,
  DiagramFrameProps,
  DiagramGroupProps,
  DiagramGuideProps,
  DiagramJunctionProps,
  DiagramLaneProps,
  DiagramLineProps,
  DiagramMarkerProps,
  DiagramNodeProps,
  DiagramPhantomProps,
  DiagramSignalProps,
  DiagramTextProps,
  DiagramWaypointProps,
} from '../react/diagram-types.ts';

export const DIAGRAM_PRIMITIVE = Symbol.for('@zukhruf/diagram/primitive');

const PRIMITIVE_KINDS = [
  'node',
  'box',
  'card',
  'port',
  'label',
  'float',
  'phantom',
  'appliance',
  'connector',
  'junction',
  'edge',
  'arrow',
  'wire',
  'group',
  'text',
  'line',
  'lane',
  'signal',
  'frame',
  'marker',
  'guide',
  'waypoint',
  'entry',
  'exit',
  'content',
] as const;

export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

export type PrimitiveComponent<P> = ((props: P) => null) & {
  [DIAGRAM_PRIMITIVE]: PrimitiveKind;
};

export function primitive<P>(kind: PrimitiveKind): PrimitiveComponent<P> {
  return Object.assign(() => null, { [DIAGRAM_PRIMITIVE]: kind });
}

export function primitiveKind(node: ReactNode): PrimitiveKind | null {
  if (!isValidElement(node)) return null;
  const { type } = node;
  if (typeof type !== 'function' || !(DIAGRAM_PRIMITIVE in type)) return null;
  const kind = type[DIAGRAM_PRIMITIVE];
  return isPrimitiveKind(kind) ? kind : null;
}

function isPrimitiveKind(value: unknown): value is PrimitiveKind {
  return PRIMITIVE_KINDS.some((kind) => kind === value);
}

type CompileContext = {
  groupId?: string;
};

type CompileResult = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGraphIR['groups'];
  annotations: DiagramAnnotation[];
  lanes: DiagramLane[];
  signals: DiagramSignal[];
  frames: DiagramFrameElement[];
  guides: DiagramGuide[];
};

function emptyCompileResult(): CompileResult {
  return {
    nodes: [],
    edges: [],
    groups: [],
    annotations: [],
    lanes: [],
    signals: [],
    frames: [],
    guides: [],
  };
}

function mergeCompileResults(target: CompileResult, source: CompileResult) {
  target.nodes.push(...source.nodes);
  target.edges.push(...source.edges);
  target.groups.push(...source.groups);
  target.annotations.push(...source.annotations);
  target.lanes.push(...source.lanes);
  target.signals.push(...source.signals);
  target.frames.push(...source.frames);
  target.guides.push(...source.guides);
}

export function compileGraph(
  children: ReactNode,
  layout: DiagramGraphLayout | undefined,
): DiagramGraphIR {
  const result = compileChildren(children, {});
  if (
    result.lanes.length > 0 ||
    result.signals.length > 0 ||
    result.frames.length > 0
  ) {
    throw new Error(
      'A graph diagram cannot contain Diagram.Lane, Diagram.Signal or Diagram.Frame; draw those with SvgTimelineDiagram.',
    );
  }
  return {
    nodes: result.nodes,
    edges: result.edges,
    groups: result.groups,
    annotations: result.annotations,
    guides: result.guides,
    layout,
  };
}

export function compileTimeline(children: ReactNode): DiagramTimelineSpec {
  const result = compileChildren(children, {});
  if (
    result.nodes.length > 0 ||
    result.edges.length > 0 ||
    result.groups.length > 0 ||
    result.annotations.length > 0 ||
    result.guides.length > 0
  ) {
    throw new Error(
      'A timeline diagram only accepts Diagram.Lane, Diagram.Signal and Diagram.Frame; draw other primitives with SvgGraphDiagram or CanvasGraphDiagram.',
    );
  }
  return {
    lanes: result.lanes,
    signals: result.signals,
    frame: result.frames[0],
  };
}

function compileChildren(
  children: ReactNode,
  context: CompileContext,
): CompileResult {
  const result = emptyCompileResult();
  Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === 'boolean')
      return;
    if (isTextNode(child)) {
      if (String(child).trim().length === 0) return;
      throw new Error(
        `Unexpected text "${String(child).trim()}" directly inside Diagram.`,
      );
    }
    if (!isValidElement(child)) {
      throw new Error('Diagram only accepts Diagram primitives as children.');
    }
    if (child.type === Fragment) {
      throw new Error(
        'Diagram does not accept React fragments. Place Diagram primitives directly or return an array of primitives.',
      );
    }

    const kind = primitiveKind(child);
    if (!kind) {
      const name =
        typeof child.type === 'function' ? child.type.name : String(child.type);
      throw new Error(
        `Diagram cannot compile <${name || 'Component'} />. Use direct Diagram primitives as children.`,
      );
    }

    if (isNodeKind(kind)) {
      result.nodes.push(compileNode(kind, child, context));
      return;
    }
    if (isEdgeKind(kind)) {
      result.edges.push(compileEdge(kind, child));
      return;
    }
    if (kind === 'group') {
      const group = compileGroup(child, context);
      result.groups.push(group.group);
      mergeCompileResults(result, group.children);
      return;
    }
    if (kind === 'text') {
      result.annotations.push(compileText(child));
      return;
    }
    if (kind === 'lane') {
      result.lanes.push(compileLane(child));
      return;
    }
    if (kind === 'signal') {
      result.signals.push(compileSignal(child));
      return;
    }
    if (kind === 'frame') {
      if (result.frames.length > 0) {
        throw new Error(
          'Diagram supports one Frame in lane/signal layout for now.',
        );
      }
      result.frames.push(compileFrame(child));
      return;
    }
    if (kind === 'guide') {
      result.guides.push(requirePrimitiveProps<DiagramGuideProps>(child));
      return;
    }

    throw new Error(`<Diagram.${kind}> cannot be a direct child of Diagram.`);
  });
  return result;
}

function isTextNode(child: ReactNode): child is string | number {
  return typeof child === 'string' || typeof child === 'number';
}

function isNodeKind(kind: PrimitiveKind): boolean {
  return (
    kind === 'node' ||
    kind === 'box' ||
    kind === 'card' ||
    kind === 'port' ||
    kind === 'label' ||
    kind === 'float' ||
    kind === 'phantom' ||
    kind === 'appliance' ||
    kind === 'connector' ||
    kind === 'junction' ||
    kind === 'marker'
  );
}

function isEdgeKind(kind: PrimitiveKind): boolean {
  return kind === 'edge' || kind === 'arrow' || kind === 'wire';
}

function requirePrimitiveProps<P>(child: ReactElement): P {
  // React's own guard types the element's props; only the calling primitive
  // knows their shape P.
  if (!isValidElement<P>(child)) {
    throw new Error('Diagram only accepts Diagram primitives as children.');
  }
  return child.props;
}

function compileNode(
  kind: PrimitiveKind,
  child: ReactElement,
  context: CompileContext,
): DiagramNode {
  if (kind === 'phantom') {
    const props = requirePrimitiveProps<DiagramPhantomProps>(child);
    const label = compileLabelChildren(props.children, 'Diagram.Phantom');
    const hasLabel = label.length > 0;
    return {
      id: props.id,
      label: hasLabel ? label : '',
      row: props.row,
      col: props.col,
      width: props.width ?? 1,
      height: props.height ?? 1,
      ...((props.group ?? context.groupId)
        ? { group: props.group ?? context.groupId }
        : {}),
      frame: 'none',
      hidden: props.hidden ?? !hasLabel,
      ...(props.fontSize ? { fontSize: props.fontSize } : {}),
      ...(props.fontWeight ? { fontWeight: props.fontWeight } : {}),
      ...(props.textColor ? { textColor: props.textColor } : {}),
      ...(props.accent !== undefined ? { accent: props.accent } : {}),
      ...(props.textAlign ? { textAlign: props.textAlign } : {}),
      ...(props.connectable !== undefined
        ? { connectable: props.connectable }
        : {}),
    };
  }

  if (kind === 'junction') {
    const props = requirePrimitiveProps<DiagramJunctionProps>(child);
    const label = compileLabelChildren(props.children, 'Diagram.Junction');
    const group = props.group ?? context.groupId;
    return {
      id: props.id,
      kind: 'junction',
      label: label.length > 0 ? label : '',
      row: props.row,
      col: props.col,
      width: props.width ?? 16,
      height: props.height ?? 16,
      ...(group ? { group } : {}),
      frame: 'none',
      connectable: true,
      hidden: props.hidden,
      accent: props.accent,
      tone: props.tone,
      fontSize: props.fontSize,
      fontWeight: props.fontWeight,
      textColor: props.textColor,
      caption: props.caption,
      captionSide: props.captionSide,
      captionOffset: props.captionOffset,
      captionColor: props.captionColor,
      captionFontSize: props.captionFontSize,
      captionFontWeight: props.captionFontWeight,
    };
  }

  if (kind === 'connector') {
    const props = requirePrimitiveProps<DiagramConnectorProps>(child);
    const label = compileLabelChildren(props.children, 'Diagram.Connector');
    const group = props.group ?? context.groupId;
    return {
      id: props.id,
      kind: 'connector',
      label: label.length > 0 ? label : '',
      row: props.row,
      col: props.col,
      colSpan: props.colSpan,
      width: props.width ?? 148,
      height: props.height ?? 40,
      ...(group ? { group } : {}),
      frame: 'solid',
      connectable: true,
      rx: props.rx ?? 10,
      accent: props.accent,
      tone: props.tone,
      texture: props.texture,
      icon: props.icon,
      iconSize: props.iconSize,
      ports: props.ports,
      fontSize: props.fontSize,
      fontWeight: props.fontWeight,
      textColor: props.textColor,
      caption: props.caption,
      captionSide: props.captionSide,
      captionOffset: props.captionOffset,
      captionColor: props.captionColor,
      captionFontSize: props.captionFontSize,
      captionFontWeight: props.captionFontWeight,
    };
  }

  if (kind === 'appliance') {
    const props = requirePrimitiveProps<DiagramApplianceProps>(child);
    const label = compileLabelChildren(props.children, 'Diagram.Appliance');
    const group = props.group ?? context.groupId;
    return {
      id: props.id,
      kind: 'appliance',
      label: label.length > 0 ? label : '',
      row: props.row,
      col: props.col,
      width: props.width ?? 112,
      height: props.height ?? 72,
      ...(group ? { group } : {}),
      frame: 'none',
      connectable: true,
      accent: props.accent,
      tone: props.tone,
      texture: props.texture,
      ports: props.ports,
      fontSize: props.fontSize,
      fontWeight: props.fontWeight,
      textColor: props.textColor,
      caption: props.caption,
      captionSide: props.captionSide,
      captionOffset: props.captionOffset,
      captionColor: props.captionColor,
      captionFontSize: props.captionFontSize,
      captionFontWeight: props.captionFontWeight,
      appliancePorts: props.appliancePorts,
      antenna: props.antenna,
      slant: props.slant,
    };
  }

  const props = requirePrimitiveProps<DiagramNodeProps | DiagramMarkerProps>(
    child,
  );
  const { children: _children, ...nodeProps } = props;
  const { labelChildren, content } = splitNodeContent(props.children, kind);
  const label = compileLabelChildren(labelChildren, `Diagram.${kind}`);
  const group = nodeProps.group ?? context.groupId;
  return {
    ...nodeProps,
    label: label.length > 0 ? label : '',
    ...(content.length > 0 ? { content: content[0] } : {}),
    ...(kind === 'marker'
      ? {
          kind: 'marker' as const,
          width: nodeProps.width ?? 72,
          height: nodeProps.height ?? 76,
        }
      : {}),
    ...(group ? { group } : {}),
    frame: nodeFrame(kind, nodeProps.frame),
    textAlign:
      kind === 'card' ? (nodeProps.textAlign ?? 'start') : nodeProps.textAlign,
    hidden: kind === 'marker' ? false : nodeProps.hidden,
    connectable: kind === 'float' ? false : nodeProps.connectable,
    ...(kind === 'marker' ? { frame: nodeProps.frame ?? 'none' } : {}),
  };
}

const CONTENT_HOSTS = new Set<PrimitiveKind>(['node', 'box', 'card']);

function splitNodeContent(children: ReactNode, kind: PrimitiveKind) {
  const labelChildren: ReactNode[] = [];
  const content: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || primitiveKind(child) !== 'content') {
      labelChildren.push(child);
      return;
    }
    if (!CONTENT_HOSTS.has(kind)) {
      throw new Error(
        `Diagram.Content goes inside Diagram.Box, Diagram.Card or Diagram.Node, not Diagram.${kind}.`,
      );
    }
    if (content.length > 0) {
      throw new Error(`Diagram.${kind} accepts one Diagram.Content.`);
    }
    content.push(requirePrimitiveProps<DiagramContentProps>(child).children);
  });
  return { labelChildren, content };
}

function nodeFrame(kind: PrimitiveKind, explicit: DiagramNode['frame']) {
  if (explicit) return explicit;
  if (kind === 'port') return 'transparent';
  if (kind === 'label') return 'none';
  if (kind === 'float') return 'flat';
  if (kind === 'appliance') return 'none';
  if (kind === 'marker') return 'none';
  return 'solid';
}

function compileEdge(kind: PrimitiveKind, child: ReactElement): DiagramEdge {
  const props = requirePrimitiveProps<DiagramEdgeProps>(child);
  const { children: _children, badgeLabel, ...edgeProps } = props;
  const lines: string[] = [];
  const waypoints: DiagramWaypoint[] = [...(props.waypoints ?? [])];
  let entrySide = props.entrySide;
  let exitSide = props.exitSide;
  let entryGap = props.entryGap;

  Children.forEach(props.children, (edgeChild) => {
    if (
      edgeChild === null ||
      edgeChild === undefined ||
      typeof edgeChild === 'boolean'
    )
      return;
    if (isTextNode(edgeChild)) {
      const text = String(edgeChild).trim();
      if (text.length > 0) lines.push(text);
      return;
    }
    if (!isValidElement(edgeChild)) {
      throw new Error(
        'Diagram edges only accept text, Line, Entry, Exit, and Waypoint children.',
      );
    }
    if (edgeChild.type === Fragment) {
      throw new Error(
        'Diagram edges do not accept fragments. Use direct Line/Entry/Exit/Waypoint children.',
      );
    }
    const edgeChildKind = primitiveKind(edgeChild);
    if (edgeChildKind === 'line') {
      lines.push(lineText(edgeChild));
      return;
    }
    if (edgeChildKind === 'entry') {
      const entry = requirePrimitiveProps<DiagramEntryProps>(edgeChild);
      entrySide = entry.side;
      entryGap = entry.gap ?? entryGap;
      return;
    }
    if (edgeChildKind === 'exit') {
      exitSide = requirePrimitiveProps<DiagramExitProps>(edgeChild).side;
      return;
    }
    if (edgeChildKind === 'waypoint') {
      waypoints.push(requirePrimitiveProps<DiagramWaypointProps>(edgeChild));
      return;
    }
    throw new Error(
      `Diagram edge cannot contain <Diagram.${edgeChildKind ?? 'Unknown'}>.`,
    );
  });

  return {
    ...edgeProps,
    ...(lines.length > 0 ? { label: lines } : {}),
    ...(badgeLabel !== undefined
      ? { badgeLabel: normalizeStringLines(badgeLabel) }
      : {}),
    ...(waypoints.length > 0 ? { waypoints } : {}),
    ...(entrySide ? { entrySide } : {}),
    ...(exitSide ? { exitSide } : {}),
    ...(entryGap !== undefined ? { entryGap } : {}),
    headless: kind === 'wire' ? true : edgeProps.headless,
  };
}

function normalizeStringLines(value: string | string[]) {
  return (Array.isArray(value) ? value : [value])
    .map((line) => line.trim())
    .filter(Boolean);
}

function compileGroup(
  child: ReactElement,
  context: CompileContext,
): { group: DiagramGraphIR['groups'][number]; children: CompileResult } {
  const props = requirePrimitiveProps<DiagramGroupProps>(child);
  const children = compileChildren(props.children, {
    ...context,
    groupId: props.id,
  });
  const bounds =
    props.rowStart !== undefined &&
    props.rowEnd !== undefined &&
    props.colStart !== undefined &&
    props.colEnd !== undefined
      ? {
          rowStart: props.rowStart,
          rowEnd: props.rowEnd,
          colStart: props.colStart,
          colEnd: props.colEnd,
        }
      : inferGroupBounds(props.id, children.nodes, children.groups);

  return {
    group: {
      id: props.id,
      label: normalizeGroupLabel(props.label),
      labelAlign: props.labelAlign,
      labelSide: props.labelSide,
      accent: props.accent,
      tone: props.tone,
      texture: props.texture,
      rx: props.rx,
      frame: props.frame,
      fill: props.fill,
      ports: props.ports,
      parent: context.groupId,
      tight: props.tight,
      tightX: props.tightX,
      tightY: props.tightY,
      titleBand: props.titleBand,
      titleGap: props.titleGap,
      padding: props.padding,
      dividers: props.dividers,
      bounds,
    },
    children,
  };
}

function normalizeGroupLabel(label: string | string[] | undefined) {
  if (Array.isArray(label)) {
    return label.map((line) => line.trim()).filter(Boolean);
  }
  return label?.trim() ?? '';
}

function inferGroupBounds(
  groupId: string,
  nodes: DiagramNode[],
  groups: DiagramGraphIR['groups'] = [],
) {
  const grouped = nodes.filter((node) => node.group === groupId);
  const childGroups = groups.filter((group) => group.parent === groupId);
  if (grouped.length === 0 && childGroups.length === 0) {
    throw new Error(
      `Diagram.Group "${groupId}" needs bounds or direct node/group children so bounds can be inferred.`,
    );
  }
  const bounds = emptyGroupBounds();
  for (const node of grouped) {
    if (node.row === undefined || node.col === undefined) return undefined;
    includeGroupBounds(bounds, {
      rowStart: node.row,
      rowEnd: node.row,
      colStart: node.col,
      colEnd: node.col + (node.colSpan ?? 1) - 1,
    });
  }
  for (const group of childGroups) {
    if (!group.bounds) return undefined;
    includeGroupBounds(bounds, group.bounds);
  }
  return bounds;
}

function emptyGroupBounds(): NonNullable<
  DiagramGraphIR['groups'][number]['bounds']
> {
  return {
    rowStart: Number.POSITIVE_INFINITY,
    rowEnd: Number.NEGATIVE_INFINITY,
    colStart: Number.POSITIVE_INFINITY,
    colEnd: Number.NEGATIVE_INFINITY,
  };
}

function includeGroupBounds(
  target: NonNullable<DiagramGraphIR['groups'][number]['bounds']>,
  source: NonNullable<DiagramGraphIR['groups'][number]['bounds']>,
) {
  target.rowStart = Math.min(target.rowStart, source.rowStart);
  target.rowEnd = Math.max(target.rowEnd, source.rowEnd);
  target.colStart = Math.min(target.colStart, source.colStart);
  target.colEnd = Math.max(target.colEnd, source.colEnd);
}

function compileText(child: ReactElement): DiagramAnnotation {
  const props = requirePrimitiveProps<DiagramTextProps>(child);
  const { children: _children, ...textProps } = props;
  const lines = compileStringLines(props.children, 'Diagram.Text');
  return {
    ...textProps,
    text: lines.length > 0 ? lines : [''],
  };
}

function compileLane(child: ReactElement): DiagramLane {
  const props = requirePrimitiveProps<DiagramLaneProps>(child);
  return {
    id: props.id,
    label: compileStringLines(props.children, 'Diagram.Lane'),
    accent: props.accent,
  };
}

function normalizeBoxed(
  boxed: boolean | DiagramSignalBox | undefined,
): DiagramSignalBox | undefined {
  if (boxed === true) return 'source';
  if (!boxed) return undefined;
  return boxed;
}

function compileSignal(child: ReactElement): DiagramSignal {
  const props = requirePrimitiveProps<DiagramSignalProps>(child);
  const { children: _children, boxed, ...signalProps } = props;
  const normalizedBoxed = normalizeBoxed(boxed);
  return {
    ...signalProps,
    label: compileStringLines(props.children, 'Diagram.Signal'),
    ...(normalizedBoxed ? { boxed: normalizedBoxed } : {}),
  };
}

function compileFrame(child: ReactElement): DiagramFrameElement {
  const props = requirePrimitiveProps<DiagramFrameProps>(child);
  const signals: DiagramSignal[] = [];
  Children.forEach(props.children, (frameChild) => {
    if (
      frameChild === null ||
      frameChild === undefined ||
      typeof frameChild === 'boolean'
    )
      return;
    if (!isValidElement(frameChild) || primitiveKind(frameChild) !== 'signal') {
      throw new Error(
        'Diagram.Frame only accepts direct Diagram.Signal children.',
      );
    }
    signals.push(compileSignal(frameChild));
  });
  return { label: props.label, signals };
}

function compileStringLines(children: ReactNode, owner: string): string[] {
  const lines: string[] = [];
  Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === 'boolean')
      return;
    if (isTextNode(child)) {
      const text = String(child).trim();
      if (text.length > 0) lines.push(text);
      return;
    }
    if (!isValidElement(child)) {
      throw new Error(`${owner} only accepts text or Diagram.Line children.`);
    }
    if (child.type === Fragment) {
      throw new Error(
        `${owner} does not accept React fragments. Use direct text or Diagram.Line children.`,
      );
    }
    if (primitiveKind(child) === 'line') {
      lines.push(lineText(child));
      return;
    }
    throw new Error(`${owner} only accepts text or Diagram.Line children.`);
  });
  return lines;
}

function compileLabelChildren(
  children: ReactNode,
  owner: string,
): DiagramLabelLine[] {
  const lines: DiagramLabelLine[] = [];
  Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === 'boolean')
      return;
    if (isTextNode(child)) {
      const text = String(child).trim();
      if (text.length > 0) lines.push(text);
      return;
    }
    if (!isValidElement(child)) {
      throw new Error(`${owner} only accepts text or Diagram.Line children.`);
    }
    if (child.type === Fragment) {
      throw new Error(
        `${owner} does not accept React fragments. Use direct text or Diagram.Line children.`,
      );
    }
    if (primitiveKind(child) === 'line') {
      const props = requirePrimitiveProps<DiagramLineProps>(child);
      lines.push({
        text: lineText(child),
        ...(props.textColor ? { textColor: props.textColor } : {}),
        ...(props.fontWeight ? { fontWeight: props.fontWeight } : {}),
      });
      return;
    }
    throw new Error(`${owner} only accepts text or Diagram.Line children.`);
  });
  return lines;
}

function lineText(child: ReactElement): string {
  const props = requirePrimitiveProps<DiagramLineProps>(child);
  return Children.toArray(props.children)
    .map((part) => {
      if (!isTextNode(part)) {
        throw new Error('Diagram.Line only accepts text children.');
      }
      return String(part).trim();
    })
    .filter(Boolean)
    .join('');
}

export function validateGraph(ir: DiagramGraphIR) {
  const nodeIds = new Set<string>();
  for (const node of ir.nodes) {
    if (nodeIds.has(node.id))
      throw new Error(`Duplicate Diagram node id "${node.id}".`);
    nodeIds.add(node.id);
  }
  const groupIds = new Set<string>();
  for (const group of ir.groups) {
    if (groupIds.has(group.id))
      throw new Error(`Duplicate Diagram group id "${group.id}".`);
    groupIds.add(group.id);
  }
  const guideIds = new Set<string>();
  for (const guide of ir.guides) {
    if (!guide.id) continue;
    if (guideIds.has(guide.id))
      throw new Error(`Duplicate Diagram guide id "${guide.id}".`);
    guideIds.add(guide.id);
  }
  const nodesById = new Map(ir.nodes.map((node) => [node.id, node]));
  const groupsById = new Map(ir.groups.map((group) => [group.id, group]));
  for (const node of ir.nodes) {
    if (groupsById.has(node.id)) {
      throw new Error(
        `Diagram node id "${node.id}" conflicts with a Diagram group id. Node and group endpoint ids must be unique.`,
      );
    }
    if (
      node.bodyFontSize !== undefined &&
      (!Number.isFinite(node.bodyFontSize) || node.bodyFontSize <= 0)
    ) {
      throw new Error(
        `Diagram node "${node.id}" bodyFontSize must be a positive finite number, got ${node.bodyFontSize}.`,
      );
    }
    if (
      node.bodyLineGap !== undefined &&
      (!Number.isFinite(node.bodyLineGap) || node.bodyLineGap < 0)
    ) {
      throw new Error(
        `Diagram node "${node.id}" bodyLineGap must be a non-negative finite number, got ${node.bodyLineGap}.`,
      );
    }
  }
  for (const edge of ir.edges) {
    if (
      edge.route !== undefined &&
      edge.route !== 'orthogonal' &&
      edge.route !== 'straight'
    ) {
      throw new Error(
        `Diagram edge route must be "orthogonal" or "straight", got "${edge.route}".`,
      );
    }
    if (
      edge.labelLineGap !== undefined &&
      (!Number.isFinite(edge.labelLineGap) || edge.labelLineGap < 0)
    ) {
      throw new Error(
        `Diagram edge labelLineGap must be a non-negative finite number, got ${edge.labelLineGap}.`,
      );
    }
    if (edge.exitOffset !== undefined && !Number.isFinite(edge.exitOffset)) {
      throw new Error(
        `Diagram edge exitOffset must be a finite number, got ${edge.exitOffset}.`,
      );
    }
    if (edge.entryOffset !== undefined && !Number.isFinite(edge.entryOffset)) {
      throw new Error(
        `Diagram edge entryOffset must be a finite number, got ${edge.entryOffset}.`,
      );
    }
    if (
      edge.stubDistance !== undefined &&
      (!Number.isFinite(edge.stubDistance) || edge.stubDistance < 0)
    ) {
      throw new Error(
        `Diagram edge stubDistance must be a non-negative finite number, got ${edge.stubDistance}.`,
      );
    }
    const sourceNodeId = endpointNodeId(edge.from);
    const targetNodeId = endpointNodeId(edge.to);
    if (!nodeIds.has(sourceNodeId) && !groupsById.has(sourceNodeId)) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing source "${sourceNodeId}".`,
      );
    }
    if (!nodeIds.has(targetNodeId) && !groupsById.has(targetNodeId)) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing target "${targetNodeId}".`,
      );
    }
    const sourcePortId = edge.from.includes(':')
      ? edge.from.slice(edge.from.indexOf(':') + 1)
      : undefined;
    const targetPortId = edge.to.includes(':')
      ? edge.to.slice(edge.to.indexOf(':') + 1)
      : undefined;
    if (
      sourcePortId &&
      !(
        nodesById
          .get(sourceNodeId)
          ?.ports?.some((port) => port.id === sourcePortId) ||
        groupsById
          .get(sourceNodeId)
          ?.ports?.some((port) => port.id === sourcePortId)
      )
    ) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing source port "${sourcePortId}" on "${sourceNodeId}".`,
      );
    }
    if (
      targetPortId &&
      !(
        nodesById
          .get(targetNodeId)
          ?.ports?.some((port) => port.id === targetPortId) ||
        groupsById
          .get(targetNodeId)
          ?.ports?.some((port) => port.id === targetPortId)
      )
    ) {
      throw new Error(
        `Diagram edge ${edge.from}->${edge.to} references missing target port "${targetPortId}" on "${targetNodeId}".`,
      );
    }
  }
  for (const annotation of ir.annotations) {
    if (
      annotation.lineGap !== undefined &&
      (!Number.isFinite(annotation.lineGap) || annotation.lineGap < 0)
    ) {
      throw new Error(
        `Diagram.Text lineGap must be a non-negative finite number, got ${annotation.lineGap}.`,
      );
    }
  }
}

export function validateTimeline(ir: DiagramTimelineSpec) {
  const laneIds = new Set<string>();
  for (const lane of ir.lanes) {
    if (laneIds.has(lane.id))
      throw new Error(`Duplicate Diagram lane id "${lane.id}".`);
    laneIds.add(lane.id);
  }
  const signals = [...ir.signals, ...(ir.frame?.signals ?? [])];
  for (const signal of signals) {
    if (!laneIds.has(signal.from)) {
      throw new Error(
        `Diagram signal ${signal.from}->${signal.to} references missing lane "${signal.from}".`,
      );
    }
    if (!laneIds.has(signal.to)) {
      throw new Error(
        `Diagram signal ${signal.from}->${signal.to} references missing lane "${signal.to}".`,
      );
    }
  }
}

function endpointNodeId(ref: string) {
  const separator = ref.indexOf(':');
  if (separator === -1) return ref;
  return ref.slice(0, separator);
}
