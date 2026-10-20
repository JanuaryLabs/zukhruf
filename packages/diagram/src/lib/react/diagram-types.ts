import type { ReactNode } from 'react';

import type {
  DiagramEdge,
  DiagramGroup,
  DiagramLane,
  DiagramNode,
  DiagramNodeContent,
  DiagramNodeIcon as DiagramNodeIconName,
  DiagramPaper,
  DiagramSignal,
  DiagramSignalBox,
  DiagramTextColor,
  DiagramTexture,
  DiagramTone,
  DiagramViewport,
} from '../model/diagram-ir.ts';
import type {
  DiagramAccent,
  DiagramMode,
  DiagramStylePreset,
} from './chrome/index.ts';

type ChildrenProp = { children?: ReactNode };

export type DiagramProps = {
  title: string | string[];
  children: ReactNode;
  defaultMode?: DiagramMode;
  controls?: boolean;
  showHeader?: boolean;
  className?: string;
  corner?: ReactNode;
  accent?: DiagramAccent;
  stylePreset?: DiagramStylePreset;
  viewport?: DiagramViewport;
  paper?: DiagramPaper;
};

/** The grid area every node primitive takes: whole cells, with spans of at least 1. */
type CellProps = Pick<DiagramNode, 'id' | 'rowSpan' | 'colSpan'> & {
  row: number;
  col: number;
};

type CaptionProps = Pick<
  DiagramNode,
  'caption' | 'captionSide' | 'captionFrame' | 'captionColor'
>;

export type DiagramNodeProps = ChildrenProp &
  CellProps &
  CaptionProps &
  Pick<
    DiagramNode,
    | 'frame'
    | 'textColor'
    | 'tone'
    | 'texture'
    | 'accent'
    | 'description'
    | 'items'
    | 'icon'
    | 'ports'
    | 'hidden'
    | 'stack'
    | 'stackDirection'
  >;

export type DiagramJunctionProps = ChildrenProp &
  CellProps &
  CaptionProps &
  Pick<DiagramNode, 'textColor' | 'accent' | 'tone' | 'hidden'>;

export type DiagramConnectorProps = ChildrenProp &
  CellProps &
  CaptionProps &
  Pick<
    DiagramNode,
    'textColor' | 'accent' | 'tone' | 'texture' | 'icon' | 'ports'
  >;

export type DiagramApplianceProps = ChildrenProp &
  CellProps &
  CaptionProps &
  Pick<
    DiagramNode,
    | 'textColor'
    | 'accent'
    | 'tone'
    | 'texture'
    | 'ports'
    | 'appliancePorts'
    | 'antenna'
  >;

/** A frameless text in a cell; with a target, a leader runs from it to that node or group. */
export type DiagramNoteProps = ChildrenProp &
  CellProps &
  Pick<DiagramNode, 'target'>;

export type DiagramEdgeProps = ChildrenProp &
  Omit<DiagramEdge, 'label' | 'badgeLabel'> & {
    badgeLabel?: string | string[];
  };

export type DiagramGroupProps = ChildrenProp &
  Pick<
    DiagramGroup,
    | 'id'
    | 'labelAlign'
    | 'labelSide'
    | 'accent'
    | 'tone'
    | 'texture'
    | 'frame'
    | 'fill'
    | 'ports'
    | 'row'
    | 'col'
    | 'rowSpan'
    | 'colSpan'
    | 'titleBand'
    | 'dividers'
  > & {
    label?: string | string[];
  };

/** The engine cannot measure React content, so the author gives the size of the box it reserves. */
export type DiagramContentProps = {
  size: DiagramNodeContent['size'];
  children: ReactNode;
};

export type DiagramLineProps = ChildrenProp & {
  textColor?: DiagramTextColor;
  fontWeight?: number;
};

export type DiagramLaneProps = ChildrenProp &
  Pick<DiagramLane, 'id' | 'accent'>;

export type DiagramSignalProps = ChildrenProp &
  Omit<DiagramSignal, 'label' | 'boxed'> & {
    boxed?: boolean | DiagramSignalBox;
  };

export type DiagramFrameProps = ChildrenProp & {
  label: string;
};

export type DiagramMarkerProps = DiagramNodeProps & {
  icon: DiagramNodeIconName;
};
