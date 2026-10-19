import type { ReactNode } from 'react';

import type {
  DiagramAnnotation,
  DiagramEdge,
  DiagramGroup,
  DiagramGuide,
  DiagramLane,
  DiagramNode,
  DiagramNodeIcon as DiagramNodeIconName,
  DiagramPaper,
  DiagramSide,
  DiagramSignal,
  DiagramSignalBox,
  DiagramTextColor,
  DiagramTexture,
  DiagramTone,
  DiagramViewport,
  DiagramWaypoint,
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

export type DiagramNodeProps = ChildrenProp &
  Omit<DiagramNode, 'label' | 'frame' | 'hidden' | 'connectable'> & {
    frame?: DiagramNode['frame'];
    connectable?: boolean;
    hidden?: boolean;
  };

export type DiagramPhantomProps = ChildrenProp &
  Pick<
    DiagramNode,
    | 'id'
    | 'row'
    | 'col'
    | 'group'
    | 'width'
    | 'height'
    | 'fontSize'
    | 'fontWeight'
    | 'textColor'
    | 'accent'
    | 'textAlign'
    | 'connectable'
    | 'hidden'
  >;

export type DiagramJunctionProps = ChildrenProp &
  Pick<
    DiagramNode,
    | 'id'
    | 'row'
    | 'col'
    | 'group'
    | 'width'
    | 'height'
    | 'fontSize'
    | 'fontWeight'
    | 'textColor'
    | 'accent'
    | 'tone'
    | 'hidden'
    | 'caption'
    | 'captionSide'
    | 'captionFrame'
    | 'captionOffset'
    | 'captionColor'
    | 'captionFontSize'
    | 'captionFontWeight'
  >;

export type DiagramConnectorProps = ChildrenProp &
  Pick<
    DiagramNode,
    | 'id'
    | 'row'
    | 'col'
    | 'colSpan'
    | 'group'
    | 'width'
    | 'height'
    | 'fontSize'
    | 'fontWeight'
    | 'textColor'
    | 'accent'
    | 'tone'
    | 'texture'
    | 'icon'
    | 'iconSize'
    | 'ports'
    | 'rx'
    | 'caption'
    | 'captionSide'
    | 'captionFrame'
    | 'captionOffset'
    | 'captionColor'
    | 'captionFontSize'
    | 'captionFontWeight'
  >;

export type DiagramApplianceProps = ChildrenProp &
  Pick<
    DiagramNode,
    | 'id'
    | 'row'
    | 'col'
    | 'group'
    | 'width'
    | 'height'
    | 'fontSize'
    | 'fontWeight'
    | 'textColor'
    | 'accent'
    | 'tone'
    | 'texture'
    | 'ports'
    | 'caption'
    | 'captionSide'
    | 'captionFrame'
    | 'captionOffset'
    | 'captionColor'
    | 'captionFontSize'
    | 'captionFontWeight'
    | 'appliancePorts'
    | 'antenna'
    | 'slant'
  >;

export type DiagramEdgeProps = ChildrenProp &
  Omit<DiagramEdge, 'label' | 'waypoints' | 'badgeLabel'> & {
    waypoints?: DiagramWaypoint[];
    badgeLabel?: string | string[];
  };

export type DiagramGroupProps = ChildrenProp & {
  id: string;
  label?: string | string[];
  labelAlign?: DiagramGroup['labelAlign'];
  labelSide?: DiagramGroup['labelSide'];
  accent?: boolean;
  tone?: DiagramTone;
  texture?: DiagramTexture;
  rx?: number;
  frame?: DiagramGroup['frame'];
  fill?: DiagramGroup['fill'];
  ports?: DiagramGroup['ports'];
  tight?: boolean;
  tightX?: boolean;
  tightY?: boolean;
  titleBand?: boolean;
  titleGap?: number;
  padding?: DiagramGroup['padding'];
  dividers?: DiagramGroup['dividers'];
  rowStart?: number;
  rowEnd?: number;
  colStart?: number;
  colEnd?: number;
};

export type DiagramTextProps = ChildrenProp &
  Omit<DiagramAnnotation, 'text'> & {
    guide?: string;
  };

export type DiagramContentProps = { children: ReactNode };

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

export type DiagramGuideProps = DiagramGuide;

export type DiagramWaypointProps = DiagramWaypoint;

export type DiagramEntryProps = {
  side: DiagramSide;
  gap?: number;
};

export type DiagramExitProps = {
  side: DiagramSide;
};
