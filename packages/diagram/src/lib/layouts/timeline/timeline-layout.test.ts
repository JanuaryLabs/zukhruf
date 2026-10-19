import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACTOR_H,
  ROW_H,
  SEQ_W,
  type TimelineLayoutSpec,
  buildTimelineSegments,
  computeBoxedSignal,
  computeTimelineLayout,
} from './timeline-layout.ts';

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  assert.ok(
    item !== undefined,
    `expected an item at ${index} of ${items.length}`,
  );
  return item;
}

const MULTI_LANE_WITH_FRAME: TimelineLayoutSpec = {
  title: [
    'Codex drives the app with Chrome',
    'DevTools MCP to validate its work',
  ],
  lanes: [
    { id: 'codex', label: ['CODEX'], accent: true },
    { id: 'app', label: ['APP'] },
    { id: 'chrome', label: ['CHROME', 'DEVTOOLS'] },
  ],
  signals: [
    {
      from: 'codex',
      to: 'chrome',
      label: ['Select target', '+ clear console'],
      accent: true,
    },
    { from: 'codex', to: 'chrome', label: ['Snapshot BEFORE'], accent: true },
    { from: 'codex', to: 'chrome', label: ['Trigger UI path'], accent: true },
    {
      from: 'app',
      to: 'chrome',
      label: ['Runtime events', '(during interaction)'],
      dim: true,
    },
    { from: 'codex', to: 'chrome', label: ['Snapshot AFTER'], accent: true },
    {
      from: 'codex',
      to: 'chrome',
      label: ['Apply fix + restart'],
      accent: true,
    },
  ],
  frame: {
    label: 'UNTIL CLEAN',
    signals: [
      {
        from: 'codex',
        to: 'chrome',
        label: ['Re-run validation'],
        accent: true,
      },
    ],
  },
};

test('actor count and IDs match spec', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  assert.equal(layout.lanes.length, MULTI_LANE_WITH_FRAME.lanes.length);
  assert.deepEqual(
    layout.lanes.map((a) => a.id),
    MULTI_LANE_WITH_FRAME.lanes.map((a) => a.id),
  );
});

test('actor centers are evenly distributed across diagram width', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  const xs = layout.lanes.map((a) => a.centerX);
  const total = xs.length;
  for (let i = 0; i < total; i++) {
    const expected = (SEQ_W / total) * i + SEQ_W / total / 2;
    assert.equal(
      xs[i],
      expected,
      `actor ${i} centerX should be ${expected}, got ${xs[i]}`,
    );
  }
  const firstGap = itemAt(xs, 1) - itemAt(xs, 0);
  for (let i = 1; i < total; i++) {
    const gap = itemAt(xs, i) - itemAt(xs, i - 1);
    assert.ok(
      Math.abs(gap - firstGap) < 1e-9,
      `gap between lanes ${i - 1}/${i} (${gap}) should equal first gap (${firstGap})`,
    );
  }
});

test('top lanes and bottom lanes mirror at top and bottom of diagram', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  for (const a of layout.lanes) {
    assert.ok(
      a.bottomRectY > a.topRectY,
      `${a.id} bottom y must be greater than top y`,
    );
    assert.ok(
      a.topRectY + ACTOR_H < a.bottomRectY,
      `${a.id} top actor sits above bottom actor with gap`,
    );
  }
});

test('signals stack vertically with constant ROW_H spacing', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  for (let i = 1; i < layout.signals.length; i++) {
    const delta =
      itemAt(layout.signals, i).rowY - itemAt(layout.signals, i - 1).rowY;
    assert.equal(
      delta,
      ROW_H,
      `message ${i} should be ROW_H below message ${i - 1}, got delta=${delta}`,
    );
  }
});

test('frame frame is positioned below last main message and bottom lanes below frame', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  assert.ok(layout.frame, 'spec has a frame');
  if (!layout.frame) return;

  const lastMainMsg = itemAt(layout.signals, -1);
  assert.ok(
    layout.frame.y > lastMainMsg.rowY,
    `frame top y (${layout.frame.y}) should be below last main message y (${lastMainMsg.rowY})`,
  );

  const frameBottom = layout.frame.y + layout.frame.height;
  for (const actor of layout.lanes) {
    assert.ok(
      actor.bottomRectY > frameBottom,
      `actor ${actor.id} bottom rect (${actor.bottomRectY}) should be below frame frame bottom (${frameBottom})`,
    );
  }
});

test('frame signals stack inside the frame frame and after the last main message', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  assert.ok(layout.frame);
  if (!layout.frame) return;

  const lastMainMsg = itemAt(layout.signals, -1);
  for (const lm of layout.frame.signals) {
    assert.ok(
      lm.rowY > lastMainMsg.rowY,
      `frame msg row y (${lm.rowY}) is below last main message`,
    );
    assert.ok(
      lm.rowY > layout.frame.y &&
        lm.rowY < layout.frame.y + layout.frame.height,
      'frame message y is within frame frame bounds',
    );
  }

  for (let i = 1; i < layout.frame.signals.length; i++) {
    const delta: number =
      itemAt(layout.frame.signals, i).rowY -
      itemAt(layout.frame.signals, i - 1).rowY;
    assert.equal(delta, ROW_H, 'frame signals have ROW_H spacing');
  }
});

test('segment timeline covers exactly [0, 1] with no gaps or overlaps', () => {
  const totalSignals = MULTI_LANE_WITH_FRAME.signals.length;
  const frameMsgs = MULTI_LANE_WITH_FRAME.frame?.signals.length ?? 0;
  const segments = buildTimelineSegments(totalSignals, true, frameMsgs);

  assert.equal(itemAt(segments, 0).start, 0, 'first segment starts at 0');
  assert.equal(itemAt(segments, -1).end, 1, 'last segment ends at 1');
  for (let i = 1; i < segments.length; i++) {
    assert.equal(
      itemAt(segments, i).start,
      itemAt(segments, i - 1).end,
      `segment ${i} starts where ${i - 1} ends (no gap, no overlap)`,
    );
    assert.ok(
      itemAt(segments, i).end > itemAt(segments, i).start,
      `segment ${i} has positive duration`,
    );
  }
});

test('segment count = 1 (top lanes) + N main + (1 frame frame + M frame msgs) + 1 (bottom lanes)', () => {
  const totalSignals = MULTI_LANE_WITH_FRAME.signals.length;
  const frameMsgs = MULTI_LANE_WITH_FRAME.frame?.signals.length ?? 0;
  const withLoop = buildTimelineSegments(totalSignals, true, frameMsgs);
  assert.equal(
    withLoop.length,
    1 + totalSignals + 1 + frameMsgs + 1,
    'segment count with frame',
  );

  const withoutLoop = buildTimelineSegments(totalSignals, false, 0);
  assert.equal(
    withoutLoop.length,
    1 + totalSignals + 1,
    'segment count without frame',
  );
});

test('spec without frame produces no frame in layout and no frame segments', () => {
  const noFrameTimeline: TimelineLayoutSpec = {
    title: ['Test'],
    lanes: [
      { id: 'a', label: ['A'] },
      { id: 'b', label: ['B'] },
    ],
    signals: [{ from: 'a', to: 'b', label: ['hello'] }],
  };

  const layout = computeTimelineLayout(noFrameTimeline);
  assert.equal(layout.frame, null, 'no frame in layout');

  const lastMainMsg = itemAt(layout.signals, -1);
  for (const actor of layout.lanes) {
    assert.ok(
      actor.bottomRectY > lastMainMsg.rowY,
      'bottom actor below last message even without frame',
    );
  }
});

test('lifelines span from below top lanes to top of bottom lanes', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  assert.ok(
    layout.lifelineYStart > itemAt(layout.lanes, 0).topRectY,
    'lifelines start below top actor rect top',
  );
  assert.ok(
    layout.lifelineYEnd <= itemAt(layout.lanes, 0).bottomRectY,
    'lifelines end at or before bottom actor top',
  );
  assert.ok(
    layout.lifelineYEnd > layout.lifelineYStart,
    'lifelines have positive length',
  );
});

test('every message references lanes that exist in the layout', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  const actorIds = new Set(layout.lanes.map((a) => a.id));
  for (const m of layout.signals) {
    assert.ok(
      actorIds.has(m.from),
      `message from "${m.from}" references unknown actor`,
    );
    assert.ok(
      actorIds.has(m.to),
      `message to "${m.to}" references unknown actor`,
    );
  }
});

test('computeBoxedSignal source-anchored L→R splits the path into source stub and target stub around the box', () => {
  const geom = computeBoxedSignal({
    fromX: 100,
    toX: 700,
    rowY: 300,
    boxW: 200,
    boxH: 60,
    stub: 12,
    position: 'source',
    headInset: 6,
  });

  assert.equal(geom.stubA.x1, 100, 'stubA starts at source lifeline');
  assert.equal(
    geom.stubA.x2,
    112,
    'stubA ends at box near edge (fromX + stub)',
  );
  assert.equal(geom.boxLeft, 112, 'box left edge sits at fromX + stub');
  assert.equal(geom.boxRight, 312, 'box right edge is boxLeft + boxW');
  assert.equal(geom.stubB.x1, 312, 'stubB starts at box far edge');
  assert.equal(
    geom.stubB.x2,
    694,
    'stubB ends just shy of target (toX - headInset)',
  );
  assert.equal(geom.boxTop, 270, 'box top is rowY - boxH/2');
  assert.equal(geom.boxBottom, 330, 'box bottom is rowY + boxH/2');
});

test('computeBoxedSignal source-anchored R→L mirrors the geometry: box hugs source on its left, arrow points left', () => {
  const geom = computeBoxedSignal({
    fromX: 700,
    toX: 100,
    rowY: 300,
    boxW: 200,
    boxH: 60,
    stub: 12,
    position: 'source',
    headInset: 6,
  });

  assert.equal(geom.stubA.x1, 700, 'stubA starts at source lifeline');
  assert.equal(
    geom.stubA.x2,
    688,
    'stubA ends at box near edge (fromX - stub)',
  );
  assert.equal(geom.boxRight, 688, 'box right edge sits at fromX - stub');
  assert.equal(geom.boxLeft, 488, 'box left edge is boxRight - boxW');
  assert.equal(
    geom.stubB.x1,
    488,
    'stubB starts at box far edge (boxLeft for R→L)',
  );
  assert.equal(
    geom.stubB.x2,
    106,
    'stubB ends just shy of target (toX + headInset)',
  );
});

test('computeBoxedSignal center-anchored places the box centered between source and target', () => {
  const geom = computeBoxedSignal({
    fromX: 100,
    toX: 700,
    rowY: 300,
    boxW: 200,
    boxH: 60,
    stub: 12,
    position: 'center',
    headInset: 6,
  });

  assert.equal(geom.boxLeft, 300, 'box left = midX - boxW/2');
  assert.equal(geom.boxRight, 500, 'box right = midX + boxW/2');
  assert.equal(geom.stubA.x1, 100, 'stubA starts at source lifeline');
  assert.equal(geom.stubA.x2, 300, 'stubA ends at boxLeft');
  assert.equal(geom.stubB.x1, 500, 'stubB starts at boxRight');
  assert.equal(geom.stubB.x2, 694, 'stubB ends at toX - headInset');
});

test('computeBoxedSignal target-anchored hugs target with short arrow stub on the target side', () => {
  const geom = computeBoxedSignal({
    fromX: 100,
    toX: 700,
    rowY: 300,
    boxW: 200,
    boxH: 60,
    stub: 12,
    position: 'target',
    headInset: 6,
  });

  assert.equal(geom.boxRight, 688, 'box right edge = toX - stub');
  assert.equal(geom.boxLeft, 488, 'box left edge = boxRight - boxW');
  assert.equal(geom.stubA.x1, 100, 'stubA starts at source lifeline');
  assert.equal(
    geom.stubA.x2,
    488,
    'stubA ends at boxLeft (long stub from source)',
  );
  assert.equal(geom.stubB.x1, 688, 'stubB starts at boxRight');
  assert.equal(
    geom.stubB.x2,
    694,
    'stubB ends at toX - headInset (short arrow into target)',
  );
});

test('computeBoxedSignal throws when the box cannot fit between source and target with stub and arrowhead', () => {
  assert.throws(
    () =>
      computeBoxedSignal({
        fromX: 100,
        toX: 200,
        rowY: 300,
        boxW: 200,
        boxH: 60,
        stub: 12,
        position: 'source',
        headInset: 6,
      }),
    /box .* overflows .* lane distance/i,
  );
});

test('message segment timing precedes frame frame, which precedes frame signals, which precedes bottom lanes', () => {
  const layout = computeTimelineLayout(MULTI_LANE_WITH_FRAME);
  assert.ok(layout.frame);
  if (!layout.frame) return;

  const lastMainMsg = itemAt(layout.signals, -1);
  assert.ok(
    lastMainMsg.segmentEnd <= layout.frame.segmentStart,
    'last main message ends at or before frame frame starts',
  );

  for (const lm of layout.frame.signals) {
    assert.ok(
      layout.frame.segmentEnd <= lm.segmentStart,
      'frame frame ends at or before each frame message starts',
    );
  }

  const lastLoopMsg = itemAt(layout.frame.signals, -1);
  assert.ok(
    lastLoopMsg.segmentEnd <= layout.bottomLanesSegment.start,
    'last frame message ends at or before bottom lanes start',
  );
});
