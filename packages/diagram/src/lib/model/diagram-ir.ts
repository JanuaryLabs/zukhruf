import type { ReactNode } from 'react';

export type DiagramTextColor = 'accent' | 'neutral' | 'dim';

export type DiagramTone =
  'neutral' | 'green' | 'blue' | 'amber' | 'rose' | 'purple' | 'slate';

export type DiagramTexture = 'dots' | 'hatch' | 'none';

export type DiagramNodeIcon =
  | 'certificate'
  | 'cloudflare'
  | 'dashboard'
  | 'file'
  | 'git'
  | 'gpu'
  | 'user'
  | 'brain'
  | 'internet'
  | 'istio'
  | 'kubernetes'
  | 'logs'
  | 'metrics'
  | 'router'
  | 'server'
  | 'shield'
  | 'storage'
  | 'trace'
  | 'tunnel'
  | 'eye'
  | 'eye-off'
  | 'ellipsis';

export type DiagramLabelLine =
  | string
  | {
      text: string;
      textColor?: DiagramTextColor;
      fontWeight?: number;
    };

export type DiagramSide = 'top' | 'bottom' | 'left' | 'right';
export type DiagramLabelAlign = 'start' | 'center' | 'end';
export type DiagramEdgeLineStyle = 'solid' | 'dashed' | 'dotted';
export type DiagramEdgeDirection = 'forward' | 'both' | 'none';
export type DiagramEdgeLayer = 'background' | 'foreground';
export type DiagramEdgeWeight = 'regular' | 'bold';
export type DiagramStackDirection =
  'up-left' | 'up-right' | 'down-left' | 'down-right';

export type DiagramNodePort = {
  id: string;
  side: DiagramSide;
  label?: string;
  accent?: boolean;
};

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

export type DiagramViewportFit = 'width' | 'contain' | 'natural';

export type DiagramViewport = {
  fit?: DiagramViewportFit;
  zoom?: number;
};

export type DiagramPaperFill = 'background' | 'surface';

export type DiagramPaper =
  | boolean
  | {
      fill?: DiagramPaperFill;
      stroke?: boolean;
      rx?: number;
    };

/** React content drawn inside a node, in a box of the size its author gives. */
export type DiagramNodeContent = {
  element: ReactNode;
  size: { w: number; h: number };
};

export type DiagramNode = {
  id: string;
  label: string | DiagramLabelLine[];
  /** Only HtmlGraphDiagram draws it. */
  content?: DiagramNodeContent;
  kind?: 'node' | 'appliance' | 'connector' | 'junction' | 'marker' | 'note';
  row?: number | undefined;
  col?: number | undefined;
  colSpan?: number | undefined;
  rowSpan?: number | undefined;
  /** The id of the node or group a note explains. */
  target?: string | undefined;
  frame?: 'solid' | 'transparent' | 'flat' | 'filled' | 'none';
  textColor?: DiagramTextColor | undefined;
  tone?: DiagramTone | undefined;
  texture?: DiagramTexture | undefined;
  accent?: boolean | undefined;
  description?: string | string[];
  items?: string[];
  caption?: string | string[] | undefined;
  captionSide?: DiagramSide | undefined;
  captionFrame?: boolean;
  captionColor?: DiagramTextColor | undefined;
  /** The group the node is nested in. */
  group?: string;
  icon?: DiagramNodeIcon | undefined;
  ports?: DiagramNodePort[] | undefined;
  /** Set for a Card: its text starts at the left edge under a title. */
  textAlign?: 'center' | 'start' | undefined;
  hidden?: boolean | undefined;
  /** False for a Float, which no edge may start or end at. */
  connectable?: boolean | undefined;
  stack?: number;
  stackDirection?: DiagramStackDirection;
  appliancePorts?: number | undefined;
  antenna?: boolean | undefined;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string[];
  badgeIcon?: DiagramNodeIcon;
  badgeLabel?: string[];
  labelFrame?: boolean;
  channel?: string;
  lineStyle?: DiagramEdgeLineStyle;
  direction?: DiagramEdgeDirection;
  layer?: DiagramEdgeLayer;
  weight?: DiagramEdgeWeight;
  exitSide?: DiagramSide;
  entrySide?: DiagramSide;
  accent?: boolean;
  dim?: boolean;
  headless?: boolean | undefined;
};

export type DiagramGroup = {
  id: string;
  label: string | string[];
  labelAlign?: DiagramLabelAlign | undefined;
  labelSide?: 'top' | 'bottom' | undefined;
  accent?: boolean | undefined;
  tone?: DiagramTone | undefined;
  texture?: DiagramTexture | undefined;
  frame?: 'solid' | 'dashed' | 'none' | undefined;
  fill?: 'surface' | 'none' | undefined;
  ports?: DiagramNodePort[] | undefined;
  parent?: string | undefined;
  /** An explicit grid area; without one the group covers the bounding box of its members. */
  row?: number | undefined;
  col?: number | undefined;
  rowSpan?: number | undefined;
  colSpan?: number | undefined;
  titleBand?: boolean | undefined;
  /** A line through every gutter inside the group. */
  dividers?: boolean | undefined;
};

export type DiagramLane = {
  id: string;
  label: string[];
  accent?: boolean | undefined;
};

export type DiagramSignalBox = 'source' | 'center' | 'target';

export type DiagramSignal = {
  from: string;
  to: string;
  label: string[];
  accent?: boolean;
  dim?: boolean;
  boxed?: DiagramSignalBox;
  stub?: number;
  bordered?: boolean;
  filled?: boolean;
};

export type DiagramFrameElement = {
  label: string;
  signals: DiagramSignal[];
};

export type DiagramMarker = DiagramNode;

export type DiagramGraphIR = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
};

export type DiagramTimelineSpec = {
  lanes: DiagramLane[];
  signals: DiagramSignal[];
  frame?: DiagramFrameElement | undefined;
};
