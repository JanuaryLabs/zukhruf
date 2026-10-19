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
export type DiagramAnchor = DiagramSide | 'center';
export type DiagramLabelAlign = 'start' | 'center' | 'end';
export type DiagramTextAlign = 'start' | 'middle' | 'end';
export type DiagramEdgeLabelSide =
  'auto' | 'above' | 'below' | 'left' | 'right';
export type DiagramEdgeLineStyle = 'solid' | 'dashed' | 'dotted';
export type DiagramEdgeDirection = 'forward' | 'both' | 'none';
export type DiagramEdgeLayer = 'background' | 'foreground';
export type DiagramEdgeRoute = 'orthogonal' | 'straight';
export type DiagramGuideOrientation = 'vertical' | 'horizontal';
export type DiagramStackDirection =
  'up-left' | 'up-right' | 'down-left' | 'down-right';

export type DiagramNodePort = {
  id: string;
  side: DiagramSide;
  offset?: number;
  label?: string;
  accent?: boolean;
};

export type Point = { x: number; y: number };
export type DiagramWaypoint =
  | Point
  | { row: number; col: number; dx?: number; dy?: number }
  | {
      guide: string;
      target?: string;
      anchor?: DiagramAnchor;
      gap?: number;
      row?: number;
      col?: number;
      x?: number;
      y?: number;
      dx?: number;
      dy?: number;
    }
  | {
      target: string;
      anchor?: DiagramAnchor;
      gap?: number;
      dx?: number;
      dy?: number;
    };
export type Box = { x: number; y: number; w: number; h: number };

export type DiagramGraphLayout = {
  colWidth?: number;
  rowHeight?: number;
  columns?: number[];
  rows?: number[];
  padX?: number;
  padY?: number;
  titleTopPad?: number;
};

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

export type DiagramNode = {
  id: string;
  label: string | DiagramLabelLine[];
  /** React content drawn inside the box; only HtmlGraphDiagram draws it. */
  content?: ReactNode;
  kind?: 'node' | 'appliance' | 'connector' | 'junction' | 'marker';
  row?: number | undefined;
  col?: number | undefined;
  colSpan?: number | undefined;
  width?: number;
  height?: number;
  frame?: 'solid' | 'transparent' | 'flat' | 'filled' | 'none';
  textColor?: DiagramTextColor | undefined;
  tone?: DiagramTone | undefined;
  texture?: DiagramTexture | undefined;
  fontWeight?: number | undefined;
  fontSize?: number | undefined;
  bodyFontSize?: number;
  bodyLineGap?: number;
  accent?: boolean | undefined;
  description?: string | string[];
  items?: string[];
  caption?: string | string[] | undefined;
  captionSide?: DiagramSide | undefined;
  captionFrame?: boolean;
  captionOffset?: number | undefined;
  captionColor?: DiagramTextColor | undefined;
  captionFontSize?: number | undefined;
  captionFontWeight?: number | undefined;
  group?: string;
  icon?: DiagramNodeIcon | undefined;
  iconSize?: number | undefined;
  ports?: DiagramNodePort[] | undefined;
  rx?: number;
  textAlign?: 'center' | 'start' | undefined;
  hidden?: boolean | undefined;
  connectable?: boolean | undefined;
  stack?: number;
  stackOffset?: number;
  stackDirection?: DiagramStackDirection;
  stackDx?: number;
  stackDy?: number;
  stackWidthStep?: number;
  stackHeightStep?: number;
  appliancePorts?: number | undefined;
  antenna?: boolean | undefined;
  slant?: number | undefined;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string[];
  badgeIcon?: DiagramNodeIcon;
  badgeLabel?: string[];
  badgeSide?: DiagramEdgeLabelSide;
  badgeOffset?: number;
  badgeDx?: number;
  badgeDy?: number;
  badgeT?: number;
  labelSide?: DiagramEdgeLabelSide;
  labelFontSize?: number;
  labelOffset?: number;
  labelT?: number;
  labelSegment?: number;
  labelDx?: number;
  labelDy?: number;
  labelAlign?: DiagramTextAlign;
  labelFrame?: boolean;
  labelFramePadding?: number;
  labelLineGap?: number;
  channel?: string;
  lineStyle?: DiagramEdgeLineStyle;
  direction?: DiagramEdgeDirection;
  layer?: DiagramEdgeLayer;
  route?: DiagramEdgeRoute;
  strokeWidth?: number;
  waypoints?: DiagramWaypoint[];
  exitSide?: DiagramSide;
  exitOffset?: number;
  entrySide?: DiagramSide;
  entryOffset?: number;
  entryGap?: number;
  stubDistance?: number;
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
  rx?: number | undefined;
  frame?: 'solid' | 'dashed' | 'none' | undefined;
  fill?: 'surface' | 'none' | undefined;
  ports?: DiagramNodePort[] | undefined;
  parent?: string | undefined;
  tight?: boolean | undefined;
  tightX?: boolean | undefined;
  tightY?: boolean | undefined;
  titleBand?: boolean | undefined;
  titleGap?: number | undefined;
  padding?: number | Partial<Record<DiagramSide, number>> | undefined;
  dividers?:
    | {
        rows?: number[];
        cols?: number[];
      }
    | undefined;
  bounds?:
    | {
        rowStart: number;
        rowEnd: number;
        colStart: number;
        colEnd: number;
      }
    | undefined;
};

export type DiagramAnnotationLeaderRoute = 'straight' | 'elbow';

export type DiagramAnnotationLeader = {
  target: string;
  anchor: DiagramAnchor;
  route: DiagramAnnotationLeaderRoute;
  from: Point;
  to: Point;
  points: Point[];
};

export type DiagramAnnotation = {
  x?: number;
  y?: number;
  target?: string;
  targets?: string[];
  anchor?: DiagramAnchor;
  guide?: string;
  offset?: number;
  dx?: number;
  dy?: number;
  text: string[];
  align?: DiagramTextAlign;
  color?: DiagramTextColor;
  fontWeight?: number;
  fontSize?: number;
  lineGap?: number;
  leader?: boolean;
  leaderGap?: number;
  leaderRoute?: DiagramAnnotationLeaderRoute;
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

export type DiagramGuide = {
  id?: string;
  orientation?: DiagramGuideOrientation;
  lane?: string;
  x?: number;
  y?: number;
  row?: number;
  col?: number;
  target?: string;
  anchor?: DiagramAnchor;
  gap?: number;
  dx?: number;
  dy?: number;
  yStart?: number;
  yEnd?: number;
  accent?: boolean;
};

export type DiagramMarker = DiagramNode;

export type DiagramGraphSpec = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[] | undefined;
  annotations?: DiagramAnnotation[];
  guides?: DiagramGuide[];
  layout?: DiagramGraphLayout | undefined;
};

export type GraphLayoutSpec = DiagramGraphSpec & { title?: string[] };

export type DiagramTimelineSpec = {
  lanes: DiagramLane[];
  signals: DiagramSignal[];
  frame?: DiagramFrameElement | undefined;
};

export type DiagramGraphIR = DiagramGraphSpec & {
  groups: DiagramGroup[];
  annotations: DiagramAnnotation[];
  guides: DiagramGuide[];
};
