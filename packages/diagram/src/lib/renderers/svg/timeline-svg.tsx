import { type MotionValue, motion, useTransform } from 'motion/react';

import {
  compileTimeline,
  validateTimeline,
} from '../../compiler/diagram-compile.ts';
import {
  ACTOR_H,
  ACTOR_RX,
  ACTOR_W,
  DEFAULT_BOXED_STUB,
  FRAME_HEADER_H,
  type FramePlacement,
  type LanePlacement,
  SIGNAL_LABEL_BASELINE_GAP,
  SIGNAL_LABEL_FONT_SIZE,
  SIGNAL_LABEL_LINE_STEP,
  type SignalPlacement,
  type DiagramSignal as TimelineSignal,
  computeBoxedSignal,
  computeTimelineLayout,
  measureSignalLabel,
} from '../../layouts/timeline/timeline-layout.ts';
import type {
  DiagramPaper,
  DiagramTimelineSpec,
  DiagramViewport,
} from '../../model/diagram-ir.ts';
import {
  DIAGRAM_BG,
  DIAGRAM_DIM,
  DIAGRAM_LIFELINE,
  DIAGRAM_NEUTRAL,
  DIAGRAM_ON_ACCENT,
  DIAGRAM_TEXT,
  DiagramFrame,
  useDiagramTheme,
} from '../../react/chrome/index.ts';
import type { DiagramProps } from '../../react/diagram-types.ts';
import { DiagramDefs } from '../shared/defs.tsx';
import { DiagramPaperRect } from '../shared/paper.tsx';
import { svgViewportProps } from './viewport.ts';

// Measured in Chrome against StreamingTimelineDiagram: these land lane and
// boxed-signal text within 0.4px of centred. Unlike the graph renderer, every
// timeline text is mono at SIGNAL_LABEL_FONT_SIZE, so a fixed nudge stays
// correct here; derive from text-metrics.ts only if the size becomes variable.
function verticalTextOffset(lineCount: number): number {
  return lineCount === 1 ? 4 : -3;
}

function LaneBox({
  placement,
  label,
  y,
  progress,
  start,
  end,
}: {
  placement: LanePlacement;
  label: string[];
  y: number;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent, ids } = useDiagramTheme();
  const opacity = useTransform(progress, [start, end], [0, 1], {
    clamp: true,
  });
  const translateY = useTransform(progress, [start, end], [-10, 0], {
    clamp: true,
  });
  const stroke = placement.accent ? themeAccent : DIAGRAM_NEUTRAL;

  return (
    <motion.g style={{ opacity, y: translateY }}>
      <rect
        x={placement.rectX}
        y={y}
        width={ACTOR_W}
        height={ACTOR_H}
        rx={ACTOR_RX}
        fill={DIAGRAM_BG}
        stroke={stroke}
        strokeWidth={1.5}
      />
      <rect
        x={placement.rectX}
        y={y}
        width={ACTOR_W}
        height={ACTOR_H}
        rx={ACTOR_RX}
        fill={`url(#${ids.dots})`}
        pointerEvents="none"
      />
      <text
        x={placement.centerX}
        y={y + ACTOR_H / 2 + verticalTextOffset(label.length)}
        textAnchor="middle"
        fontFamily="ui-monospace, 'Geist Mono', monospace"
        fontSize={12}
        fontWeight={500}
        fill={DIAGRAM_TEXT}
        letterSpacing={1.4}
      >
        {label.map((line, i) => (
          <tspan key={i} x={placement.centerX} dy={i === 0 ? 0 : 15}>
            {line}
          </tspan>
        ))}
      </text>
    </motion.g>
  );
}

function SignalMessage({
  signal,
  placement,
  fromX,
  toX,
  progress,
}: {
  signal: TimelineSignal;
  placement: SignalPlacement;
  fromX: number;
  toX: number;
  progress: MotionValue<number>;
}) {
  const { accent: themeAccent, ids } = useDiagramTheme();
  const direction = toX > fromX ? 1 : -1;
  const headInset = 6;
  const stroke = signal.accent
    ? themeAccent
    : signal.dim
      ? DIAGRAM_DIM
      : DIAGRAM_NEUTRAL;
  const labelFill = signal.dim ? DIAGRAM_DIM : DIAGRAM_TEXT;
  const markerId = signal.accent
    ? ids.arrowAccent
    : signal.dim
      ? ids.arrowDim
      : ids.arrowNeutral;

  const labelLines = signal.label.length;
  const { segmentStart: start, segmentEnd: end, rowY } = placement;
  const drawEnd = start + (end - start) * 0.7;
  const labelStart = start + (end - start) * 0.45;

  const pathLength = useTransform(progress, [start, drawEnd], [0, 1], {
    clamp: true,
  });
  const pathOpacity = useTransform(progress, [start, start + 0.001], [0, 1], {
    clamp: true,
  });
  const labelOpacity = useTransform(progress, [labelStart, end], [0, 1], {
    clamp: true,
  });

  if (signal.boxed) {
    const { boxW, boxH } = measureSignalLabel(signal.label);
    const geom = computeBoxedSignal({
      fromX,
      toX,
      rowY,
      boxW,
      boxH,
      stub: signal.stub ?? DEFAULT_BOXED_STUB,
      position: signal.boxed,
      headInset,
    });
    const boxTextX = (geom.boxLeft + geom.boxRight) / 2;
    const boxTextY = geom.boxTop + boxH / 2 + verticalTextOffset(labelLines);
    const boxStroke = signal.bordered === false ? 'none' : stroke;

    return (
      <g>
        <motion.path
          d={`M ${geom.stubA.x1} ${rowY} L ${geom.stubA.x2} ${rowY}`}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          style={{ pathLength, opacity: pathOpacity }}
        />
        <motion.path
          d={`M ${geom.stubB.x1} ${rowY} L ${geom.stubB.x2} ${rowY}`}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          markerEnd={`url(#${markerId})`}
          style={{ pathLength, opacity: pathOpacity }}
        />
        <motion.g style={{ opacity: labelOpacity }}>
          <rect
            x={geom.boxLeft}
            y={geom.boxTop}
            width={boxW}
            height={boxH}
            rx={10}
            fill={signal.filled === false ? 'none' : DIAGRAM_BG}
            stroke={boxStroke}
            strokeWidth={1.5}
          />
          {signal.filled !== false && (
            <rect
              x={geom.boxLeft}
              y={geom.boxTop}
              width={boxW}
              height={boxH}
              rx={10}
              fill={`url(#${ids.dots})`}
              pointerEvents="none"
            />
          )}
          <text
            x={boxTextX}
            y={boxTextY}
            textAnchor="middle"
            fontFamily="ui-monospace, 'Geist Mono', monospace"
            fontSize={SIGNAL_LABEL_FONT_SIZE}
            fill={labelFill}
          >
            {signal.label.map((line, i) => (
              <tspan key={i} x={boxTextX} dy={i === 0 ? 0 : 15}>
                {line}
              </tspan>
            ))}
          </text>
        </motion.g>
      </g>
    );
  }

  const x2 = toX - direction * headInset;
  const labelStartX = direction > 0 ? fromX + 18 : fromX - 18;
  const labelAnchor: 'start' | 'end' = direction > 0 ? 'start' : 'end';
  const labelBaseY =
    rowY -
    SIGNAL_LABEL_BASELINE_GAP -
    (labelLines - 1) * SIGNAL_LABEL_LINE_STEP;

  return (
    <g>
      <motion.path
        d={`M ${fromX} ${rowY} L ${x2} ${rowY}`}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        markerEnd={`url(#${markerId})`}
        style={{ pathLength, opacity: pathOpacity }}
      />
      <motion.text
        style={{ opacity: labelOpacity }}
        x={labelStartX}
        y={labelBaseY}
        textAnchor={labelAnchor}
        fontFamily="ui-monospace, 'Geist Mono', monospace"
        fontSize={SIGNAL_LABEL_FONT_SIZE}
        fill={labelFill}
      >
        {signal.label.map((line, i) => (
          <tspan
            key={i}
            x={labelStartX}
            dy={i === 0 ? 0 : SIGNAL_LABEL_LINE_STEP}
          >
            {line}
          </tspan>
        ))}
      </motion.text>
    </g>
  );
}

function Lifeline({
  x,
  yStart,
  yEnd,
  accent,
  progress,
  start,
  end,
}: {
  x: number;
  yStart: number;
  yEnd: number;
  accent: boolean;
  progress: MotionValue<number>;
  start: number;
  end: number;
}) {
  const { accent: themeAccent } = useDiagramTheme();
  const pathLength = useTransform(progress, [start, end], [0, 1], {
    clamp: true,
  });
  return (
    <motion.line
      x1={x}
      y1={yStart}
      x2={x}
      y2={yEnd}
      stroke={accent ? themeAccent : DIAGRAM_LIFELINE}
      strokeWidth={accent ? 1.5 : 1}
      style={{ pathLength }}
    />
  );
}

function FrameBox({
  frame,
  progress,
}: {
  frame: FramePlacement;
  progress: MotionValue<number>;
}) {
  const { accent: themeAccent, ids } = useDiagramTheme();
  const opacity = useTransform(
    progress,
    [frame.segmentStart, frame.segmentEnd],
    [0, 1],
    { clamp: true },
  );
  return (
    <motion.g style={{ opacity }}>
      <rect
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        rx={6}
        fill={DIAGRAM_BG}
        stroke={themeAccent}
        strokeWidth={1.5}
      />
      <rect
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        rx={6}
        fill={`url(#${ids.dots})`}
        pointerEvents="none"
      />
      <rect
        x={frame.x}
        y={frame.y}
        width={64}
        height={FRAME_HEADER_H}
        fill={themeAccent}
      />
      <text
        x={frame.x + 32}
        y={frame.y + 16}
        textAnchor="middle"
        fontFamily="ui-monospace, 'Geist Mono', monospace"
        fontSize={10}
        fontWeight={600}
        fill={DIAGRAM_ON_ACCENT}
        letterSpacing={1.2}
      >
        FRAME
      </text>
      <text
        x={frame.x + frame.width / 2}
        y={frame.y + 16}
        textAnchor="middle"
        fontFamily="ui-monospace, 'Geist Mono', monospace"
        fontSize={10}
        fontWeight={500}
        fill={DIAGRAM_TEXT}
        letterSpacing={2}
      >
        {frame.label}
      </text>
    </motion.g>
  );
}

export type SvgTimelineDiagramProps = DiagramProps;

export function SvgTimelineDiagram({
  title,
  children,
  viewport,
  paper,
  ...chrome
}: SvgTimelineDiagramProps) {
  const ir = compileTimeline(children);
  const lines = [title].flat();
  return (
    <DiagramFrame title={lines} fit={viewport?.fit} {...chrome}>
      {(progress) => (
        <TimelineSVG
          ir={ir}
          title={lines}
          progress={progress}
          viewport={viewport}
          paper={paper}
        />
      )}
    </DiagramFrame>
  );
}

function TimelineSVG({
  ir,
  title,
  progress,
  viewport,
  paper,
}: {
  ir: DiagramTimelineSpec;
  title: string[];
  progress: MotionValue<number>;
  viewport?: DiagramViewport | undefined;
  paper?: DiagramPaper | undefined;
}) {
  const { stylePreset } = useDiagramTheme();
  validateTimeline(ir);
  const layout = computeTimelineLayout(ir);
  const laneById = new Map(layout.lanes.map((a) => [a.id, a]));
  const labelById = new Map(ir.lanes.map((a) => [a.id, a.label]));
  const viewportProps = svgViewportProps(
    { w: layout.width, h: layout.height },
    viewport,
  );

  return (
    <svg
      data-diagram-style-preset={stylePreset}
      {...viewportProps}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={title.join(' ')}
    >
      <title>{title.join(' ')}</title>
      <DiagramDefs />
      <DiagramPaperRect
        kind="timeline"
        paper={paper}
        width={layout.width}
        height={layout.height}
      />

      {layout.lanes.map((lane) => (
        <Lifeline
          key={`life-${lane.id}`}
          x={lane.centerX}
          yStart={layout.lifelineYStart}
          yEnd={layout.lifelineYEnd}
          accent={lane.accent}
          progress={progress}
          start={layout.topLanesSegment.start}
          end={layout.topLanesSegment.end}
        />
      ))}

      {layout.lanes.map((lane) => (
        <LaneBox
          key={`top-${lane.id}`}
          placement={lane}
          label={labelById.get(lane.id) ?? [lane.id]}
          y={lane.topRectY}
          progress={progress}
          start={layout.topLanesSegment.start}
          end={layout.topLanesSegment.end}
        />
      ))}

      {layout.signals.map((signal, i) => {
        const fromLane = laneById.get(signal.from);
        const toLane = laneById.get(signal.to);
        const source = ir.signals[i];
        if (!fromLane || !toLane || !source) return null;
        return (
          <SignalMessage
            key={`signal-${i}`}
            signal={source}
            placement={signal}
            fromX={fromLane.centerX}
            toX={toLane.centerX}
            progress={progress}
          />
        );
      })}

      {layout.frame && ir.frame && (
        <>
          <FrameBox frame={layout.frame} progress={progress} />
          {layout.frame.signals.map((signal, i) => {
            const fromLane = laneById.get(signal.from);
            const toLane = laneById.get(signal.to);
            const specSignal = ir.frame?.signals[i];
            if (!fromLane || !toLane || !specSignal) return null;
            return (
              <SignalMessage
                key={`frame-signal-${i}`}
                signal={specSignal}
                placement={signal}
                fromX={fromLane.centerX}
                toX={toLane.centerX}
                progress={progress}
              />
            );
          })}
        </>
      )}

      {layout.lanes.map((lane) => (
        <LaneBox
          key={`bottom-${lane.id}`}
          placement={lane}
          label={labelById.get(lane.id) ?? [lane.id]}
          y={lane.bottomRectY}
          progress={progress}
          start={layout.bottomLanesSegment.start}
          end={layout.bottomLanesSegment.end}
        />
      ))}
    </svg>
  );
}
