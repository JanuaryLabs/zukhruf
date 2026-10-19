import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTENT_VIEWBOX_PAD,
  ENTRY_GAP,
  type GraphLayoutSpec,
  NODE_RX,
  PARALLEL_SPACING,
  type Point,
  ROUTE_CELL,
  type RoutedEdge,
  computePaths,
  graphContentViewBox,
  groupBox,
  nodeBox,
  svgDimensions,
} from './graph-layout.ts';

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  assert.ok(
    item !== undefined,
    `expected an item at ${index} of ${items.length}`,
  );
  return item;
}

function labelY(edge: RoutedEdge) {
  assert.ok(
    edge.labelPlacement,
    `expected a label on ${edge.edge.from}->${edge.edge.to}`,
  );
  return edge.labelPlacement.y;
}

export const GRAPH: GraphLayoutSpec = {
  title: [
    'Layered domain architecture with',
    'explicit cross-cutting boundaries',
  ],
  groups: [
    {
      id: 'business',
      label: 'Business logic domain',
      bounds: { rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 2 },
    },
  ],
  nodes: [
    { id: 'utils', label: 'Utils', row: 0, col: 0 },
    { id: 'providers', label: 'Providers', row: 1, col: 0, group: 'business' },
    {
      id: 'appwiring',
      label: 'App Wiring + UI',
      row: 1,
      col: 1,
      colSpan: 2,
      group: 'business',
    },
    { id: 'service', label: 'Service', row: 2, col: 0, group: 'business' },
    { id: 'runtime', label: 'Runtime', row: 2, col: 1, group: 'business' },
    { id: 'ui', label: 'UI', row: 2, col: 2, group: 'business' },
    { id: 'types', label: 'Types', row: 3, col: 0, group: 'business' },
    { id: 'config', label: 'Config', row: 3, col: 1, group: 'business' },
    { id: 'repo', label: 'Repo', row: 3, col: 2, group: 'business' },
  ],
  edges: [
    { from: 'utils', to: 'providers' },
    { from: 'providers', to: 'appwiring' },
    { from: 'providers', to: 'service' },
    { from: 'service', to: 'runtime' },
    { from: 'runtime', to: 'ui' },
    { from: 'runtime', to: 'appwiring' },
    { from: 'types', to: 'config' },
    { from: 'config', to: 'repo' },
    { from: 'repo', to: 'service' },
  ],
};

function graphNode(id: string) {
  const node = GRAPH.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `expected node ${id} in GRAPH`);
  return node;
}

function findEdge(routed: RoutedEdge[], from: string, to: string): RoutedEdge {
  const e = routed.find((r) => r.edge.from === from && r.edge.to === to);
  if (!e) throw new Error(`edge ${from}->${to} missing`);
  return e;
}

function lastSegment(points: Point[]): { dx: number; dy: number } {
  assert.ok(points.length >= 2, 'path has at least two points');
  const last = itemAt(points, -1);
  const prev = itemAt(points, -2);
  return { dx: Math.sign(last.x - prev.x), dy: Math.sign(last.y - prev.y) };
}

function firstSegment(points: Point[]): { dx: number; dy: number } {
  assert.ok(points.length >= 2, 'path has at least two points');
  const first = itemAt(points, 0);
  const second = itemAt(points, 1);
  return {
    dx: Math.sign(second.x - first.x),
    dy: Math.sign(second.y - first.y),
  };
}

test('graph content viewBox crops unused grid space around visible content', () => {
  const spec: GraphLayoutSpec = {
    title: ['content fit'],
    nodes: [{ id: 'app', label: 'APP', row: 0, col: 0 }],
    edges: [],
  };
  const grid = svgDimensions(spec);
  const viewBox = graphContentViewBox(spec, computePaths(spec));
  const box = nodeBox(itemAt(spec.nodes, 0));

  assert.deepEqual(viewBox, {
    x: box.x - CONTENT_VIEWBOX_PAD,
    y: box.y - CONTENT_VIEWBOX_PAD,
    w: box.w + CONTENT_VIEWBOX_PAD * 2,
    h: box.h + CONTENT_VIEWBOX_PAD * 2,
  });
  assert.ok(
    viewBox.w < grid.w,
    'content viewBox is narrower than grid viewBox',
  );
  assert.ok(viewBox.h < grid.h, 'content viewBox is shorter than grid viewBox');
});

test('aligned same-column edges are straight vertical lines', () => {
  const routed = computePaths(GRAPH);
  const utilsToProviders = findEdge(routed, 'utils', 'providers');
  const providersToService = findEdge(routed, 'providers', 'service');

  for (const edge of [utilsToProviders, providersToService]) {
    assert.equal(
      edge.points.length,
      2,
      `${edge.edge.from}->${edge.edge.to} should have exactly 2 points`,
    );
    assert.equal(
      itemAt(edge.points, 0).x,
      itemAt(edge.points, 1).x,
      `${edge.edge.from}->${edge.edge.to} should be perfectly vertical`,
    );
  }
});

test('aligned same-row edges are straight horizontal lines', () => {
  const routed = computePaths(GRAPH);
  const cases: [string, string][] = [
    ['providers', 'appwiring'],
    ['service', 'runtime'],
    ['runtime', 'ui'],
    ['types', 'config'],
    ['config', 'repo'],
  ];
  for (const [from, to] of cases) {
    const edge = findEdge(routed, from, to);
    assert.equal(
      edge.points.length,
      2,
      `${from}->${to} should have exactly 2 points`,
    );
    assert.equal(
      itemAt(edge.points, 0).y,
      itemAt(edge.points, 1).y,
      `${from}->${to} should be perfectly horizontal`,
    );
  }
});

test('repo->service: exits Repo from TOP, enters Service from BOTTOM', () => {
  const routed = computePaths(GRAPH);
  const edge = findEdge(routed, 'repo', 'service');

  const repoBox = nodeBox(graphNode('repo'));
  const serviceBox = nodeBox(graphNode('service'));

  const startPoint = itemAt(edge.points, 0);
  assert.equal(startPoint.y, repoBox.y, "start point lands on Repo's TOP edge");
  assert.ok(
    startPoint.x >= repoBox.x && startPoint.x <= repoBox.x + repoBox.w,
    "start point's x is within Repo's horizontal span",
  );

  const { dx, dy } = firstSegment(edge.points);
  assert.equal(dx, 0, 'first segment is vertical');
  assert.equal(dy, -1, 'first segment goes UP (away from Repo top edge)');

  const finalPoint = itemAt(edge.points, -1);
  assert.equal(
    finalPoint.y,
    serviceBox.y + serviceBox.h + ENTRY_GAP,
    "final point sits ENTRY_GAP below Service's BOTTOM edge",
  );
  assert.ok(
    finalPoint.x >= serviceBox.x && finalPoint.x <= serviceBox.x + serviceBox.w,
    "final point's x is within Service's horizontal span",
  );

  const last = lastSegment(edge.points);
  assert.equal(last.dx, 0, 'last segment is vertical');
  assert.equal(last.dy, -1, 'last segment goes UP (into Service from below)');
});

test('runtime->appwiring: arrowhead points UP into App Wiring from below', () => {
  const routed = computePaths(GRAPH);
  const edge = findEdge(routed, 'runtime', 'appwiring');

  const { dx, dy } = lastSegment(edge.points);
  assert.equal(dx, 0, 'last segment is vertical');
  assert.equal(dy, -1, 'last segment goes UP (into AppWiring from below)');

  const appwiringBox = nodeBox(graphNode('appwiring'));
  const finalPoint = itemAt(edge.points, -1);
  assert.equal(
    finalPoint.y,
    appwiringBox.y + appwiringBox.h + ENTRY_GAP,
    "final point sits ENTRY_GAP below AppWiring's bottom edge",
  );
});

test('utils->providers: first segment leaves Utils going DOWN (perpendicular to bottom edge)', () => {
  const routed = computePaths(GRAPH);
  const edge = findEdge(routed, 'utils', 'providers');

  const { dx, dy } = firstSegment(edge.points);
  assert.equal(dx, 0, 'first segment is vertical');
  assert.equal(dy, 1, 'first segment goes DOWN (away from Utils bottom edge)');
});

test('every routed edge starts on its source node edge and ends ENTRY_GAP outside its target node edge', () => {
  const routed = computePaths(GRAPH);
  for (const r of routed) {
    if (!r.points.length) continue;
    const sourceBox = nodeBox(graphNode(r.edge.from));
    const targetBox = nodeBox(graphNode(r.edge.to));
    const start = itemAt(r.points, 0);
    const end = itemAt(r.points, -1);

    const onSourceEdge = (p: Point, b: typeof sourceBox) =>
      p.x === b.x || p.x === b.x + b.w || p.y === b.y || p.y === b.y + b.h;

    const nearTargetEdge = (p: Point, b: typeof targetBox) =>
      p.x === b.x - ENTRY_GAP ||
      p.x === b.x + b.w + ENTRY_GAP ||
      p.y === b.y - ENTRY_GAP ||
      p.y === b.y + b.h + ENTRY_GAP;

    assert.ok(
      onSourceEdge(start, sourceBox),
      `${r.edge.from}->${r.edge.to}: start point ${JSON.stringify(start)} not on source edge`,
    );
    assert.ok(
      nearTargetEdge(end, targetBox),
      `${r.edge.from}->${r.edge.to}: end point ${JSON.stringify(end)} not ENTRY_GAP from target edge`,
    );
  }
});

test('every routed edge has its final segment perpendicular to the target box edge it lands on', () => {
  const routed = computePaths(GRAPH);
  for (const r of routed) {
    if (r.points.length < 2) continue;
    const targetBox = nodeBox(graphNode(r.edge.to));
    const end = itemAt(r.points, -1);
    const { dx, dy } = lastSegment(r.points);

    const onLeft = end.x === targetBox.x - ENTRY_GAP;
    const onRight = end.x === targetBox.x + targetBox.w + ENTRY_GAP;
    const onTop = end.y === targetBox.y - ENTRY_GAP;
    const onBottom = end.y === targetBox.y + targetBox.h + ENTRY_GAP;

    if (onLeft) {
      assert.equal(
        dx,
        1,
        `${r.edge.from}->${r.edge.to}: lands on LEFT edge, last segment must go RIGHT (got dx=${dx}, dy=${dy})`,
      );
      assert.equal(dy, 0, 'horizontal');
    } else if (onRight) {
      assert.equal(
        dx,
        -1,
        `${r.edge.from}->${r.edge.to}: lands on RIGHT edge, last segment must go LEFT (got dx=${dx}, dy=${dy})`,
      );
      assert.equal(dy, 0, 'horizontal');
    } else if (onTop) {
      assert.equal(
        dy,
        1,
        `${r.edge.from}->${r.edge.to}: lands on TOP edge, last segment must go DOWN (got dx=${dx}, dy=${dy})`,
      );
      assert.equal(dx, 0, 'vertical');
    } else if (onBottom) {
      assert.equal(
        dy,
        -1,
        `${r.edge.from}->${r.edge.to}: lands on BOTTOM edge, last segment must go UP (got dx=${dx}, dy=${dy})`,
      );
      assert.equal(dx, 0, 'vertical');
    } else {
      assert.fail(
        `${r.edge.from}->${r.edge.to}: end point not on any target edge`,
      );
    }
  }
});

test('routes never pass through a non-source non-target node body', () => {
  const spec: GraphLayoutSpec = GRAPH;
  const routed = computePaths(spec);

  for (const r of routed) {
    if (r.points.length < 2) continue;
    const sourceId = r.edge.from;
    const targetId = r.edge.to;

    for (const node of spec.nodes) {
      if (node.id === sourceId || node.id === targetId) continue;
      const box = nodeBox(node);

      for (let i = 0; i < r.points.length - 1; i++) {
        const a = itemAt(r.points, i);
        const b = itemAt(r.points, i + 1);
        const segMinX = Math.min(a.x, b.x);
        const segMaxX = Math.max(a.x, b.x);
        const segMinY = Math.min(a.y, b.y);
        const segMaxY = Math.max(a.y, b.y);

        const intersectsX = segMaxX > box.x && segMinX < box.x + box.w;
        const intersectsY = segMaxY > box.y && segMinY < box.y + box.h;

        assert.ok(
          !(intersectsX && intersectsY),
          `${sourceId}->${targetId}: segment ${i} (${JSON.stringify(a)} -> ${JSON.stringify(b)}) crosses ${node.id} body`,
        );
      }
    }
  }
});

test('exitSide / entrySide hints override the gap heuristic', () => {
  const spec: GraphLayoutSpec = {
    title: ['hint test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      { id: 'b', label: 'B', row: 2, col: 0 },
    ],
    edges: [{ from: 'a', to: 'b', exitSide: 'right', entrySide: 'right' }],
  };
  const routed = computePaths(spec);
  const aBox = nodeBox(itemAt(spec.nodes, 0));
  const bBox = nodeBox(itemAt(spec.nodes, 1));

  const start = itemAt(itemAt(routed, 0).points, 0);
  const end = itemAt(itemAt(routed, 0).points, -1);

  assert.equal(
    start.x,
    aBox.x + aBox.w,
    'exit on RIGHT side of source A (forced by hint, not heuristic which would have picked BOTTOM)',
  );
  assert.equal(
    end.x,
    bBox.x + bBox.w + ENTRY_GAP,
    'entry on RIGHT side of target B (forced by hint)',
  );
});

test('entryGap can route directly into hidden connector nodes', () => {
  const spec: GraphLayoutSpec = {
    title: ['connector test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      {
        id: 'connector',
        label: '',
        row: 0,
        col: 1,
        width: 1,
        height: 1,
        frame: 'none',
        hidden: true,
      },
    ],
    edges: [
      {
        from: 'a',
        to: 'connector',
        exitSide: 'right',
        entrySide: 'left',
        entryGap: 0,
        headless: true,
      },
    ],
  };
  const routed = computePaths(spec);
  const connectorBox = nodeBox(itemAt(spec.nodes, 1));
  const end = itemAt(itemAt(routed, 0).points, -1);

  assert.equal(end.x, connectorBox.x, 'edge lands directly on connector node');
});

test('flat frame nodes are supported as normal routed boxes', () => {
  const spec: GraphLayoutSpec = {
    title: ['flat frame test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      {
        id: 'flat',
        label: ['Flat', 'box'],
        row: 0,
        col: 1,
        frame: 'flat',
      },
    ],
    edges: [{ from: 'a', to: 'flat' }],
  };
  const routed = computePaths(spec);
  const flatBox = nodeBox(itemAt(spec.nodes, 1));
  const end = itemAt(itemAt(routed, 0).points, -1);

  assert.equal(end.x, flatBox.x - ENTRY_GAP);
});

test('non-connectable nodes cannot be used as routed endpoints', () => {
  const spec: GraphLayoutSpec = {
    title: ['float endpoint test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      {
        id: 'float',
        label: ['Float', 'box'],
        row: 0,
        col: 1,
        frame: 'flat',
        connectable: false,
      },
    ],
    edges: [{ from: 'a', to: 'float' }],
  };

  assert.throws(
    () => computePaths(spec),
    /cannot end at non-connectable node "float"/,
  );
});

test('three parallel edges from same source spread along the exit edge', () => {
  const spec: GraphLayoutSpec = {
    title: ['parallel test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      { id: 'b', label: 'B', row: 2, col: 0 },
    ],
    edges: [
      { from: 'a', to: 'b', exitSide: 'bottom', entrySide: 'top' },
      { from: 'a', to: 'b', exitSide: 'bottom', entrySide: 'top' },
      { from: 'a', to: 'b', exitSide: 'bottom', entrySide: 'top' },
    ],
  };
  const routed = computePaths(spec);
  const xs = routed.map((r) => itemAt(r.points, 0).x);
  const aBox = nodeBox(itemAt(spec.nodes, 0));
  const aCenterX = aBox.x + aBox.w / 2;

  assert.equal(
    xs[0],
    aCenterX - PARALLEL_SPACING,
    'first edge offset by -SPACING',
  );
  assert.equal(xs[1], aCenterX, 'middle edge at center');
  assert.equal(
    xs[2],
    aCenterX + PARALLEL_SPACING,
    'third edge offset by +SPACING',
  );
});

test('three edges entering same target spread along the entry edge', () => {
  const spec: GraphLayoutSpec = {
    title: ['fan-in test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      { id: 'b', label: 'B', row: 1, col: 0 },
      { id: 'c', label: 'C', row: 2, col: 0 },
      { id: 'sink', label: 'SINK', row: 1, col: 3 },
    ],
    edges: [
      { from: 'a', to: 'sink', exitSide: 'right', entrySide: 'left' },
      { from: 'b', to: 'sink', exitSide: 'right', entrySide: 'left' },
      { from: 'c', to: 'sink', exitSide: 'right', entrySide: 'left' },
    ],
  };
  const routed = computePaths(spec);
  const ys = routed.map((r) => itemAt(r.points, -1).y);
  const sinkBox = nodeBox(itemAt(spec.nodes, 3));
  const sinkCenterY = sinkBox.y + sinkBox.h / 2;
  const straightEdgeOffset = sinkBox.h / 2 - NODE_RX - ROUTE_CELL;

  assert.equal(
    ys[0],
    sinkCenterY - straightEdgeOffset,
    'first entry offset stays on the straight part of the rounded edge',
  );
  assert.equal(ys[1], sinkCenterY, 'middle entry at center');
  assert.equal(
    ys[2],
    sinkCenterY + straightEdgeOffset,
    'third entry offset stays on the straight part of the rounded edge',
  );
});

test('edges with a label produce a labelPlacement; edges without label still produce one (component decides whether to render)', () => {
  const spec: GraphLayoutSpec = {
    title: ['label test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      { id: 'b', label: 'B', row: 0, col: 2 },
    ],
    edges: [
      { from: 'a', to: 'b', label: ['hello', 'world'] },
      { from: 'a', to: 'b' },
    ],
  };
  const routed = computePaths(spec);
  for (const r of routed) {
    assert.ok(r.labelPlacement, 'every routed edge has a labelPlacement');
  }
});

test('vertical parallel edges produce staggered label Y positions', () => {
  const spec: GraphLayoutSpec = {
    title: ['stagger test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      { id: 'b', label: 'B', row: 2, col: 0 },
    ],
    edges: [
      {
        from: 'a',
        to: 'b',
        label: ['one'],
        exitSide: 'bottom',
        entrySide: 'top',
      },
      {
        from: 'a',
        to: 'b',
        label: ['two'],
        exitSide: 'bottom',
        entrySide: 'top',
      },
      {
        from: 'a',
        to: 'b',
        label: ['three'],
        exitSide: 'bottom',
        entrySide: 'top',
      },
    ],
  };
  const routed = computePaths(spec);
  const labelYs = routed.map((r) => labelY(r));

  assert.ok(
    itemAt(labelYs, 0) < itemAt(labelYs, 1) &&
      itemAt(labelYs, 1) < itemAt(labelYs, 2),
    `parallel vertical edge labels should stagger by Y; got [${labelYs.join(', ')}]`,
  );
  assert.equal(
    itemAt(labelYs, 2) - itemAt(labelYs, 1),
    itemAt(labelYs, 1) - itemAt(labelYs, 0),
    'spacing between labels is uniform',
  );
});

test('same-row reverse edges route below the row instead of across the top', () => {
  const spec: GraphLayoutSpec = {
    title: ['reverse edge test'],
    nodes: [
      { id: 'left', label: 'LEFT', row: 0, col: 0 },
      { id: 'middle', label: 'MIDDLE', row: 0, col: 1 },
      { id: 'right', label: 'RIGHT', row: 0, col: 2 },
    ],
    edges: [{ from: 'right', to: 'left', label: ['return'] }],
  };
  const routed = computePaths(spec);
  const edge = findEdge(routed, 'right', 'left');
  const rightBox = nodeBox(itemAt(spec.nodes, 2));
  const leftBox = nodeBox(itemAt(spec.nodes, 0));

  assert.equal(
    itemAt(edge.points, 0).y,
    rightBox.y + rightBox.h,
    'reverse edge exits from the source bottom side',
  );
  assert.equal(
    itemAt(edge.points, -1).y,
    leftBox.y + leftBox.h + ENTRY_GAP,
    'reverse edge enters below the target bottom side',
  );
  assert.ok(
    edge.points.some((point) => point.y > rightBox.y + rightBox.h),
    'reverse edge should have a visible route below the row',
  );
  const bottomLaneY = Math.max(...edge.points.map((point) => point.y));
  assert.ok(
    labelY(edge) < bottomLaneY,
    `reverse edge label should sit above its bottom lane (label=${labelY(edge)}, lane=${bottomLaneY})`,
  );
});

test('reciprocal same-row edges separate direct and return lanes', () => {
  const spec: GraphLayoutSpec = {
    title: ['reciprocal edge test'],
    nodes: [
      { id: 'running', label: 'running', row: 0, col: 0 },
      { id: 'paused', label: 'paused', row: 0, col: 1 },
    ],
    edges: [
      { from: 'running', to: 'paused', label: ['pause'] },
      { from: 'paused', to: 'running', label: ['resume'] },
    ],
  };
  const routed = computePaths(spec);
  const pause = findEdge(routed, 'running', 'paused');
  const resume = findEdge(routed, 'paused', 'running');
  const runningBox = nodeBox(itemAt(spec.nodes, 0));
  const pausedBox = nodeBox(itemAt(spec.nodes, 1));

  assert.equal(
    new Set(pause.points.map((point) => point.y)).size,
    1,
    'forward edge stays on a direct horizontal lane',
  );
  assert.equal(
    itemAt(pause.points, 0).x,
    runningBox.x + runningBox.w,
    'forward edge exits from the right side',
  );
  assert.equal(
    itemAt(pause.points, -1).x,
    pausedBox.x - ENTRY_GAP,
    'forward edge enters from the left side',
  );
  assert.ok(
    resume.points.some((point) => point.y > pausedBox.y + pausedBox.h),
    'reciprocal return edge should route below the cards',
  );
  assert.ok(
    labelY(resume) > labelY(pause),
    'return label should not overlap the direct label',
  );
});

test('self-loops route around their node with a readable top label', () => {
  const spec: GraphLayoutSpec = {
    title: ['self loop test'],
    nodes: [{ id: 'running', label: 'running', row: 0, col: 0 }],
    edges: [{ from: 'running', to: 'running', label: ['tick'] }],
  };
  const routed = computePaths(spec);
  const tick = findEdge(routed, 'running', 'running');
  const runningBox = nodeBox(itemAt(spec.nodes, 0));

  assert.ok(
    tick.points.some((point) => point.y < runningBox.y),
    'self-loop should leave visible space above the node',
  );
  assert.ok(
    labelY(tick) < runningBox.y,
    'self-loop label should sit above the node, not on another lower route',
  );
  assert.equal(
    itemAt(tick.points, -1).y,
    runningBox.y - ENTRY_GAP,
    'self-loop arrowhead lands just outside the top side',
  );
});

test('nested same-side return edges use separate route corridors', () => {
  const spec: GraphLayoutSpec = {
    title: ['state machine returns'],
    nodes: [
      { id: 'idle', label: 'idle', row: 0, col: 0 },
      { id: 'running', label: 'running', row: 0, col: 1 },
      { id: 'paused', label: 'paused', row: 0, col: 2 },
    ],
    edges: [
      { from: 'paused', to: 'running', label: ['resume'] },
      { from: 'paused', to: 'idle', label: ['stop'] },
    ],
  };
  const routed = computePaths(spec);
  const resume = findEdge(routed, 'paused', 'running');
  const stop = findEdge(routed, 'paused', 'idle');
  const resumeLaneY = Math.max(...resume.points.map((point) => point.y));
  const stopLaneY = Math.max(...stop.points.map((point) => point.y));

  assert.ok(
    stopLaneY > resumeLaneY,
    `longer return should use a deeper corridor than the nested return (stop=${stopLaneY}, resume=${resumeLaneY})`,
  );
  assert.ok(
    labelY(stop) > resumeLaneY,
    `stop label should clear the resume entry junction (label=${labelY(stop)}, resume lane=${resumeLaneY})`,
  );
  assert.ok(
    labelY(stop) < stopLaneY,
    `stop label should remain above its own route line (label=${labelY(stop)}, stop lane=${stopLaneY})`,
  );
});

test('annotations passthrough: spec accepts annotations field without breaking routing', () => {
  const spec: GraphLayoutSpec = {
    title: ['annotation test'],
    nodes: [
      { id: 'a', label: 'A', row: 0, col: 0 },
      { id: 'b', label: 'B', row: 0, col: 2 },
    ],
    edges: [{ from: 'a', to: 'b' }],
    annotations: [
      { x: 100, y: 50, text: ['Note 1'], align: 'middle' },
      { x: 200, y: 80, text: ['Note 2', 'multi-line'], color: 'accent' },
    ],
  };
  const routed = computePaths(spec);
  assert.equal(routed.length, 1, 'edges still routed');
  assert.ok(itemAt(routed, 0).points.length >= 2, 'edge has a path');
});

test('hidden phantom anchors do not obstruct routes that pass through their column', () => {
  const spec: GraphLayoutSpec = {
    title: ['lifeline test'],
    nodes: [
      { id: 'top', label: 'TOP', row: 0, col: 0 },
      { id: 'bot', label: 'BOT', row: 4, col: 0 },
      {
        id: 'a1',
        label: '',
        row: 1,
        col: 0,
        width: 1,
        height: 1,
        frame: 'none',
        hidden: true,
      },
      {
        id: 'a2',
        label: '',
        row: 2,
        col: 0,
        width: 1,
        height: 1,
        frame: 'none',
        hidden: true,
      },
      {
        id: 'a3',
        label: '',
        row: 3,
        col: 0,
        width: 1,
        height: 1,
        frame: 'none',
        hidden: true,
      },
    ],
    edges: [{ from: 'top', to: 'bot' }],
  };
  const routed = computePaths(spec);
  const xs = new Set(itemAt(routed, 0).points.map((p) => p.x));
  assert.equal(
    xs.size,
    1,
    `top->bot wire should be straight vertical despite hidden anchors on the same column, got xs=${[...xs].join(',')}`,
  );
});

test('group.tight derives height from contained node bboxes instead of row pitch', () => {
  const card = {
    id: 'n',
    label: '',
    row: 0,
    col: 0,
    height: 64,
    group: 'g',
  } as const;
  const looseGroup = {
    id: 'g',
    label: '',
    bounds: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
  } as const;
  const tightGroup = { ...looseGroup, tight: true };

  const loose = groupBox(looseGroup, [card]);
  const tight = groupBox(tightGroup, [card]);

  assert.ok(
    tight.h < loose.h,
    `tight group should be shorter than default (tight=${tight.h}, loose=${loose.h})`,
  );

  const cardBox = nodeBox(card);
  assert.ok(
    tight.y <= cardBox.y,
    'tight group top should sit at or above the topmost contained card',
  );
  assert.ok(
    tight.y + tight.h >= cardBox.y + cardBox.h,
    'tight group bottom should sit at or below the bottommost contained card',
  );
});

test('group.tight reserves vertical space for the label so it does not overlap content', () => {
  const card = {
    id: 'n',
    label: '',
    row: 0,
    col: 0,
    height: 64,
    group: 'g',
  } as const;
  const labeled = groupBox(
    {
      id: 'g',
      label: 'Limerence',
      tight: true,
      bounds: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    },
    [card],
  );
  const cardBox = nodeBox(card);

  // GROUP_LABEL_H is 28; label baseline sits at box.y + 28, visual top ~14.
  // The card content must sit strictly below box.y + 28 so it does not overlap.
  assert.ok(
    cardBox.y >= labeled.y + 28,
    `card top (${cardBox.y}) should be at or below label baseline (${labeled.y + 28})`,
  );
});

test('group.padding overrides the default 24px collar', () => {
  const baseGroup = {
    id: 'g',
    label: '',
    bounds: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
  } as const;
  const defaultPad = groupBox(baseGroup);
  const tightPad = groupBox({ ...baseGroup, padding: 8 });
  assert.equal(
    defaultPad.h - tightPad.h,
    2 * (24 - 8),
    'padding should shrink the rect symmetrically on both vertical sides',
  );
  assert.equal(
    defaultPad.w - tightPad.w,
    2 * (24 - 8),
    'padding should shrink the rect symmetrically on both horizontal sides',
  );
});
