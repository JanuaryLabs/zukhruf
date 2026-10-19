import { primitive } from '../compiler/diagram-compile.ts';
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
} from './diagram-types.ts';

export type {
  DiagramAccent,
  DiagramMode,
  DiagramStylePreset,
} from './chrome/index.ts';
export type { DiagramEffects } from '../renderers/types.ts';
export type {
  DiagramPaper,
  DiagramStackDirection,
  DiagramViewport,
} from '../model/diagram-ir.ts';
export type {
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
  DiagramProps,
  DiagramSignalProps,
  DiagramTextProps,
  DiagramWaypointProps,
} from './diagram-types.ts';

const Node = primitive<DiagramNodeProps>('node');
const Box = primitive<DiagramNodeProps>('box');
const Card = primitive<DiagramNodeProps>('card');
const Port = primitive<DiagramNodeProps>('port');
const Label = primitive<DiagramNodeProps>('label');
const Float = primitive<DiagramNodeProps>('float');
const Phantom = primitive<DiagramPhantomProps>('phantom');
const Appliance = primitive<DiagramApplianceProps>('appliance');
const Connector = primitive<DiagramConnectorProps>('connector');
const Junction = primitive<DiagramJunctionProps>('junction');
const Edge = primitive<DiagramEdgeProps>('edge');
const Arrow = primitive<DiagramEdgeProps>('arrow');
const Wire = primitive<DiagramEdgeProps>('wire');
const Group = primitive<DiagramGroupProps>('group');
const Text = primitive<DiagramTextProps>('text');
const Line = primitive<DiagramLineProps>('line');
const Lane = primitive<DiagramLaneProps>('lane');
const Signal = primitive<DiagramSignalProps>('signal');
const Frame = primitive<DiagramFrameProps>('frame');
const Marker = primitive<DiagramMarkerProps>('marker');
const Guide = primitive<DiagramGuideProps>('guide');
const Waypoint = primitive<DiagramWaypointProps>('waypoint');
const Entry = primitive<DiagramEntryProps>('entry');
const Exit = primitive<DiagramExitProps>('exit');
const Content = primitive<DiagramContentProps>('content');
const Note = Text;

export const Diagram = {
  Node,
  Edge,
  Group,
  Frame,
  Text,
  Line,
  Lane,
  Signal,
  Marker,
  Guide,
  Waypoint,
  Entry,
  Exit,
  Box,
  Card,
  Port,
  Label,
  Float,
  Phantom,
  Appliance,
  Connector,
  Junction,
  Wire,
  Arrow,
  Note,
  Content,
};
