import {
  Children,
  Fragment,
  type ReactElement,
  type ReactNode,
  isValidElement,
} from 'react';

import type {
  DiagramEdge,
  DiagramFrameElement,
  DiagramGraphIR,
  DiagramLabelLine,
  DiagramLane,
  DiagramNode,
  DiagramNodeContent,
  DiagramSignal,
  DiagramSignalBox,
  DiagramTimelineSpec,
} from '../model/diagram-ir.ts';
import type {
  DiagramApplianceProps,
  DiagramConnectorProps,
  DiagramContentProps,
  DiagramEdgeProps,
  DiagramFrameProps,
  DiagramGroupProps,
  DiagramJunctionProps,
  DiagramLaneProps,
  DiagramLineProps,
  DiagramMarkerProps,
  DiagramNodeProps,
  DiagramNoteProps,
  DiagramSignalProps,
} from '../react/diagram-types.ts';

export const DIAGRAM_PRIMITIVE = Symbol.for('@zukhruf/diagram/primitive');

const PRIMITIVE_KINDS = [
  'node',
  'box',
  'card',
  'port',
  'label',
  'float',
  'appliance',
  'connector',
  'junction',
  'edge',
  'arrow',
  'wire',
  'group',
  'note',
  'line',
  'lane',
  'signal',
  'frame',
  'marker',
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
  lanes: DiagramLane[];
  signals: DiagramSignal[];
  frames: DiagramFrameElement[];
};

function emptyCompileResult(): CompileResult {
  return {
    nodes: [],
    edges: [],
    groups: [],
    lanes: [],
    signals: [],
    frames: [],
  };
}

function mergeCompileResults(target: CompileResult, source: CompileResult) {
  target.nodes.push(...source.nodes);
  target.edges.push(...source.edges);
  target.groups.push(...source.groups);
  target.lanes.push(...source.lanes);
  target.signals.push(...source.signals);
  target.frames.push(...source.frames);
}

export function compileGraph(children: ReactNode): DiagramGraphIR {
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
  };
}

export function compileTimeline(children: ReactNode): DiagramTimelineSpec {
  const result = compileChildren(children, {});
  if (
    result.nodes.length > 0 ||
    result.edges.length > 0 ||
    result.groups.length > 0
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
    kind === 'note' ||
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
  const group = context.groupId === undefined ? {} : { group: context.groupId };

  if (kind === 'note') {
    const { children, ...props } =
      requirePrimitiveProps<DiagramNoteProps>(child);
    return {
      ...props,
      kind: 'note',
      label: nodeLabel(children, 'Diagram.Note'),
      ...group,
      frame: 'none',
    };
  }

  if (kind === 'junction') {
    const { children, ...props } =
      requirePrimitiveProps<DiagramJunctionProps>(child);
    return {
      ...props,
      kind: 'junction',
      label: nodeLabel(children, 'Diagram.Junction'),
      ...group,
      frame: 'none',
    };
  }

  if (kind === 'connector') {
    const { children, ...props } =
      requirePrimitiveProps<DiagramConnectorProps>(child);
    return {
      ...props,
      kind: 'connector',
      label: nodeLabel(children, 'Diagram.Connector'),
      ...group,
      frame: 'solid',
    };
  }

  if (kind === 'appliance') {
    const { children, ...props } =
      requirePrimitiveProps<DiagramApplianceProps>(child);
    return {
      ...props,
      kind: 'appliance',
      label: nodeLabel(children, 'Diagram.Appliance'),
      ...group,
      frame: 'none',
    };
  }

  const { children, ...props } = requirePrimitiveProps<
    DiagramNodeProps | DiagramMarkerProps
  >(child);
  const { labelChildren, content } = splitNodeContent(children, kind);
  return {
    ...props,
    label: nodeLabel(labelChildren, `Diagram.${kind}`),
    ...(content ? { content } : {}),
    ...(kind === 'marker' ? { kind: 'marker' as const } : {}),
    ...group,
    frame: nodeFrame(kind, props.frame),
    ...(kind === 'card' ? { textAlign: 'start' as const } : {}),
    hidden: kind === 'marker' ? false : props.hidden,
    ...(kind === 'float' ? { connectable: false } : {}),
  };
}

function nodeLabel(children: ReactNode, owner: string): DiagramNode['label'] {
  const label = compileLabelChildren(children, owner);
  return label.length > 0 ? label : '';
}

const CONTENT_HOSTS = new Set<PrimitiveKind>(['node', 'box', 'card']);

function splitNodeContent(children: ReactNode, kind: PrimitiveKind) {
  const labelChildren: ReactNode[] = [];
  let content: DiagramNodeContent | undefined;
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
    if (content) {
      throw new Error(`Diagram.${kind} accepts one Diagram.Content.`);
    }
    const { children: element, size } =
      requirePrimitiveProps<DiagramContentProps>(child);
    content = { element, size };
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
  const { children, badgeLabel, ...edgeProps } =
    requirePrimitiveProps<DiagramEdgeProps>(child);
  const lines = compileStringLines(children, `Diagram.${kind}`);
  return {
    ...edgeProps,
    ...(lines.length > 0 ? { label: lines } : {}),
    ...(badgeLabel !== undefined
      ? { badgeLabel: normalizeStringLines(badgeLabel) }
      : {}),
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
  const {
    children: groupChildren,
    label,
    ...props
  } = requirePrimitiveProps<DiagramGroupProps>(child);
  const children = compileChildren(groupChildren, {
    ...context,
    groupId: props.id,
  });
  return {
    group: {
      ...props,
      label: normalizeGroupLabel(label),
      parent: context.groupId,
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
