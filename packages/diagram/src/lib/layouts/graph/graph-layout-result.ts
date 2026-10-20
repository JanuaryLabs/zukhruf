import type {
  Box,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  DiagramSide,
  DiagramTextColor,
  Point,
} from '../../model/diagram-ir.ts';
import type { Font } from '../text/font.ts';

export type TextAnchor = 'start' | 'middle' | 'end';

export type TextRun = {
  text: string;
  x: number;
  /** The baseline. */
  y: number;
  anchor: TextAnchor;
  font: Font;
  color?: DiagramTextColor;
  /** The ink box the engine measured. */
  bounds: Box;
};

export type PortLayout = {
  id: string;
  side: DiagramSide;
  point: Point;
  label?: TextRun;
};

export type NodeLayout = {
  node: DiagramNode;
  /** The frame. */
  box: Box;
  /** The frame, the stacked back frames and the caption together. */
  visual: Box;
  /** The stacked back frames. */
  frames: Box[];
  radius: number;
  icon?: { x: number; y: number; size: number };
  text: TextRun[];
  bullets: Point[];
  caption?: { box: Box; framed: boolean; text: TextRun[] };
  ports: PortLayout[];
  appliance?: {
    body: Point[];
    /** The line under the front edge of the body. */
    face: [Point, Point];
    antenna: [Point, Point][];
    jacks: Box[];
  };
};

export type GroupLayout = {
  group: DiagramGroup;
  depth: number;
  rect: Box;
  /** The title band, inside `rect`. */
  band?: Box;
  label: TextRun[];
  dividers: [Point, Point][];
  ports: PortLayout[];
};

export type EdgeLabelLayout = {
  box: Box;
  text: TextRun[];
  /** The index of the route segment that the label sits beside. */
  segment?: number;
};

export type EdgeLayout = {
  edge: DiagramEdge;
  exitSide: DiagramSide;
  entrySide: DiagramSide;
  points: Point[];
  d: string;
  label?: EdgeLabelLayout;
  badge?: { box: Box; icon?: Box; text: TextRun[] };
};

export type LeaderLayout = {
  /** The id of the note node. */
  note: string;
  /** The id of the node or group that the note explains. */
  target: string;
  points: Point[];
  d: string;
};

export type GraphLayout = {
  nodes: NodeLayout[];
  groups: GroupLayout[];
  edges: EdgeLayout[];
  leaders: LeaderLayout[];
  viewBox: Box;
};
