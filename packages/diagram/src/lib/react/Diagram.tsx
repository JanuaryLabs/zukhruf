import { primitive } from '../compiler/diagram-compile.ts';
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
  DiagramFrameProps,
  DiagramGroupProps,
  DiagramJunctionProps,
  DiagramLaneProps,
  DiagramLineProps,
  DiagramMarkerProps,
  DiagramNodeProps,
  DiagramNoteProps,
  DiagramProps,
  DiagramSignalProps,
} from './diagram-types.ts';

const Node = primitive<DiagramNodeProps>('node');
const Box = primitive<DiagramNodeProps>('box');
const Card = primitive<DiagramNodeProps>('card');
const Port = primitive<DiagramNodeProps>('port');
const Label = primitive<DiagramNodeProps>('label');
const Float = primitive<DiagramNodeProps>('float');
const Appliance = primitive<DiagramApplianceProps>('appliance');
const Connector = primitive<DiagramConnectorProps>('connector');
const Junction = primitive<DiagramJunctionProps>('junction');
const Edge = primitive<DiagramEdgeProps>('edge');
const Arrow = primitive<DiagramEdgeProps>('arrow');
const Wire = primitive<DiagramEdgeProps>('wire');
const Group = primitive<DiagramGroupProps>('group');
const Note = primitive<DiagramNoteProps>('note');
const Line = primitive<DiagramLineProps>('line');
const Lane = primitive<DiagramLaneProps>('lane');
const Signal = primitive<DiagramSignalProps>('signal');
const Frame = primitive<DiagramFrameProps>('frame');
const Marker = primitive<DiagramMarkerProps>('marker');
const Content = primitive<DiagramContentProps>('content');

export const Diagram = {
  Node,
  Edge,
  Group,
  Frame,
  Line,
  Lane,
  Signal,
  Marker,
  Box,
  Card,
  Port,
  Label,
  Float,
  Appliance,
  Connector,
  Junction,
  Wire,
  Arrow,
  Note,
  Content,
};
