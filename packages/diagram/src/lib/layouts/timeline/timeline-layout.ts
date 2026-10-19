import type {
  DiagramSignal,
  DiagramSignalBox,
  DiagramTimelineSpec,
} from '../../model/diagram-ir.ts';
import { textAscent, widestLine } from '../text-metrics.ts';

export type {
  DiagramFrameElement,
  DiagramLane,
  DiagramSignal,
  DiagramSignalBox,
} from '../../model/diagram-ir.ts';

export type TimelineLayoutSpec = DiagramTimelineSpec & { title?: string[] };

export const SEQ_W = 1000;
export const ACTOR_W = 190;
export const ACTOR_H = 72;
export const ACTOR_RX = 16;
export const TOP_ACTOR_Y = 30;
export const ROW_H = 70;
export const FIRST_MSG_Y = 200;
export const LOOP_TOP_PAD = 38;
export const LOOP_X_PAD = 24;
export const FRAME_HEADER_H = 22;
export const FRAME_PAD = 12;
export const BOTTOM_ACTOR_GAP = 50;
export const DEFAULT_BOXED_STUB = 12;
export const SIGNAL_LABEL_FONT_SIZE = 12;
export const SIGNAL_LABEL_PAD_X = 14;
export const SIGNAL_LABEL_PAD_Y = 10;
export const SIGNAL_LABEL_LINE_H = 18;
export const SIGNAL_LABEL_BASELINE_GAP = 12;
export const SIGNAL_LABEL_LINE_STEP = 15;

export type SegmentKind =
  'top-lanes' | 'msg' | 'frame-frame' | 'frame-msg' | 'bottom-lanes';

export type LayoutSegment = {
  kind: SegmentKind;
  index: number;
  start: number;
  end: number;
};

export function buildTimelineSegments(
  totalSignals: number,
  hasLoop: boolean,
  frameMsgs: number,
): LayoutSegment[] {
  const slotCount = 1 + totalSignals + (hasLoop ? 1 + frameMsgs : 0) + 1;
  const step = 1 / slotCount;
  let i = 0;
  const segments: LayoutSegment[] = [];
  segments.push({
    kind: 'top-lanes',
    index: 0,
    start: i * step,
    end: ++i * step,
  });
  for (let m = 0; m < totalSignals; m++) {
    segments.push({ kind: 'msg', index: m, start: i * step, end: ++i * step });
  }
  if (hasLoop) {
    segments.push({
      kind: 'frame-frame',
      index: 0,
      start: i * step,
      end: ++i * step,
    });
    for (let m = 0; m < frameMsgs; m++) {
      segments.push({
        kind: 'frame-msg',
        index: m,
        start: i * step,
        end: ++i * step,
      });
    }
  }
  segments.push({
    kind: 'bottom-lanes',
    index: 0,
    start: i * step,
    end: (i + 1) * step,
  });
  return segments;
}

export type BoxedSegment = {
  boxLeft: number;
  boxRight: number;
  boxTop: number;
  boxBottom: number;
  stubA: { x1: number; x2: number };
  stubB: { x1: number; x2: number };
};

export function measureSignalLabel(label: string[]): {
  boxW: number;
  boxH: number;
} {
  return {
    boxW:
      Math.ceil(widestLine(label, SIGNAL_LABEL_FONT_SIZE, 'mono')) +
      SIGNAL_LABEL_PAD_X * 2,
    boxH: label.length * SIGNAL_LABEL_LINE_H + SIGNAL_LABEL_PAD_Y * 2,
  };
}

/** Distance from a signal's row up to the top of its label or label box. */
export function signalLabelHeadroom(
  signal: Pick<DiagramSignal, 'label' | 'boxed'>,
): number {
  if (signal.boxed) return measureSignalLabel(signal.label).boxH / 2;
  return (
    SIGNAL_LABEL_BASELINE_GAP +
    (signal.label.length - 1) * SIGNAL_LABEL_LINE_STEP +
    textAscent(SIGNAL_LABEL_FONT_SIZE, 'mono')
  );
}

/** Distance from a signal's row down to the bottom of its label box. */
export function signalLabelFootroom(
  signal: Pick<DiagramSignal, 'label' | 'boxed'>,
): number {
  return signal.boxed ? measureSignalLabel(signal.label).boxH / 2 : 0;
}

export function computeBoxedSignal(args: {
  fromX: number;
  toX: number;
  rowY: number;
  boxW: number;
  boxH: number;
  stub: number;
  position: DiagramSignalBox;
  headInset: number;
}): BoxedSegment {
  const { fromX, toX, rowY, boxW, boxH, stub, position, headInset } = args;
  const direction = toX > fromX ? 1 : -1;

  let nearEdge: number;
  switch (position) {
    case 'source':
      nearEdge = fromX + stub * direction;
      break;
    case 'center':
      nearEdge = (fromX + toX) / 2 - (boxW / 2) * direction;
      break;
    case 'target':
      nearEdge = toX - (stub + boxW) * direction;
      break;
    default: {
      const _exhaustive: never = position;
      throw new Error(`invalid boxed signal position: ${String(_exhaustive)}`);
    }
  }
  const farEdge = nearEdge + boxW * direction;

  const stubA = { x1: fromX, x2: nearEdge };
  const stubB = { x1: farEdge, x2: toX - headInset * direction };

  const stubALen = (stubA.x2 - stubA.x1) * direction;
  const stubBLen = (stubB.x2 - stubB.x1) * direction;
  if (stubALen < 0 || stubBLen < 0) {
    throw new Error(
      `boxed signal label box (width=${boxW}) overflows the lane distance |toX-fromX|=${Math.abs(toX - fromX)} with stub=${stub}, position=${position}`,
    );
  }

  return {
    boxLeft: Math.min(nearEdge, farEdge),
    boxRight: Math.max(nearEdge, farEdge),
    boxTop: rowY - boxH / 2,
    boxBottom: rowY + boxH / 2,
    stubA,
    stubB,
  };
}

export function laneCenterX(index: number, total: number): number {
  const slot = SEQ_W / total;
  return slot * index + slot / 2;
}

export type LanePlacement = {
  id: string;
  centerX: number;
  rectX: number;
  topRectY: number;
  bottomRectY: number;
  accent: boolean;
};

export type SignalPlacement = {
  index: number;
  from: string;
  to: string;
  rowY: number;
  segmentStart: number;
  segmentEnd: number;
};

export type FramePlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  segmentStart: number;
  segmentEnd: number;
  signals: SignalPlacement[];
};

export type TimelineLayout = {
  width: number;
  height: number;
  lanes: LanePlacement[];
  lifelineYStart: number;
  lifelineYEnd: number;
  signals: SignalPlacement[];
  frame: FramePlacement | null;
  topLanesSegment: { start: number; end: number };
  bottomLanesSegment: { start: number; end: number };
};

export function computeTimelineLayout(
  spec: TimelineLayoutSpec,
): TimelineLayout {
  const totalLanes = spec.lanes.length;
  const totalSignals = spec.signals.length;
  const hasLoop = !!spec.frame;
  const frameMsgs = spec.frame?.signals.length ?? 0;

  const segments = buildTimelineSegments(totalSignals, hasLoop, frameMsgs);
  const segOf = (kind: SegmentKind, index = 0) => {
    const s = segments.find((s) => s.kind === kind && s.index === index);
    if (!s) throw new Error(`segment ${kind}[${index}] missing`);
    return s;
  };

  const lifelineYStart = TOP_ACTOR_Y + ACTOR_H;
  const mainMsgY = (i: number) => FIRST_MSG_Y + i * ROW_H;
  const lastMainMsgY =
    spec.signals.length > 0 ? mainMsgY(spec.signals.length - 1) : FIRST_MSG_Y;

  let frame: FramePlacement | null = null;
  let frameBottom = lastMainMsgY;

  if (hasLoop && spec.frame) {
    const frameY = lastMainMsgY + LOOP_TOP_PAD;
    const [firstFrameSignal] = spec.frame.signals;
    const [lastFrameSignal] = spec.frame.signals.slice(-1);
    const firstRowOffset =
      FRAME_HEADER_H +
      FRAME_PAD +
      (firstFrameSignal ? signalLabelHeadroom(firstFrameSignal) : 0);
    const lastRowOffset = firstRowOffset + Math.max(0, frameMsgs - 1) * ROW_H;
    const frameH =
      lastRowOffset +
      (lastFrameSignal ? signalLabelFootroom(lastFrameSignal) : 0) +
      FRAME_PAD;
    frameBottom = frameY + frameH;
    const seg = segOf('frame-frame');
    frame = {
      x: LOOP_X_PAD,
      y: frameY,
      width: SEQ_W - 2 * LOOP_X_PAD,
      height: frameH,
      label: spec.frame.label,
      segmentStart: seg.start,
      segmentEnd: seg.end,
      signals: spec.frame.signals.map((m, i) => {
        const ms = segOf('frame-msg', i);
        return {
          index: i,
          from: m.from,
          to: m.to,
          rowY: frameY + firstRowOffset + i * ROW_H,
          segmentStart: ms.start,
          segmentEnd: ms.end,
        };
      }),
    };
  }

  const bottomActorY = frameBottom + BOTTOM_ACTOR_GAP;
  const lifelineYEnd = bottomActorY;
  const totalH = bottomActorY + ACTOR_H + 30;

  const lanes: LanePlacement[] = spec.lanes.map((a, i) => {
    const cx = laneCenterX(i, totalLanes);
    return {
      id: a.id,
      centerX: cx,
      rectX: cx - ACTOR_W / 2,
      topRectY: TOP_ACTOR_Y,
      bottomRectY: bottomActorY,
      accent: !!a.accent,
    };
  });

  const signals: SignalPlacement[] = spec.signals.map((m, i) => {
    const seg = segOf('msg', i);
    return {
      index: i,
      from: m.from,
      to: m.to,
      rowY: mainMsgY(i),
      segmentStart: seg.start,
      segmentEnd: seg.end,
    };
  });

  return {
    width: SEQ_W,
    height: totalH,
    lanes,
    lifelineYStart,
    lifelineYEnd,
    signals,
    frame,
    topLanesSegment: {
      start: segOf('top-lanes').start,
      end: segOf('top-lanes').end,
    },
    bottomLanesSegment: {
      start: segOf('bottom-lanes').start,
      end: segOf('bottom-lanes').end,
    },
  };
}
