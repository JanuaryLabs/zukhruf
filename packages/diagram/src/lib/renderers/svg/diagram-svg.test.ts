import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fragment, type ReactNode, createElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';

import {
  type Box,
  CanvasGraphDiagram,
  Diagram,
  type DiagramEdgeProps,
  type EdgeLayout,
  type GraphLayout,
  type GroupLayout,
  type NodeLayout,
  type Point,
  SvgGraphDiagram,
  SvgTimelineDiagram,
  layoutGraph,
} from '@zukhruf/diagram';

import { assertSoundLayout } from '../../../testing/sound-layout.ts';
import { compileGraph } from '../../compiler/diagram-compile.ts';

const REJECT_TITLE = 'rejection-fixture';

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  assert.ok(
    item !== undefined,
    `expected an item at ${index} of ${items.length}`,
  );
  return item;
}

/** Lays the children out the way SvgGraphDiagram does, and fails on any broken layout invariant. */
function soundLayout(children: ReactNode): GraphLayout {
  const layout = layoutGraph(compileGraph(children));
  assertSoundLayout(layout);
  return layout;
}

function nodeOf(layout: GraphLayout, id: string): NodeLayout {
  const node = layout.nodes.find((candidate) => candidate.node.id === id);
  assert.ok(node, `the layout should hold node ${id}`);
  return node;
}

function groupOf(layout: GraphLayout, id: string): GroupLayout {
  const group = layout.groups.find((candidate) => candidate.group.id === id);
  assert.ok(group, `the layout should hold group ${id}`);
  return group;
}

function edgeOf(layout: GraphLayout, from: string, to: string): EdgeLayout {
  const edge = layout.edges.find(
    (candidate) => candidate.edge.from === from && candidate.edge.to === to,
  );
  assert.ok(edge, `the layout should hold edge ${from}->${to}`);
  return edge;
}

function first<T>(items: readonly T[], what: string): T {
  const [item] = items;
  assert.ok(item !== undefined, `expected ${what}`);
  return item;
}

function last<T>(items: readonly T[], what: string): T {
  const item = items.at(-1);
  assert.ok(item !== undefined, `expected ${what}`);
  return item;
}

function contains(outer: Box, inner: Box) {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

function onSide(point: Point, box: Box, side: string) {
  const withinX = point.x >= box.x && point.x <= box.x + box.w;
  const withinY = point.y >= box.y && point.y <= box.y + box.h;
  switch (side) {
    case 'top':
      return point.y === box.y && withinX;
    case 'bottom':
      return point.y === box.y + box.h && withinX;
    case 'left':
      return point.x === box.x && withinY;
    case 'right':
      return point.x === box.x + box.w && withinY;
    default:
      throw new Error(`unknown side ${side}`);
  }
}

type Span = { axis: 'x' | 'y'; at: number; from: number; to: number };

function spans(points: Point[]): Span[] {
  const result: Span[] = [];
  for (const [i, a] of points.entries()) {
    const b = points[i + 1];
    if (!b) break;
    if (a.x === b.x && a.y !== b.y) {
      result.push({
        axis: 'x',
        at: a.x,
        from: Math.min(a.y, b.y),
        to: Math.max(a.y, b.y),
      });
    }
    if (a.y === b.y && a.x !== b.x) {
      result.push({
        axis: 'y',
        at: a.y,
        from: Math.min(a.x, b.x),
        to: Math.max(a.x, b.x),
      });
    }
  }
  return result;
}

/** The segments two routes share: the same line, overlapping by more than a point. */
function sharedSegments(a: Point[], b: Point[]) {
  return spans(a).flatMap((one) =>
    spans(b)
      .filter(
        (two) =>
          one.axis === two.axis &&
          one.at === two.at &&
          Math.max(one.from, two.from) < Math.min(one.to, two.to),
      )
      .map((two) => ({ one, two })),
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function svgViewBox(markup: string) {
  const match = markup.match(
    /<svg[^>]*viewBox="(?<x>-?\d+(?:\.\d+)?) (?<y>-?\d+(?:\.\d+)?) (?<w>-?\d+(?:\.\d+)?) (?<h>-?\d+(?:\.\d+)?)"/,
  );
  if (!match?.groups) throw new Error('svg viewBox not found');
  return {
    x: Number(match.groups.x),
    y: Number(match.groups.y),
    w: Number(match.groups.w),
    h: Number(match.groups.h),
  };
}

function svgNumberAttr(markup: string, attr: string) {
  const match = markup.match(
    new RegExp(`<svg[^>]*\\b${attr}="(?<value>-?\\d+(?:\\.\\d+)?)"`),
  );
  if (!match?.groups) throw new Error(`svg ${attr} not found`);
  return Number(match.groups.value);
}

function renderedRect(markup: string, attr: string, id: string) {
  const match = markup.match(
    new RegExp(
      `<rect ${attr}="${escapeRegExp(id)}"[^>]*\\bx="(?<x>-?\\d+(?:\\.\\d+)?)"[^>]*\\by="(?<y>-?\\d+(?:\\.\\d+)?)"[^>]*\\bwidth="(?<w>-?\\d+(?:\\.\\d+)?)"[^>]*\\bheight="(?<h>-?\\d+(?:\\.\\d+)?)"`,
    ),
  );
  if (!match?.groups) throw new Error(`${attr}="${id}" rect not found`);
  return {
    x: Number(match.groups.x),
    y: Number(match.groups.y),
    w: Number(match.groups.w),
    h: Number(match.groups.h),
  };
}

function renderedTextLines(markup: string, attr: string, id: string) {
  const match = markup.match(
    new RegExp(
      `<text ${attr}="${escapeRegExp(id)}"[^>]*>(?<body>[\\s\\S]*?)</text>`,
    ),
  );
  if (!match?.groups?.body) throw new Error(`${attr}="${id}" text not found`);
  return Array.from(
    match.groups.body.matchAll(/<tspan[^>]*>(?<text>[\s\S]*?)<\/tspan>/g),
    (lineMatch) => decodeSvgText(lineMatch.groups?.text ?? ''),
  );
}

function decodeSvgText(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'");
}

test('renders a graph diagram with boxes, port lines, and an arrow', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'graph-test',
      children: [
        createElement(Diagram.Box, { id: 'app', row: 0, col: 0 }, 'APP'),
        createElement(
          Diagram.Port,
          { id: 'relay', row: 1, col: 0 },
          createElement(Diagram.Line, null, 'LOGS'),
          createElement(Diagram.Line, null, 'METRICS'),
        ),
        createElement(Diagram.Arrow, {
          from: 'app',
          to: 'relay',
          exitSide: 'bottom',
          entrySide: 'top',
        }),
      ],
    }),
  );

  assert.match(markup, /<svg[^>]*role="img"/);
  assert.match(markup, /aria-label="graph-test"/);
  assert.match(markup, /APP/);
  assert.match(markup, /LOGS/);
  assert.match(markup, /METRICS/);
});

test('diagram controls are hidden by default and can be opted in', () => {
  const defaultMarkup = render(
    createElement(SvgGraphDiagram, {
      title: 'default-controls-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Box,
        { id: 'app', row: 0, col: 0 },
        'APP',
      ),
    }),
  );
  const optedInMarkup = render(
    createElement(SvgGraphDiagram, {
      title: 'opted-in-controls-test',
      defaultMode: 'static',
      controls: true,
      children: createElement(
        Diagram.Box,
        { id: 'app', row: 0, col: 0 },
        'APP',
      ),
    }),
  );

  assert.doesNotMatch(defaultMarkup, /Diagram motion mode/);
  assert.match(optedInMarkup, /Diagram motion mode/);
  assert.match(optedInMarkup, /static/);
  assert.match(optedInMarkup, /reveal/);
  assert.match(optedInMarkup, /scrub/);
});

test('diagram header can be hidden while preserving the accessible SVG title', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'hidden-header-test',
      defaultMode: 'static',
      showHeader: false,
      children: createElement(
        Diagram.Box,
        { id: 'app', row: 0, col: 0 },
        'APP',
      ),
    }),
  );

  assert.match(markup, /aria-label="hidden-header-test"/);
  assert.match(markup, /<title>hidden-header-test<\/title>/);
  assert.doesNotMatch(
    markup,
    /max-w-md font-sans text-sm font-semibold text-balance/,
    'showHeader=false should remove the visible diagram title chrome',
  );
});

test('sketch style preset renders black-ink diagram theme hooks', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'sketch-style-test',
      defaultMode: 'static',
      stylePreset: 'sketch',
      children: [
        createElement(
          Diagram.Box,
          { id: 'gateway', row: 0, col: 0, tone: 'blue' },
          'Gateway',
        ),
        createElement(
          Diagram.Box,
          { id: 'mesh', row: 0, col: 1, tone: 'green' },
          'Mesh',
        ),
        createElement(Diagram.Arrow, { from: 'gateway', to: 'mesh' }),
      ],
    }),
  );

  assert.match(markup, /data-diagram-style-preset="sketch"/);
  assert.match(
    markup,
    /\[--dgm-tone-blue-stroke:rgba\(17,24,39,0\.66\)\]/,
    'sketch preset should override colored tone strokes to neutral ink',
  );
  assert.match(
    markup,
    /\[--dgm-hatch:rgba\(17,24,39,0\.13\)\]/,
    'sketch preset should use faint neutral hatching',
  );
  assert.match(
    markup,
    /data-diagram-node="gateway" data-diagram-node-tone="blue"[^>]*stroke="var\(--dgm-tone-blue-stroke/,
  );
  assert.match(
    markup,
    /data-diagram-edge="gateway-&gt;mesh"[^>]*stroke="var\(--dgm-neutral/,
  );
});

test('diagram chrome keeps its title but renders without an outer border', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'borderless-frame-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Box,
        { id: 'app', row: 0, col: 0 },
        'APP',
      ),
    }),
  );

  assert.match(markup, /borderless-frame-test/);
  assert.match(markup, /rounded-md bg-\[var\(--dgm-bg\)\]/);
  assert.doesNotMatch(markup, /rounded-md border bg-\[var\(--dgm-bg\)\]/);
  assert.doesNotMatch(markup, /border-color/);
});

test('natural graph viewport renders at intrinsic content size multiplied by zoom', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'natural-viewport-test',
      defaultMode: 'static',
      viewport: { fit: 'natural', zoom: 1.5 },
      children: [
        createElement(Diagram.Box, { id: 'router', row: 0, col: 0 }, 'Router'),
        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 1 },
          'Service',
        ),
        createElement(Diagram.Arrow, { from: 'router', to: 'service' }),
      ],
    }),
  );

  const viewBox = svgViewBox(markup);
  assert.match(markup, /data-diagram-viewport-fit="natural"/);
  assert.match(markup, /data-diagram-viewport-zoom="1.5"/);
  assert.match(markup, /class="block h-auto max-w-none shrink-0"/);
  assert.ok(Math.abs(svgNumberAttr(markup, 'width') - viewBox.w * 1.5) < 0.01);
  assert.ok(Math.abs(svgNumberAttr(markup, 'height') - viewBox.h * 1.5) < 0.01);
});

test('contained graph viewport fills its parent box without intrinsic dimensions', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'contain-viewport-test',
      defaultMode: 'static',
      viewport: { fit: 'contain' },
      children: [
        createElement(Diagram.Box, { id: 'router', row: 0, col: 0 }, 'Router'),
        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 1 },
          'Service',
        ),
        createElement(Diagram.Arrow, { from: 'router', to: 'service' }),
      ],
    }),
  );

  const viewBox = svgViewBox(markup);
  assert.match(markup, /data-diagram-viewport-fit="contain"/);
  assert.match(markup, /data-diagram-viewport-zoom="1"/);
  assert.match(markup, /class="block min-h-0 min-w-0 max-h-full max-w-full"/);
  assert.match(markup, /style="width:100%;height:100%[;"]/);
  assert.doesNotMatch(markup, /<svg[^>]*\swidth="/);
  assert.doesNotMatch(markup, /<svg[^>]*\sheight="/);
  assert.ok(viewBox.w > 0);
  assert.ok(viewBox.h > 0);
});

test('graph paper background covers the rendered viewBox behind topology', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'graph-paper-test',
      defaultMode: 'static',
      viewport: { fit: 'contain' },
      paper: true,
      children: [
        createElement(Diagram.Box, { id: 'source', row: 0, col: 0 }, 'Source'),
        createElement(Diagram.Box, { id: 'target', row: 0, col: 1 }, 'Target'),
        createElement(Diagram.Arrow, { from: 'source', to: 'target' }),
      ],
    }),
  );

  const viewBox = svgViewBox(markup);
  const paper = renderedRect(markup, 'data-diagram-paper', 'graph');
  assert.deepEqual(
    paper,
    viewBox,
    'graph paper should cover the exact rendered SVG viewBox',
  );
  assert.match(markup, /data-diagram-viewport-fit="contain"/);
  assert.match(markup, /data-diagram-paper-fill="background"/);
  assert.match(
    markup,
    /<rect data-diagram-paper="graph"[^>]*fill="var\(--dgm-bg, #000000\)"[^>]*stroke="none"/,
  );
  assert.doesNotMatch(markup, /<svg[^>]*\swidth="/);
  assert.doesNotMatch(markup, /<svg[^>]*\sheight="/);
  assert.ok(
    markup.indexOf('data-diagram-paper="graph"') <
      markup.indexOf('data-diagram-edge="source-&gt;target"'),
    'graph paper should render behind routed edges',
  );
  assert.ok(
    markup.indexOf('data-diagram-paper="graph"') <
      markup.indexOf('data-diagram-node="source"'),
    'graph paper should render behind nodes',
  );
});

test('canvas graph diagram draws the graph on a canvas', () => {
  const markup = render(
    createElement(CanvasGraphDiagram, {
      title: 'graph-canvas-renderer-test',
      defaultMode: 'static',
      viewport: { fit: 'natural', zoom: 1.25 },
      paper: true,
      children: [
        createElement(Diagram.Box, { id: 'source', row: 0, col: 0 }, 'Source'),
        createElement(Diagram.Box, { id: 'target', row: 0, col: 1 }, 'Target'),
        createElement(Diagram.Arrow, { from: 'source', to: 'target' }, 'Flow'),
      ],
    }),
  );

  assert.match(markup, /<canvas /);
  assert.match(markup, /data-diagram-canvas="graph"/);
  assert.match(
    markup,
    /data-diagram-canvas-viewbox="-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)?"/,
  );
  assert.match(markup, /data-diagram-viewport-fit="natural"/);
  assert.match(markup, /data-diagram-viewport-zoom="1.25"/);
  assert.match(markup, /style="width:\d+(?:\.\d+)?px;height:\d+(?:\.\d+)?px"/);
  assert.doesNotMatch(markup, /<svg/);
});

test('natural timeline viewport uses the same zoom contract as graph diagrams', () => {
  const markup = render(
    createElement(SvgTimelineDiagram, {
      title: 'timeline-natural-viewport-test',
      defaultMode: 'static',
      viewport: { fit: 'natural', zoom: 1.25 },
      children: [
        createElement(Diagram.Lane, { id: 'user' }, 'User'),
        createElement(Diagram.Lane, { id: 'api' }, 'API'),
        createElement(Diagram.Signal, { from: 'user', to: 'api' }, 'Request'),
      ],
    }),
  );

  const viewBox = svgViewBox(markup);
  assert.match(markup, /data-diagram-viewport-fit="natural"/);
  assert.match(markup, /data-diagram-viewport-zoom="1.25"/);
  assert.equal(svgNumberAttr(markup, 'width'), viewBox.w * 1.25);
  assert.equal(svgNumberAttr(markup, 'height'), viewBox.h * 1.25);
});

test('contained timeline viewport supports zoomed parent-relative sizing', () => {
  const markup = render(
    createElement(SvgTimelineDiagram, {
      title: 'timeline-contain-viewport-test',
      defaultMode: 'static',
      viewport: { fit: 'contain', zoom: 1.25 },
      children: [
        createElement(Diagram.Lane, { id: 'user' }, 'User'),
        createElement(Diagram.Lane, { id: 'api' }, 'API'),
        createElement(Diagram.Signal, { from: 'user', to: 'api' }, 'Request'),
      ],
    }),
  );

  assert.match(markup, /data-diagram-viewport-fit="contain"/);
  assert.match(markup, /data-diagram-viewport-zoom="1.25"/);
  assert.match(
    markup,
    /class="block min-h-0 min-w-0 max-h-none max-w-none shrink-0"/,
  );
  assert.match(
    markup,
    /style="width:125%;height:125%;max-width:none;max-height:none[;"]/,
  );
  assert.doesNotMatch(markup, /<svg[^>]*\swidth="/);
  assert.doesNotMatch(markup, /<svg[^>]*\sheight="/);
});

test('timeline paper background covers the rendered timeline viewBox', () => {
  const markup = render(
    createElement(SvgTimelineDiagram, {
      title: 'timeline-paper-test',
      defaultMode: 'static',
      paper: true,
      children: [
        createElement(Diagram.Lane, { id: 'user' }, 'User'),
        createElement(Diagram.Lane, { id: 'api' }, 'API'),
        createElement(Diagram.Signal, { from: 'user', to: 'api' }, 'Request'),
      ],
    }),
  );

  const viewBox = svgViewBox(markup);
  const paper = renderedRect(markup, 'data-diagram-paper', 'timeline');
  assert.deepEqual(
    paper,
    viewBox,
    'timeline paper should cover the exact rendered SVG viewBox',
  );
  assert.match(markup, /data-diagram-paper-fill="background"/);
  assert.ok(
    markup.indexOf('data-diagram-paper="timeline"') <
      markup.indexOf('stroke="var(--dgm-lifeline'),
    'timeline paper should render behind lifelines',
  );
});

test('invalid viewport zoom values throw instead of silently collapsing diagrams', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          viewport: { fit: 'natural', zoom: 0 },
          children: createElement(
            Diagram.Box,
            { id: 'app', row: 0, col: 0 },
            'App',
          ),
        }),
      ),
    /Diagram viewport zoom must be a positive finite number, got 0/,
  );
});

test('invalid paper geometry throws instead of rendering a broken SVG rect', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          paper: { rx: -1 },
          children: createElement(
            Diagram.Box,
            { id: 'source', row: 0, col: 0 },
            'Source',
          ),
        }),
      ),
    /Diagram paper rx must be a non-negative finite number, got -1\./,
  );
});

test('renders infrastructure icon vocabulary from the public Diagram API', () => {
  const icons = [
    'certificate',
    'cloudflare',
    'dashboard',
    'git',
    'gpu',
    'internet',
    'istio',
    'kubernetes',
    'logs',
    'metrics',
    'router',
    'server',
    'shield',
    'storage',
    'trace',
    'tunnel',
  ] as const;
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'infrastructure-icon-test',
      defaultMode: 'static',
      children: icons.map((icon, i) =>
        createElement(
          Diagram.Marker,
          {
            key: icon,
            id: `icon-${icon}`,
            icon: icon,
            row: Math.floor(i / 4),
            col: i % 4,
          },

          icon,
        ),
      ),
    }),
  );

  for (const icon of icons) {
    assert.match(
      markup,
      new RegExp(`data-diagram-node-icon="${icon}"`),
      `expected rendered SVG to include ${icon} icon`,
    );
    assert.match(markup, new RegExp(`>${icon}<`));
  }
});

test('renders node and group tone and texture styling from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'tone-texture-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Group,
        {
          id: 'cluster',
          label: 'Cluster',
          tone: 'blue',
          texture: 'hatch',
        },

        createElement(
          Diagram.Box,
          { id: 'adguard', row: 0, col: 0, tone: 'green', texture: 'hatch' },
          'AdGuard Home',
        ),
        createElement(
          Diagram.Box,
          { id: 'auth', row: 0, col: 1, tone: 'rose', texture: 'none' },
          'Authentik',
        ),
      ),
    }),
  );

  assert.match(
    markup,
    /<rect data-diagram-group="cluster" data-diagram-group-tone="blue"[^>]*fill="var\(--dgm-tone-blue-fill/,
    'group tone should drive the visible group surface fill',
  );
  assert.match(
    markup,
    /<rect data-diagram-group="cluster" data-diagram-group-tone="blue"[^>]*stroke="var\(--dgm-tone-blue-stroke/,
    'group tone should drive the visible group frame stroke',
  );
  assert.match(
    markup,
    /data-diagram-group-texture="cluster:hatch"[^>]*fill="url\(#dgm-hatch-/,
    'group hatch texture should render as a pattern overlay',
  );
  assert.match(
    markup,
    /<rect data-diagram-node="adguard" data-diagram-node-tone="green"[^>]*fill="var\(--dgm-tone-green-fill/,
    'node tone should drive the visible node surface fill',
  );
  assert.match(
    markup,
    /<rect data-diagram-node="adguard" data-diagram-node-tone="green"[^>]*stroke="var\(--dgm-tone-green-stroke/,
    'node tone should drive the visible node frame stroke',
  );
  assert.match(
    markup,
    /data-diagram-node-texture="adguard:hatch"[^>]*fill="url\(#dgm-hatch-/,
    'node hatch texture should render as a pattern overlay',
  );
  assert.match(
    markup,
    /<rect data-diagram-node="auth" data-diagram-node-tone="rose"[^>]*fill="var\(--dgm-tone-rose-fill/,
    'texture="none" should still preserve the node tone fill',
  );
  assert.doesNotMatch(
    markup,
    /data-diagram-node-texture="auth:/,
    'texture="none" should suppress the pattern overlay for that node',
  );
});

test('anchors a group label to the bottom edge when labelSide is bottom', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-label-side-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Group,
          { id: 'top-labelled', label: 'TOP', labelAlign: 'start' },
          createElement(Diagram.Box, { id: 'a', row: 0, col: 0 }, 'A'),
        ),
        createElement(
          Diagram.Group,
          {
            id: 'bottom-labelled',
            label: 'BOTTOM',
            labelAlign: 'start',
            labelSide: 'bottom',
          },

          createElement(Diagram.Box, { id: 'b', row: 1, col: 0 }, 'B'),
        ),
      ],
    }),
  );

  const readLabelY = (id: string) => {
    const match = markup.match(
      new RegExp(
        `<text data-diagram-group-label="${id}"[^>]*\\by="(?<y>-?\\d+(?:\\.\\d+)?)"`,
      ),
    );
    if (!match?.groups) throw new Error(`group label "${id}" not found`);
    return Number(match.groups.y);
  };

  const top = renderedRect(markup, 'data-diagram-group', 'top-labelled');
  const bottom = renderedRect(markup, 'data-diagram-group', 'bottom-labelled');

  assert.ok(
    readLabelY('top-labelled') - top.y < top.h / 2,
    'a default group label should sit in the upper half of its box',
  );
  assert.ok(
    readLabelY('bottom-labelled') - bottom.y > bottom.h / 2,
    'a labelSide="bottom" group label should sit in the lower half of its box',
  );
  assert.ok(
    readLabelY('bottom-labelled') <= bottom.y + bottom.h,
    'a bottom group label should stay inside its own box',
  );
});

test('inverts label color against the node body for a filled node', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'filled-node-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'plain', row: 0, col: 0 }, 'Review'),
        createElement(
          Diagram.Box,
          { id: 'human', row: 0, col: 1, frame: 'filled' },
          'Merge',
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /<rect data-diagram-node="human"[^>]*fill="var\(--dgm-text/,
    'a filled node body should paint with the foreground token',
  );
  assert.match(
    markup,
    /<tspan[^>]*fill="var\(--dgm-on-accent[^>]*>Merge<\/tspan>/,
    'a filled node label should flip to the on-accent token so it stays legible',
  );

  assert.match(
    markup,
    /<rect data-diagram-node="plain"[^>]*fill="var\(--dgm-bg/,
    'an unfilled node body should keep the background token',
  );
  assert.match(
    markup,
    /<tspan[^>]*fill="var\(--dgm-text[^>]*>Review<\/tspan>/,
    'an unfilled node label should keep the foreground token',
  );
});

test('frames a caption in a pill centred beside the node edge it names, and frames nothing otherwise', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'caption-frame-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          {
            id: 'badged',
            row: 0,
            col: 0,
            caption: 'Workspace agent',
            captionSide: 'top',
            captionFrame: true,
          },
          'Reproduce',
        ),
        createElement(
          Diagram.Box,
          { id: 'bare', row: 0, col: 1, caption: 'Agent', captionSide: 'top' },
          'Analyze',
        ),
      ],
    }),
  );

  assert.doesNotMatch(
    markup,
    /data-diagram-node-caption-frame="bare"/,
    'an unframed caption should stay bare text with no surrounding rect',
  );

  const node = renderedRect(markup, 'data-diagram-node', 'badged');
  const badge = renderedRect(
    markup,
    'data-diagram-node-caption-frame',
    'badged',
  );

  assert.ok(
    badge.y + badge.h <= node.y,
    'a top-side framed caption should sit above the node top edge',
  );
  assert.ok(
    Math.abs(badge.x + badge.w / 2 - (node.x + node.w / 2)) < 0.01,
    'a top-side framed caption should centre on the node horizontally',
  );
});

test('an unhinted fan-out from a left source to a right column leaves the source by its right side on separate corridors', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Card,
      { key: 'registry', id: 'registry', row: 1, col: 0, rowSpan: 2 },
      createElement(Diagram.Line, null, 'Registry entry'),
      createElement(Diagram.Line, null, 'needsApproval: true'),
    ),
    ...['handler', 'pending', 'timeline', 'continue'].map((id, row) =>
      createElement(Diagram.Card, { key: id, id, row, col: 2 }, id),
    ),
    ...['handler', 'pending', 'timeline', 'continue'].map((id) =>
      createElement(Diagram.Arrow, {
        key: `to-${id}`,
        from: 'registry',
        to: id,
      }),
    ),
  ];

  // Act
  const layout = soundLayout(children);

  // Assert
  const fanOut = layout.edges.filter(({ edge }) => edge.from === 'registry');
  assert.equal(fanOut.length, 4);
  for (const { edge, exitSide } of fanOut) {
    assert.equal(exitSide, 'right', `registry->${edge.to} exit side`);
  }
  for (const [i, a] of fanOut.entries()) {
    for (const b of fanOut.slice(i + 1)) {
      const shared = sharedSegments(a.points, b.points).filter(
        ({ one }) => one.axis === 'x',
      );
      assert.deepEqual(
        shared,
        [],
        `registry->${a.edge.to} and registry->${b.edge.to} share a vertical corridor`,
      );
    }
  }
});

test('a group without an area covers its members, the same as the area of those members given by hand', () => {
  // Arrange
  const members = [
    createElement(
      Diagram.Box,
      { key: 'logs', id: 'logs', row: 0, col: 2 },
      'Logs',
    ),
    createElement(
      Diagram.Box,
      { key: 'metrics', id: 'metrics', row: 1, col: 3 },
      'Metrics',
    ),
  ];

  // Act
  const inferred = render(
    createElement(SvgGraphDiagram, {
      title: 'group-test',
      children: createElement(
        Diagram.Group,
        { id: 'services', label: 'Services' },
        ...members,
      ),
    }),
  );
  const explicit = render(
    createElement(SvgGraphDiagram, {
      title: 'group-test',
      children: createElement(
        Diagram.Group,
        {
          id: 'services',
          label: 'Services',
          row: 0,
          col: 2,
          rowSpan: 2,
          colSpan: 2,
        },
        ...members,
      ),
    }),
  );

  // Assert
  assert.match(inferred, /Services/);
  assert.match(inferred, /Logs/);
  assert.match(inferred, /Metrics/);
  assert.equal(inferred, explicit);
});

test('renders nested infrastructure groups soundly, with a group port, multi-line start-aligned titles and every edge', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'pi', id: 'public-internet', row: 0, col: 2, icon: 'internet' },
      'Public Internet',
    ),
    createElement(
      Diagram.Box,
      { key: 'git', id: 'git-repo', row: 2, col: 4, icon: 'git' },
      'Git Repo',
    ),
    createElement(
      Diagram.Group,
      {
        key: 'cluster',
        id: 'cluster',
        label: ['K3s Kubernetes Cluster', 'North-South + East-West Traffic'],
        labelAlign: 'start',
        ports: [{ id: 'tunnel', side: 'top', label: 'Tunnel' }],
      },
      createElement(
        Diagram.Group,
        {
          key: 'ingress',
          id: 'ingress',
          label: 'Networking & Ingress',
          labelAlign: 'start',
        },
        createElement(
          Diagram.Box,
          { key: 'metallb', id: 'metallb', row: 1, col: 1, icon: 'router' },
          createElement(Diagram.Line, null, 'MetalLB'),
          createElement(Diagram.Line, null, '(Load Balancer)'),
        ),
        createElement(
          Diagram.Box,
          { key: 'gateway', id: 'gateway', row: 1, col: 2, icon: 'shield' },
          createElement(Diagram.Line, null, 'Istio Ingress Gateway'),
          createElement(Diagram.Line, null, '(North-South)'),
        ),
      ),
      createElement(
        Diagram.Group,
        { key: 'mesh', id: 'mesh', label: 'Service Mesh' },
        createElement(
          Diagram.Card,
          {
            key: 'istio',
            id: 'istio',
            row: 2,
            col: 2,
            colSpan: 2,
            icon: 'istio',
          },
          createElement(Diagram.Line, null, 'Istio Service Mesh'),
          createElement(Diagram.Line, { textColor: 'dim' }, 'mTLS Enabled'),
        ),
      ),
      createElement(
        Diagram.Group,
        {
          key: 'storage',
          id: 'storage',
          label: 'Storage',
          labelAlign: 'start',
        },
        createElement(
          Diagram.Box,
          { key: 'longhorn', id: 'longhorn', row: 3, col: 1, icon: 'storage' },
          createElement(Diagram.Line, null, 'Longhorn'),
          createElement(Diagram.Line, null, '(Storage Class)'),
        ),
      ),
      createElement(
        Diagram.Group,
        { key: 'monitoring', id: 'monitoring', label: 'Monitoring' },
        createElement(
          Diagram.Box,
          { key: 'grafana', id: 'grafana', row: 3, col: 2, icon: 'dashboard' },
          'Grafana',
        ),
        createElement(
          Diagram.Box,
          { key: 'victoria', id: 'victoria', row: 3, col: 3, icon: 'metrics' },
          'VictoriaMetrics',
        ),
      ),
    ),
    createElement(
      Diagram.Arrow,
      { key: 'e1', from: 'public-internet', to: 'cluster:tunnel' },
      'Cloudflare Tunnel',
    ),
    createElement(
      Diagram.Arrow,
      { key: 'e2', from: 'metallb', to: 'gateway' },
      'External IPs',
    ),
    createElement(Diagram.Arrow, { key: 'e3', from: 'gateway', to: 'istio' }),
    createElement(Diagram.Arrow, { key: 'e4', from: 'longhorn', to: 'istio' }),
    createElement(Diagram.Arrow, { key: 'e5', from: 'grafana', to: 'istio' }),
    createElement(Diagram.Arrow, { key: 'e6', from: 'victoria', to: 'istio' }),
    createElement(
      Diagram.Arrow,
      { key: 'e7', from: 'git-repo', to: 'istio' },
      'Continuous deploy',
    ),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'homelab-topology-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const cluster = groupOf(layout, 'cluster');
  for (const id of ['ingress', 'mesh', 'storage', 'monitoring']) {
    assert.ok(
      contains(cluster.rect, groupOf(layout, id).rect),
      `the cluster should hold group ${id}`,
    );
  }
  assert.deepEqual(
    renderedTextLines(markup, 'data-diagram-group-label', 'cluster'),
    ['K3s Kubernetes Cluster', 'North-South + East-West Traffic'],
  );
  assert.match(
    markup,
    /<text data-diagram-group-label="cluster"[^>]*text-anchor="start"/,
  );
  assert.match(
    markup,
    /<text data-diagram-group-label="ingress"[^>]*text-anchor="start"/,
  );
  assert.match(markup, /data-diagram-port="cluster:tunnel"/);
  assert.match(markup, />Tunnel</);
  const tunnelPort = first(
    cluster.ports.filter(({ id }) => id === 'tunnel'),
    'the cluster tunnel port',
  );
  assert.deepEqual(
    last(edgeOf(layout, 'public-internet', 'cluster:tunnel').points, 'a point'),
    tunnelPort.point,
    'the tunnel edge should end at the cluster tunnel port',
  );
  for (const icon of [
    'internet',
    'git',
    'router',
    'shield',
    'istio',
    'storage',
    'dashboard',
    'metrics',
  ]) {
    assert.match(markup, new RegExp(`data-diagram-node-icon="${icon}"`), icon);
  }
  assert.equal(
    [...markup.matchAll(/<path data-diagram-edge="/g)].length,
    7,
    'every edge should render',
  );
});

test('a marker draws transparent connectable bounds, its icon above its label, and edges attach to those bounds', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Marker,
      { key: 'repo', id: 'repo', row: 0, col: 0, icon: 'git' },
      'Git Repo',
    ),
    createElement(
      Diagram.Box,
      { key: 'deploy', id: 'deploy', row: 0, col: 1 },
      'Argo',
    ),
    createElement(Diagram.Arrow, { key: 'e', from: 'repo', to: 'deploy' }),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'compact-marker-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.match(markup, /<g data-diagram-marker="repo"/);
  assert.match(
    markup,
    /<rect data-diagram-node="repo" data-diagram-marker-bounds="repo"[^>]*fill="transparent" stroke="none"/,
    'a marker should draw no card frame',
  );
  assert.match(markup, /data-diagram-node-icon="git"/);
  const repo = nodeOf(layout, 'repo');
  assert.ok(repo.icon, 'the marker should hold an icon');
  const label = first(repo.text, 'the marker label');
  assert.ok(
    label.bounds.y >= repo.icon.y + repo.icon.size,
    'the marker label should sit below its icon',
  );
  const edge = edgeOf(layout, 'repo', 'deploy');
  assert.ok(
    onSide(first(edge.points, 'a point'), repo.box, edge.exitSide),
    'the edge should leave from the marker bounds',
  );
});

test('renders node captions outside node frames and includes them in the viewBox', () => {
  // Arrange
  const children = [
    createElement(Diagram.Box, {
      key: 'router',
      id: 'router',
      row: 0,
      col: 0,
      icon: 'router',
      caption: 'Fritzbox Router',
      captionSide: 'bottom',
    }),
    createElement(
      Diagram.Box,
      {
        key: 'adguard',
        id: 'adguard',
        row: 0,
        col: 1,
        caption: ['VM', 'DNS Forwarder'],
        captionSide: 'top',
        captionColor: 'dim',
      },
      'AdGuard Home',
    ),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'node-caption-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const router = nodeOf(layout, 'router');
  const adguard = nodeOf(layout, 'adguard');
  assert.ok(router.caption && adguard.caption, 'both captions should lay out');
  assert.ok(
    router.caption.box.y >= router.box.y + router.box.h,
    'a bottom caption should sit below its node',
  );
  assert.ok(
    adguard.caption.box.y + adguard.caption.box.h <= adguard.box.y,
    'a top caption should sit above its node',
  );
  assert.ok(contains(layout.viewBox, adguard.caption.box));
  assert.ok(contains(layout.viewBox, router.caption.box));
  assert.deepEqual(
    renderedTextLines(markup, 'data-diagram-node-caption', 'adguard'),
    ['VM', 'DNS Forwarder'],
  );
  assert.match(
    markup,
    /<text data-diagram-node-caption="adguard"[^>]*fill="var\(--dgm-dim/,
  );
  assert.deepEqual(
    renderedTextLines(markup, 'data-diagram-node-caption', 'router'),
    ['Fritzbox Router'],
  );
});

test('a framed caption pill holds its text with equal room above and below', () => {
  // Arrange
  const captions = [
    'Workspace agent',
    'SYSTEM ADMINISTRATOR',
    'WORKSPACE AGENT',
    'MMMMMMMMMM',
    'VM',
    'Human',
    'LLM Call',
    'DNS Forwarder',
    'Fritzbox Router',
  ];
  const children = captions.map((caption, i) =>
    createElement(
      Diagram.Box,
      {
        key: caption,
        id: `badge-${i}`,
        row: i,
        col: 0,
        caption,
        captionSide: 'top',
        captionFrame: true,
      },
      'node',
    ),
  );

  // Act
  const layout = soundLayout(children);

  // Assert
  for (const [i, caption] of captions.entries()) {
    const node = nodeOf(layout, `badge-${i}`);
    assert.ok(node.caption?.framed, `${caption} should be framed`);
    const ink = first(node.caption.text, caption).bounds;
    const pill = node.caption.box;
    const above = ink.y - pill.y;
    const below = pill.y + pill.h - (ink.y + ink.h);
    assert.ok(
      Math.abs(above - below) <= 0.5,
      `${caption}: ${above}px above, ${below}px below`,
    );
  }
});

test('renders connector nodes as compact inline topology controls between the edges they join', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'pi', id: 'public-internet', row: 0, col: 0, icon: 'internet' },
      'Public',
    ),
    createElement(
      Diagram.Connector,
      {
        key: 'tunnel',
        id: 'cloudflare-tunnel',
        row: 1,
        col: 0,
        icon: 'tunnel',
        tone: 'blue',
        texture: 'none',
      },
      createElement(Diagram.Line, null, 'Cloudflare Tunnel'),
      createElement(Diagram.Line, { textColor: 'dim' }, '(Zero Trust)'),
    ),
    createElement(
      Diagram.Box,
      { key: 'gateway', id: 'gateway', row: 2, col: 1, icon: 'shield' },
      'Gateway',
    ),
    createElement(Diagram.Wire, {
      key: 'in',
      from: 'public-internet',
      to: 'cloudflare-tunnel',
      channel: 'tunnel',
      weight: 'bold',
      exitSide: 'bottom',
      entrySide: 'top',
    }),
    createElement(Diagram.Arrow, {
      key: 'out',
      from: 'cloudflare-tunnel',
      to: 'gateway',
      channel: 'tunnel',
      weight: 'bold',
      exitSide: 'bottom',
      entrySide: 'top',
    }),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'connector-node-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.match(
    markup,
    /<rect data-diagram-node="cloudflare-tunnel" data-diagram-connector="cloudflare-tunnel" data-diagram-node-tone="blue"/,
  );
  assert.match(markup, /data-diagram-node-icon="tunnel"/);
  assert.deepEqual(
    renderedTextLines(
      markup,
      'data-diagram-connector-label',
      'cloudflare-tunnel',
    ),
    ['Cloudflare Tunnel', '(Zero Trust)'],
  );
  assert.match(
    markup,
    /data-diagram-edge="public-internet-&gt;cloudflare-tunnel"[^>]*data-diagram-edge-channel="tunnel"[^>]*data-diagram-edge-direction="none"[^>]*stroke-width="3"/,
    'the inbound leg should render as a headless bold wire',
  );
  assert.match(
    markup,
    /data-diagram-edge="cloudflare-tunnel-&gt;gateway"[^>]*data-diagram-edge-channel="tunnel"[^>]*data-diagram-edge-direction="forward"[^>]*stroke-width="3"/,
    'the outbound leg should render as the directed bold flow',
  );
  const connector = nodeOf(layout, 'cloudflare-tunnel').box;
  assert.ok(
    onSide(
      last(
        edgeOf(layout, 'public-internet', 'cloudflare-tunnel').points,
        'a point',
      ),
      connector,
      'top',
    ),
    'the inbound wire should end on the connector top edge',
  );
  assert.ok(
    onSide(
      first(edgeOf(layout, 'cloudflare-tunnel', 'gateway').points, 'a point'),
      connector,
      'bottom',
    ),
    'the outbound edge should start on the connector bottom edge',
  );
});

test('renders network appliances as physical chassis nodes that route like any node', () => {
  // Arrange
  const children = [
    createElement(Diagram.Appliance, {
      key: 'router',
      id: 'router',
      row: 0,
      col: 0,
      tone: 'slate',
      texture: 'hatch',
      appliancePorts: 5,
      antenna: true,
      caption: 'Fritzbox Router',
      captionSide: 'bottom',
    }),
    createElement(
      Diagram.Box,
      { key: 'adguard', id: 'adguard', row: 0, col: 1 },
      'AdGuard',
    ),
    createElement(Diagram.Arrow, { key: 'e', from: 'router', to: 'adguard' }),
  ];

  // Act
  soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'network-appliance-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.match(markup, /data-diagram-appliance="router"/);
  assert.match(
    markup,
    /<path data-diagram-node="router" data-diagram-node-tone="slate" data-diagram-appliance-body="router"/,
  );
  assert.match(markup, /data-diagram-appliance-antenna="router"/);
  assert.match(markup, /data-diagram-appliance-face="router"/);
  assert.equal(
    [...markup.matchAll(/data-diagram-appliance-port="router:\d+"/g)].length,
    5,
  );
  assert.match(markup, /data-diagram-node-texture="router:hatch"/);
  assert.match(
    markup,
    /data-diagram-node-caption="router"[\s\S]*Fritzbox Router/,
  );
  assert.match(markup, /data-diagram-edge="router-&gt;adguard"/);
});

test('an edge with exitSide and entrySide leaves and enters by those sides', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 's', id: 'source', row: 0, col: 0 },
      'Source',
    ),
    createElement(
      Diagram.Box,
      { key: 't', id: 'target', row: 1, col: 1 },
      'Target',
    ),
    createElement(Diagram.Arrow, {
      key: 'e',
      from: 'source',
      to: 'target',
      exitSide: 'bottom',
      entrySide: 'left',
    }),
  ];

  // Act
  const layout = soundLayout(children);

  // Assert
  const edge = edgeOf(layout, 'source', 'target');
  assert.equal(edge.exitSide, 'bottom');
  assert.equal(edge.entrySide, 'left');
  assert.ok(
    onSide(
      first(edge.points, 'a point'),
      nodeOf(layout, 'source').box,
      'bottom',
    ),
    'the edge should start on the source bottom side',
  );
});

test('a note beside its target draws its text and a leader that ends on the target', () => {
  // Arrange
  const children = [
    createElement(Diagram.Box, { key: 'db', id: 'db', row: 0, col: 0 }, 'DB'),
    createElement(
      Diagram.Note,
      { key: 'note', id: 'owner', row: 0, col: 1, target: 'db' },
      'Owned by data',
    ),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'note-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.match(
    markup,
    /<text data-diagram-note="owner" data-diagram-note-target="db"[\s\S]*Owned by data/,
  );
  assert.match(
    markup,
    /<path data-diagram-note-leader="owner" data-diagram-note-leader-target="db"/,
  );
  const leader = first(layout.leaders, 'a leader');
  const db = nodeOf(layout, 'db').box;
  const end = last(leader.points, 'a leader point');
  assert.ok(
    ['top', 'bottom', 'left', 'right'].some((side) => onSide(end, db, side)),
    `the leader should end on the db frame, got ${JSON.stringify(end)}`,
  );
});

test('a note without a target draws its lines and no leader', () => {
  // Arrange
  const children = [
    createElement(Diagram.Box, { key: 'db', id: 'db', row: 0, col: 0 }, 'DB'),
    createElement(
      Diagram.Note,
      { key: 'note', id: 'legend', row: 1, col: 0 },
      createElement(Diagram.Line, null, 'Dashed lines'),
      createElement(Diagram.Line, { textColor: 'dim' }, 'are optional'),
    ),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'legend-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.deepEqual(layout.leaders, []);
  assert.deepEqual(renderedTextLines(markup, 'data-diagram-note', 'legend'), [
    'Dashed lines',
    'are optional',
  ]);
  assert.doesNotMatch(markup, /data-diagram-note-leader=/);
});

test('notes in a callout column beside a cluster lead to their targets without crossing any node', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Group,
      { key: 'cluster', id: 'cluster', label: 'Cluster', titleBand: true },
      createElement(
        Diagram.Box,
        { key: 'cert', id: 'cert', row: 0, col: 0 },
        'Cert-Manager',
      ),
      createElement(
        Diagram.Box,
        { key: 'auth', id: 'auth', row: 1, col: 1 },
        'Authentik',
      ),
      createElement(
        Diagram.Box,
        { key: 'argo', id: 'argo', row: 2, col: 0 },
        'ArgoCD',
      ),
    ),
    createElement(
      Diagram.Note,
      { key: 'n1', id: 'cert-note', row: 0, col: 2, target: 'cert' },
      createElement(Diagram.Line, null, 'Manages'),
      createElement(Diagram.Line, null, "Let's Encrypt certificates"),
    ),
    createElement(
      Diagram.Note,
      { key: 'n2', id: 'auth-note', row: 1, col: 2, target: 'auth' },
      'SSO for the mesh',
    ),
    createElement(
      Diagram.Note,
      { key: 'n3', id: 'argo-note', row: 2, col: 2, target: 'argo' },
      'Deploys applications',
    ),
    createElement(
      Diagram.Note,
      { key: 'n4', id: 'cluster-note', row: 3, col: 0, target: 'cluster' },
      'Storage boundary',
    ),
  ];

  // Act
  const layout = soundLayout(children);

  // Assert
  assert.deepEqual(
    layout.leaders.map(({ note, target }) => `${note}->${target}`).sort(),
    [
      'argo-note->argo',
      'auth-note->auth',
      'cert-note->cert',
      'cluster-note->cluster',
    ],
  );
});

test('rejects a note whose target is not a node or group', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: [
            createElement(Diagram.Box, { id: 'db', row: 0, col: 0 }, 'DB'),
            createElement(
              Diagram.Note,
              { id: 'orphan', row: 0, col: 1, target: 'missing' },
              'Missing target',
            ),
          ],
        }),
      ),
    /"missing" is not a node or a group/,
  );
});

test('stacked frames fan out behind a node in their direction and stay inside the viewBox', () => {
  for (const [direction, dx, dy] of [
    ['up-right', 1, -1],
    ['up-left', -1, -1],
    ['down-right', 1, 1],
    ['down-left', -1, 1],
  ] as const) {
    // Arrange
    const children = createElement(
      Diagram.Card,
      {
        id: 'vm',
        row: 0,
        col: 0,
        stack: 3,
        stackDirection: direction,
        caption: 'Hosted VM',
        captionSide: 'top',
      },
      createElement(Diagram.Line, null, 'VM'),
      createElement(Diagram.Line, { textColor: 'dim' }, 'K3s worker'),
    );

    // Act
    const layout = soundLayout(children);
    const markup = render(
      createElement(SvgGraphDiagram, {
        title: 'stacked-vm-test',
        defaultMode: 'static',
        children,
      }),
    );

    // Assert
    const vm = nodeOf(layout, 'vm');
    assert.equal(vm.frames.length, 2, direction);
    for (const frame of vm.frames) {
      assert.equal(Math.sign(frame.x - vm.box.x), dx, `${direction} x`);
      assert.equal(Math.sign(frame.y - vm.box.y), dy, `${direction} y`);
      assert.ok(contains(layout.viewBox, frame), `${direction} in viewBox`);
    }
    assert.notDeepEqual(vm.frames[0], vm.frames[1], `${direction} fans out`);
    assert.match(markup, /data-diagram-node-stack="vm:1"/);
    assert.match(markup, /data-diagram-node-stack="vm:2"/);
    assert.doesNotMatch(markup, /data-diagram-node-stack="vm:3"/);
  }
});

test('renders node body item lists and descriptions as rows inside the card', () => {
  // Arrange
  const laptopItems = [
    '32GB RAM',
    '500GB SSD (Internal)',
    'NVIDIA RTX 3050 4GB GPU',
    'CPU 24 Logical Cores',
  ];
  const gpuItems = ['K3s Node Affinity', 'Automatic GPU Scheduling'];
  const children = [
    createElement(
      Diagram.Card,
      {
        key: 'laptop',
        id: 'laptop',
        row: 0,
        col: 0,
        icon: 'server',
        items: laptopItems,
      },
      'Dell Laptop',
    ),
    createElement(
      Diagram.Card,
      {
        key: 'gpu',
        id: 'gpu',
        row: 0,
        col: 1,
        icon: 'gpu',
        description: ['GPU Workflow', 'NVIDIA RTX 3050'],
        items: gpuItems,
      },
      'GPU Scheduling',
    ),
  ];

  // Act
  soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'node-items-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  for (const [nodeId, items] of [
    ['laptop', laptopItems],
    ['gpu', gpuItems],
  ] as const) {
    let previousY = -Infinity;
    for (const [i, item] of items.entries()) {
      const row = markup.match(
        new RegExp(
          `<g data-diagram-node-item="${nodeId}:${i}">[\\s\\S]*?<text[^>]* y="(-?[\\d.]+)"[^>]*>${escapeRegExp(item)}`,
        ),
      );
      assert.ok(row?.[1], `${nodeId} item ${i} should render as a row`);
      assert.ok(Number(row[1]) > previousY, `${nodeId} rows run downward`);
      previousY = Number(row[1]);
    }
  }
  assert.deepEqual(
    renderedTextLines(markup, 'data-diagram-node-description', 'gpu'),
    ['GPU Workflow', 'NVIDIA RTX 3050'],
  );
});

test('renders group frame variants and a divider through each gutter inside the group', () => {
  // Arrange
  const children = createElement(
    Diagram.Group,
    {
      id: 'matrix',
      label: 'Matrix',
      frame: 'dashed',
      fill: 'none',
      dividers: true,
    },
    createElement(Diagram.Box, { key: 'a', id: 'a', row: 0, col: 0 }, 'A'),
    createElement(Diagram.Box, { key: 'b', id: 'b', row: 1, col: 1 }, 'B'),
  );

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-divider-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.match(
    markup,
    /<rect data-diagram-group="matrix"[^>]*fill="none"[^>]*stroke-dasharray="6 6"/,
  );
  const matrix = groupOf(layout, 'matrix');
  assert.equal(
    matrix.dividers.length,
    2,
    'one row gutter and one column gutter',
  );
  for (const [i, [a, b]] of matrix.dividers.entries()) {
    assert.match(
      markup,
      new RegExp(`data-diagram-group-divider="matrix:${i}"`),
    );
    for (const point of [a, b]) {
      assert.ok(
        contains(matrix.rect, { ...point, w: 0, h: 0 }),
        `divider ${i}`,
      );
    }
  }
});

test('rejects dividers on a group of one cell', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: createElement(
            Diagram.Group,
            { id: 'matrix', label: 'Matrix', dividers: true },
            createElement(Diagram.Box, { id: 'a', row: 0, col: 0 }, 'A'),
          ),
        }),
      ),
    /Diagram group "matrix" has dividers, but its area is the one cell/,
  );
});

test('a group title band spans the top of the group, holds the label, and sits above every member', () => {
  // Arrange
  const children = createElement(
    Diagram.Group,
    { id: 'cluster', label: 'Cluster', titleBand: true },
    createElement(
      Diagram.Box,
      { key: 's', id: 'service', row: 0, col: 0 },
      'Service',
    ),
  );

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-title-band-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const group = renderedRect(markup, 'data-diagram-group', 'cluster');
  const band = renderedRect(markup, 'data-diagram-group-title-band', 'cluster');
  const service = renderedRect(markup, 'data-diagram-node', 'service');
  assert.equal(band.x, group.x);
  assert.equal(band.y, group.y);
  assert.equal(band.w, group.w);
  const label = first(groupOf(layout, 'cluster').label, 'the group label');
  assert.ok(contains(band, label.bounds), 'the label should sit in the band');
  assert.ok(
    service.y >= band.y + band.h,
    'the member should sit below the band',
  );
  assert.match(
    markup,
    new RegExp(
      `<line data-diagram-group-title-separator="cluster"[^>]*y1="${band.y + band.h}"[^>]*y2="${band.y + band.h}"`,
    ),
  );
});

test('routes edges to named node ports, starting and ending at the port points', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'c', id: 'client', row: 0, col: 0 },
      'Client',
    ),
    createElement(
      Diagram.Card,
      {
        key: 's',
        id: 'service',
        row: 0,
        col: 1,
        ports: [
          { id: 'http', side: 'left', label: 'HTTP' },
          { id: 'events', side: 'right', label: 'EVT', accent: true },
          { id: 'sql', side: 'bottom', label: 'SQL' },
        ],
      },
      'Service',
    ),
    createElement(Diagram.Box, { key: 'b', id: 'bus', row: 0, col: 2 }, 'Bus'),
    createElement(Diagram.Box, { key: 'd', id: 'db', row: 1, col: 1 }, 'DB'),
    createElement(Diagram.Arrow, {
      key: 'e1',
      from: 'client',
      to: 'service:http',
    }),
    createElement(Diagram.Arrow, {
      key: 'e2',
      from: 'service:events',
      to: 'bus',
    }),
    createElement(Diagram.Arrow, { key: 'e3', from: 'db', to: 'service:sql' }),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'node-port-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  for (const [port, label] of [
    ['http', 'HTTP'],
    ['events', 'EVT'],
    ['sql', 'SQL'],
  ]) {
    assert.match(markup, new RegExp(`data-diagram-port="service:${port}"`));
    assert.match(markup, new RegExp(`>${label}<`));
  }
  const ports = new Map(
    nodeOf(layout, 'service').ports.map(({ id, point }) => [id, point]),
  );
  assert.deepEqual(
    last(edgeOf(layout, 'client', 'service:http').points, 'a point'),
    ports.get('http'),
  );
  assert.deepEqual(
    first(edgeOf(layout, 'service:events', 'bus').points, 'a point'),
    ports.get('events'),
  );
  assert.deepEqual(
    last(edgeOf(layout, 'db', 'service:sql').points, 'a point'),
    ports.get('sql'),
  );
});

test('junction nodes merge bundled branches into one trunk at the junction', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'l', id: 'logs', row: 0, col: 0 },
      'Logs',
    ),
    createElement(
      Diagram.Box,
      { key: 'm', id: 'metrics', row: 2, col: 0 },
      'Metrics',
    ),
    createElement(Diagram.Junction, {
      key: 'j',
      id: 'obs-bus',
      row: 1,
      col: 1,
      tone: 'blue',
    }),
    createElement(
      Diagram.Box,
      { key: 'mesh', id: 'mesh', row: 1, col: 2 },
      'Mesh',
    ),
    createElement(Diagram.Arrow, {
      key: 'e1',
      from: 'logs',
      to: 'obs-bus',
      headless: true,
    }),
    createElement(Diagram.Arrow, {
      key: 'e2',
      from: 'metrics',
      to: 'obs-bus',
      headless: true,
    }),
    createElement(Diagram.Arrow, { key: 'e3', from: 'obs-bus', to: 'mesh' }),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'junction-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const { box: junction, radius } = nodeOf(layout, 'obs-bus');
  assert.equal(radius, junction.w / 2, 'the junction should draw as a circle');
  assert.match(
    markup,
    new RegExp(
      `<rect data-diagram-junction="obs-bus" x="${junction.x}" y="${junction.y}" width="${junction.w}" height="${junction.h}" rx="${radius}"[^>]*stroke="var\\(--dgm-tone-blue-stroke`,
    ),
  );
  const branch = markup.match(
    /<path data-diagram-edge="logs-&gt;obs-bus"[^>]*>/,
  );
  assert.ok(branch, 'the logs branch should render');
  assert.doesNotMatch(
    branch[0],
    /marker-end=/,
    'a headless branch draws no arrowhead into the junction',
  );
  assert.equal(
    layout.edges.filter(({ edge }) => edge.from === 'obs-bus').length,
    1,
    'one trunk leaves the junction',
  );
});

test('hidden junctions stay routable without rendering a visible marker', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 's', id: 'source', row: 0, col: 0 },
      'Source',
    ),
    createElement(Diagram.Junction, {
      key: 'j',
      id: 'bus',
      row: 0,
      col: 1,
      hidden: true,
    }),
    createElement(
      Diagram.Box,
      { key: 't', id: 'target', row: 0, col: 2 },
      'Target',
    ),
    createElement(Diagram.Arrow, {
      key: 'e1',
      from: 'source',
      to: 'bus',
      headless: true,
    }),
    createElement(Diagram.Arrow, { key: 'e2', from: 'bus', to: 'target' }),
  ];

  // Act
  soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'hidden-junction-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.doesNotMatch(markup, /data-diagram-junction="bus"/);
  assert.match(markup, /data-diagram-edge="source-&gt;bus"/);
  assert.match(markup, /data-diagram-edge="bus-&gt;target"/);
});

test('routes edges to a group boundary and from a named group port', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'c', id: 'client', row: 0, col: 0 },
      'Client',
    ),
    createElement(
      Diagram.Group,
      {
        key: 'g',
        id: 'services',
        label: 'Services',
        ports: [{ id: 'egress', side: 'right', label: 'OUT', accent: true }],
      },
      createElement(
        Diagram.Box,
        { key: 'api', id: 'api', row: 0, col: 1 },
        'API',
      ),
      createElement(Diagram.Box, { key: 'db', id: 'db', row: 1, col: 2 }, 'DB'),
    ),
    createElement(
      Diagram.Box,
      { key: 'sink', id: 'sink', row: 0, col: 4 },
      'Sink',
    ),
    createElement(Diagram.Arrow, { key: 'e1', from: 'client', to: 'services' }),
    createElement(Diagram.Arrow, {
      key: 'e2',
      from: 'services:egress',
      to: 'sink',
    }),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-endpoint-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.match(markup, /data-diagram-port="services:egress"/);
  assert.match(markup, />OUT</);
  // The oracle (E4) holds that client->services ends on a side of the group rect.
  const services = groupOf(layout, 'services');
  assert.deepEqual(
    first(edgeOf(layout, 'services:egress', 'sink').points, 'a point'),
    first(services.ports, 'the egress port').point,
  );
});

test('dense crossing edges keep separate corridors', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'tl', id: 'top-left', row: 0, col: 0 },
      'Top left',
    ),
    createElement(
      Diagram.Box,
      { key: 'bl', id: 'bottom-left', row: 2, col: 0 },
      'Bottom left',
    ),
    createElement(
      Diagram.Box,
      { key: 'tr', id: 'top-right', row: 0, col: 2 },
      'Top right',
    ),
    createElement(
      Diagram.Box,
      { key: 'br', id: 'bottom-right', row: 2, col: 2 },
      'Bottom right',
    ),
    createElement(
      Diagram.Box,
      { key: 'c', id: 'center', row: 1, col: 1 },
      'Center',
    ),
    createElement(Diagram.Arrow, {
      key: 'e1',
      from: 'top-left',
      to: 'bottom-right',
    }),
    createElement(Diagram.Arrow, {
      key: 'e2',
      from: 'bottom-left',
      to: 'top-right',
    }),
  ];

  // Act
  const layout = soundLayout(children);

  // Assert
  assert.deepEqual(
    sharedSegments(
      edgeOf(layout, 'top-left', 'bottom-right').points,
      edgeOf(layout, 'bottom-left', 'top-right').points,
    ),
    [],
  );
});

test('labels on parallel edges in one gutter never cover each other or a node', () => {
  // Arrange
  const names = ['a', 'b'];
  const children = [
    createElement(
      Diagram.Box,
      { key: 's', id: 'source', row: 0, col: 0 },
      'Source',
    ),
    createElement(
      Diagram.Box,
      { key: 't', id: 'target', row: 0, col: 1 },
      'Target',
    ),
    ...names.map((name) =>
      createElement(
        Diagram.Arrow,
        { key: `e-${name}`, from: 'source', to: 'target', labelFrame: true },
        `Shared corridor ${name}`,
      ),
    ),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'label-deconflict-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.deepEqual(
    layout.edges.map(({ label }) => label?.text.map(({ text }) => text)),
    names.map((name) => [`Shared corridor ${name}`]),
  );
  assert.equal(
    [...markup.matchAll(/data-diagram-edge-label-frame="source-&gt;target"/g)]
      .length,
    2,
  );
});

test('edge badges draw their icon and lines beside the routed edge, inside the viewBox', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'pi', id: 'public-internet', row: 0, col: 0, icon: 'internet' },
      'Public Internet',
    ),
    createElement(
      Diagram.Box,
      { key: 'k', id: 'cluster', row: 2, col: 0, icon: 'kubernetes' },
      'K3s Cluster',
    ),
    createElement(Diagram.Arrow, {
      key: 'e',
      from: 'public-internet',
      to: 'cluster',
      badgeIcon: 'tunnel',
      badgeLabel: [
        'Cloudflare Tunnel',
        '(Zero Trust)',
        'encrypted tunnel to the private cluster',
      ],
    }),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-badge-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const badge = edgeOf(layout, 'public-internet', 'cluster').badge;
  assert.ok(badge?.icon, 'the badge should hold an icon');
  assert.deepEqual(
    badge.text.map(({ text }) => text),
    [
      'Cloudflare Tunnel',
      '(Zero Trust)',
      'encrypted tunnel to the private cluster',
    ],
  );
  assert.ok(contains(layout.viewBox, badge.box));
  assert.match(
    markup,
    /<g data-diagram-edge-badge="public-internet-&gt;cluster"[\s\S]*data-diagram-node-icon="tunnel"/,
  );
  assert.match(markup, /Cloudflare Tunnel/);
  assert.match(markup, /\(Zero Trust\)/);
});

test('the viewBox holds the drawn frame of every edge label', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'o', id: 'orders', row: 0, col: 0 },
      'Orders',
    ),
    createElement(
      Diagram.Box,
      { key: 'b', id: 'billing', row: 1, col: 0 },
      'Billing',
    ),
    createElement(
      Diagram.Arrow,
      { key: 'e', from: 'orders', to: 'billing', labelFrame: true },
      createElement(Diagram.Line, null, 'Distributed invoices and backups'),
      createElement(Diagram.Line, null, 'every hour'),
    ),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'label-frame-viewbox-test',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const frame = renderedRect(
    markup,
    'data-diagram-edge-label-frame',
    'orders-&gt;billing',
  );
  assert.ok(contains(svgViewBox(markup), frame));
  assert.deepEqual(
    edgeOf(layout, 'orders', 'billing').label?.text.map(({ text }) => text),
    ['Distributed invoices and backups', 'every hour'],
  );
});

test('renders the homelab reference diagram soundly, with its icons, its paper and every node', () => {
  // Arrange
  const line = (text: string, textColor?: 'dim') =>
    createElement(Diagram.Line, textColor ? { textColor } : null, text);
  const children = [
    createElement(
      Diagram.Box,
      {
        key: 'cloudflare-dns',
        id: 'cloudflare-dns',
        row: 0,
        col: 3,
        icon: 'cloudflare',
        tone: 'amber',
        texture: 'hatch',
      },
      line('Cloudflare'),
      line('DNS & Domain'),
      line('Management'),
    ),
    createElement(
      Diagram.Box,
      {
        key: 'public-internet',
        id: 'public-internet',
        row: 0,
        col: 4,
        icon: 'internet',
      },
      'Public Internet',
    ),
    createElement(
      Diagram.Connector,
      {
        key: 'cloudflare-tunnel',
        id: 'cloudflare-tunnel',
        row: 1,
        col: 4,
        icon: 'tunnel',
      },
      line('Cloudflare Tunnel'),
      line('(Zero Trust)', 'dim'),
    ),
    createElement(
      Diagram.Box,
      {
        key: 'adguard',
        id: 'adguard',
        row: 2,
        col: 2,
        icon: 'shield',
        caption: 'DNS Forwarder',
      },
      'AdGuard Home',
    ),
    createElement(
      Diagram.Note,
      {
        key: 'cert-note',
        id: 'cert-note',
        row: 2,
        col: 7,
        target: 'cert-manager',
      },
      line('Manages'),
      line("Let's Encrypt"),
      line('certificates'),
    ),
    createElement(
      Diagram.Box,
      { key: 'isp', id: 'isp', row: 3, col: 0, icon: 'internet' },
      line('ISP Connection'),
      line('(1 Gbps)'),
    ),
    createElement(Diagram.Appliance, {
      key: 'router',
      id: 'router',
      row: 3,
      col: 1,
      appliancePorts: 5,
      antenna: true,
      caption: 'Fritzbox Router',
    }),
    createElement(
      Diagram.Note,
      {
        key: 'authentik-note',
        id: 'authentik-note',
        row: 3,
        col: 7,
        target: 'authentik',
      },
      line('Authentication'),
      line('for services'),
      line('in mesh'),
    ),
    createElement(
      Diagram.Group,
      {
        key: 'proxmox',
        id: 'proxmox',
        label: ['Proxmox VE', '(Hypervisor)'],
        titleBand: true,
      },
      createElement(
        Diagram.Card,
        {
          key: 'proxmox-vm',
          id: 'proxmox-vm',
          row: 4,
          col: 2,
          rowSpan: 2,
          icon: 'server',
          stack: 4,
        },
        'VM',
      ),
    ),
    createElement(
      Diagram.Marker,
      { key: 'git-repo', id: 'git-repo', row: 4, col: 7, icon: 'git' },
      'Git Repo',
    ),
    createElement(
      Diagram.Card,
      {
        key: 'laptop',
        id: 'laptop',
        row: 5,
        col: 0,
        rowSpan: 2,
        colSpan: 2,
        icon: 'server',
        items: [
          '32GB RAM',
          '500GB SSD (Internal)',
          'NVIDIA RTX 3050 4GB GPU',
          'CPU 24 Logical Cores',
        ],
      },
      'Dell Laptop',
    ),
    createElement(
      Diagram.Box,
      {
        key: 'external-ssd',
        id: 'external-ssd',
        row: 6,
        col: 2,
        icon: 'storage',
      },
      line('4TB'),
      line('External SSD'),
    ),
    createElement(
      Diagram.Group,
      {
        key: 'cluster',
        id: 'cluster',
        label: 'K3s Kubernetes Cluster',
        labelAlign: 'start',
        titleBand: true,
        texture: 'hatch',
      },
      createElement(
        Diagram.Group,
        {
          key: 'ingress',
          id: 'ingress',
          label: 'Networking & Ingress',
          labelAlign: 'start',
          titleBand: true,
        },
        createElement(
          Diagram.Box,
          { key: 'metallb', id: 'metallb', row: 2, col: 3, icon: 'router' },
          line('MetalLB'),
          line('(Load Balancer)'),
        ),
        createElement(
          Diagram.Box,
          { key: 'gateway', id: 'gateway', row: 2, col: 4, icon: 'shield' },
          line('Istio Ingress Gateway'),
          line('(North-South Gateway)'),
        ),
      ),
      createElement(
        Diagram.Group,
        {
          key: 'certificates',
          id: 'certificates',
          label: 'Certificates',
          titleBand: true,
        },
        createElement(
          Diagram.Box,
          {
            key: 'cert-manager',
            id: 'cert-manager',
            row: 2,
            col: 5,
            icon: 'certificate',
          },
          'Cert-Manager',
        ),
      ),
      createElement(
        Diagram.Group,
        { key: 'k3s-vms', id: 'k3s-vms', label: 'K3s', titleBand: true },
        createElement(
          Diagram.Card,
          {
            key: 'k3s-master',
            id: 'k3s-master',
            row: 3,
            col: 3,
            icon: 'kubernetes',
          },
          line('K3s master'),
          line('Pods'),
        ),
      ),
      createElement(
        Diagram.Group,
        { key: 'mesh', id: 'mesh', label: 'Service Mesh', titleBand: true },
        createElement(
          Diagram.Card,
          {
            key: 'istio',
            id: 'istio',
            row: 3,
            col: 4,
            colSpan: 2,
            icon: 'istio',
          },
          line('Istio Service Mesh'),
          line('mTLS Enabled', 'dim'),
        ),
      ),
      createElement(
        Diagram.Box,
        { key: 'authentik', id: 'authentik', row: 3, col: 6, icon: 'shield' },
        line('Authentik'),
        line('(SSO)'),
      ),
      createElement(Diagram.Junction, {
        key: 'observability-bus',
        id: 'observability-bus',
        row: 4,
        col: 4,
        colSpan: 2,
        hidden: true,
      }),
      createElement(
        Diagram.Box,
        { key: 'argocd', id: 'argocd', row: 4, col: 6, icon: 'git' },
        line('ArgoCD'),
        line('(GitOps Deployment)'),
      ),
      createElement(
        Diagram.Group,
        {
          key: 'storage',
          id: 'storage',
          label: 'Storage',
          labelAlign: 'start',
          titleBand: true,
        },
        createElement(
          Diagram.Box,
          { key: 'longhorn', id: 'longhorn', row: 5, col: 3, icon: 'storage' },
          line('Longhorn'),
          line('(Storage Class)'),
        ),
      ),
      createElement(
        Diagram.Group,
        {
          key: 'monitoring',
          id: 'monitoring',
          label: 'Monitoring',
          titleBand: true,
          dividers: true,
        },
        createElement(
          Diagram.Box,
          { key: 'grafana', id: 'grafana', row: 5, col: 4, icon: 'dashboard' },
          line('Grafana'),
          line('(Dashboards)'),
        ),
        createElement(
          Diagram.Box,
          {
            key: 'victoria-metrics',
            id: 'victoria-metrics',
            row: 5,
            col: 5,
            icon: 'metrics',
          },
          line('VictoriaMetrics'),
          line('(Metrics)'),
        ),
        createElement(
          Diagram.Box,
          {
            key: 'victoria-logs',
            id: 'victoria-logs',
            row: 6,
            col: 4,
            icon: 'logs',
          },
          line('VictoriaLogs'),
          line('(Logs)'),
        ),
        createElement(
          Diagram.Box,
          { key: 'jaeger', id: 'jaeger', row: 6, col: 5, icon: 'trace' },
          line('Jaeger'),
          line('(Traces)'),
        ),
      ),
      createElement(
        Diagram.Note,
        {
          key: 'argocd-note',
          id: 'argocd-note',
          row: 5,
          col: 6,
          target: 'argocd',
        },
        line('Deploys applications'),
        line('into k3s'),
      ),
      createElement(
        Diagram.Group,
        {
          key: 'gpu-scheduling',
          id: 'gpu-scheduling',
          label: 'GPU Scheduling',
          labelAlign: 'start',
          titleBand: true,
        },
        createElement(
          Diagram.Card,
          {
            key: 'gpu-workflow',
            id: 'gpu-workflow',
            row: 6,
            col: 6,
            icon: 'gpu',
            description: 'NVIDIA RTX 3050',
            items: ['K3s Node Affinity', 'Automatic GPU Scheduling'],
          },
          'GPU Workflow',
        ),
      ),
    ),
    ...(
      [
        { from: 'cloudflare-dns', to: 'public-internet' },
        { from: 'public-internet', to: 'cloudflare-tunnel' },
        { from: 'cloudflare-tunnel', to: 'gateway' },
        { from: 'isp', to: 'router' },
        { from: 'router', to: 'adguard', exitSide: 'right', entrySide: 'left' },
        { from: 'router', to: 'laptop', exitSide: 'left' },
        { from: 'router', to: 'proxmox', exitSide: 'right' },
        { from: 'laptop', to: 'external-ssd' },
        {
          from: 'external-ssd',
          to: 'longhorn',
          lineStyle: 'dashed',
          label: 'Distributed Storage & Backups',
        },
        { from: 'proxmox', to: 'k3s-master' },
        {
          from: 'metallb',
          to: 'gateway',
          label: 'External IPs',
          labelFrame: true,
        },
        { from: 'gateway', to: 'istio', direction: 'both' },
        { from: 'k3s-master', to: 'istio' },
        {
          from: 'cert-manager',
          to: 'gateway',
          lineStyle: 'dashed',
          label: ["Let's Encrypt", 'certificates'],
          labelFrame: true,
        },
        { from: 'authentik', to: 'istio', label: 'SSO', labelFrame: true },
        { from: 'argocd', to: 'istio', label: 'Deploys', labelFrame: true },
        {
          from: 'git-repo',
          to: 'argocd',
          lineStyle: 'dashed',
          label: ['Continuous deployment', 'requests'],
        },
        { from: 'longhorn', to: 'istio' },
        { from: 'grafana', to: 'observability-bus', headless: true },
        { from: 'victoria-metrics', to: 'observability-bus', headless: true },
        { from: 'victoria-logs', to: 'observability-bus', headless: true },
        { from: 'jaeger', to: 'observability-bus', headless: true },
        { from: 'observability-bus', to: 'istio' },
        { from: 'gpu-scheduling', to: 'istio' },
      ] satisfies (DiagramEdgeProps & { label?: string | string[] })[]
    ).map(({ label, ...edge }, i) =>
      createElement(
        Diagram.Arrow,
        { key: `edge-${i}`, ...edge },
        ...(typeof label === 'string'
          ? [label]
          : (label ?? []).map((text) => line(text))),
      ),
    ),
  ];

  // Act
  const layout = soundLayout(children);
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: ['Homelab K3s reference', 'Zero-trust service platform'],
      defaultMode: 'static',
      showHeader: false,
      stylePreset: 'sketch',
      paper: true,
      children,
    }),
  );

  // Assert
  for (const { node } of layout.nodes.filter(({ node }) => !node.hidden)) {
    assert.match(
      markup,
      new RegExp(`data-diagram-(?:node|note)="${escapeRegExp(node.id)}"`),
      `node ${node.id} should render`,
    );
  }
  for (const icon of [
    'cloudflare',
    'internet',
    'tunnel',
    'shield',
    'router',
    'certificate',
    'kubernetes',
    'istio',
    'server',
    'git',
    'storage',
    'dashboard',
    'metrics',
    'logs',
    'trace',
    'gpu',
  ]) {
    assert.match(markup, new RegExp(`data-diagram-node-icon="${icon}"`), icon);
  }
  assert.deepEqual(
    renderedRect(markup, 'data-diagram-paper', 'graph'),
    svgViewBox(markup),
    'the paper should cover the whole viewBox',
  );
  assert.match(markup, /data-diagram-group-texture="cluster:hatch"/);
  assert.match(markup, /data-diagram-style-preset="sketch"/);
  assert.equal(
    [...markup.matchAll(/<path data-diagram-edge="/g)].length,
    layout.edges.length,
  );
});

test('boxed signal renders an enclosing rect around the label; unboxed does not', () => {
  const boxedMarkup = render(
    createElement(SvgTimelineDiagram, {
      title: 'boxed-test',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          { from: 'codex', to: 'chrome', accent: true, boxed: true },
          createElement(Diagram.Line, null, 'Select target'),
          createElement(Diagram.Line, null, '+ clear console'),
        ),
      ],
    }),
  );

  const plainMarkup = render(
    createElement(SvgTimelineDiagram, {
      title: 'plain-test',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          { from: 'codex', to: 'chrome', accent: true },
          createElement(Diagram.Line, null, 'Select target'),
          createElement(Diagram.Line, null, '+ clear console'),
        ),
      ],
    }),
  );

  const boxedRectCount = (boxedMarkup.match(/<rect /g) ?? []).length;
  const plainRectCount = (plainMarkup.match(/<rect /g) ?? []).length;
  assert.ok(
    boxedRectCount > plainRectCount,
    `boxed signal should emit additional <rect> for the label container (boxed=${boxedRectCount}, plain=${plainRectCount})`,
  );
  assert.match(boxedMarkup, /Select target/);
  assert.match(boxedMarkup, /\+ clear console/);
});

test('boxed signal emits two path stubs (split geometry); plain signal emits one', () => {
  const boxedMarkup = render(
    createElement(SvgTimelineDiagram, {
      title: 'boxed-paths',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          { from: 'codex', to: 'chrome', accent: true, boxed: true },
          'Select target',
        ),
      ],
    }),
  );

  const plainMarkup = render(
    createElement(SvgTimelineDiagram, {
      title: 'plain-paths',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          { from: 'codex', to: 'chrome', accent: true },
          'Select target',
        ),
      ],
    }),
  );

  const boxedPathCount = (boxedMarkup.match(/<path /g) ?? []).length;
  const plainPathCount = (plainMarkup.match(/<path /g) ?? []).length;
  assert.equal(
    boxedPathCount - plainPathCount,
    1,
    `boxed signal must emit exactly one additional <path> (split geometry: source-stub + target-stub vs single line). boxed=${boxedPathCount}, plain=${plainPathCount}`,
  );
});

test('boxed signal puts the arrowhead only on the target-side stub, never through the box', () => {
  const markup = render(
    createElement(SvgTimelineDiagram, {
      title: 'marker-test',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          { from: 'codex', to: 'chrome', accent: true, boxed: true },
          'Select target',
        ),
      ],
    }),
  );

  const signalPaths = [
    ...markup.matchAll(
      /<path [^>]*d="M [1-9][^"]*"[^>]*stroke-width="1\.5"[^>]*>/g,
    ),
  ].map((m) => m[0]);
  assert.equal(signalPaths.length, 2, 'boxed signal has two signal paths');
  const withMarker = signalPaths.filter((p) => /marker-end=/.test(p));
  assert.equal(
    withMarker.length,
    1,
    `exactly one signal path may carry marker-end (the target-side stub); got ${withMarker.length} of ${signalPaths.length} signal paths`,
  );
});

test('boxed="target" mirrors the box toward the target lifeline', () => {
  const renderWith = (position: 'source' | 'target') =>
    render(
      createElement(SvgTimelineDiagram, {
        title: `pos-${position}`,
        children: [
          createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
          createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
          createElement(
            Diagram.Signal,
            { from: 'codex', to: 'chrome', accent: true, boxed: position },
            'Select target',
          ),
        ],
      }),
    );

  const rectX = (markup: string) => {
    const m = markup.match(/<rect[^>]*\sx="(\d+(?:\.\d+)?)"[^>]*rx="10"/);
    if (!m) throw new Error('no label rect with rx=10 found');
    return Number(m[1]);
  };

  const sourceX = rectX(renderWith('source'));
  const targetX = rectX(renderWith('target'));
  assert.ok(
    targetX > sourceX,
    `boxed="target" rect x (${targetX}) must be greater than boxed="source" rect x (${sourceX}) for L→R signal`,
  );
});

test('boxed signal whose label cannot fit between adjacent lanes throws during render', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgTimelineDiagram, {
          title: 'overflow',
          children: [
            createElement(Diagram.Lane, { id: 'a' }, 'A'),
            createElement(Diagram.Lane, { id: 'b' }, 'B'),
            createElement(Diagram.Lane, { id: 'c' }, 'C'),
            createElement(Diagram.Lane, { id: 'd' }, 'D'),
            createElement(
              Diagram.Signal,
              { from: 'a', to: 'b', boxed: true },
              'this label is far too wide to fit between two adjacent lifelines and should force the geometry function to refuse',
            ),
          ],
        }),
      ),
    /overflows the lane distance/,
  );
});

test('boxed signal with bordered={false} renders the label rect without a stroke', () => {
  const bordered = render(
    createElement(SvgTimelineDiagram, {
      title: 'bordered-on',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          { from: 'codex', to: 'chrome', accent: true, boxed: true },
          'Select target',
        ),
      ],
    }),
  );
  const borderless = render(
    createElement(SvgTimelineDiagram, {
      title: 'bordered-off',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          {
            from: 'codex',
            to: 'chrome',
            accent: true,
            boxed: true,
            bordered: false,
          },
          'Select target',
        ),
      ],
    }),
  );

  const labelRect = (markup: string): string => {
    const m = markup.match(/<rect[^>]*rx="10"[^>]*>/);
    if (!m) throw new Error('no rx=10 label rect');
    return m[0];
  };

  assert.match(labelRect(bordered), /\sstroke="(?!none")[^"]+"/);
  assert.doesNotMatch(
    labelRect(borderless),
    /\sstroke="(?!none")[^"]+"/,
    'bordered={false} must remove the colored stroke from the label rect',
  );
});

test('boxed signal with filled={false} drops the solid bg and the dot overlay', () => {
  const filled = render(
    createElement(SvgTimelineDiagram, {
      title: 'filled-on',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          { from: 'codex', to: 'chrome', accent: true, boxed: true },
          'Select target',
        ),
      ],
    }),
  );
  const unfilled = render(
    createElement(SvgTimelineDiagram, {
      title: 'filled-off',
      children: [
        createElement(Diagram.Lane, { id: 'codex', accent: true }, 'CODEX'),
        createElement(Diagram.Lane, { id: 'chrome' }, 'CHROME'),
        createElement(
          Diagram.Signal,
          {
            from: 'codex',
            to: 'chrome',
            accent: true,
            boxed: true,
            filled: false,
          },
          'Select target',
        ),
      ],
    }),
  );

  const labelRects = (markup: string) =>
    [...markup.matchAll(/<rect[^>]*rx="10"[^>]*>/g)].map((m) => m[0]);

  assert.equal(
    labelRects(filled).length,
    2,
    'filled boxed signal has bg rect + dot overlay rect',
  );
  assert.equal(
    labelRects(unfilled).length,
    1,
    'unfilled boxed signal has only the bg rect (no dot overlay)',
  );
  assert.match(
    itemAt(labelRects(unfilled), 0),
    /fill="none"/,
    'unfilled bg rect must use fill="none" so the surface is transparent',
  );
});

test('renders a timeline with lanes, a signal, and a frame', () => {
  const markup = render(
    createElement(SvgTimelineDiagram, {
      title: 'timeline-test',
      children: [
        createElement(Diagram.Lane, { id: 'agent', accent: true }, 'AGENT'),
        createElement(Diagram.Lane, { id: 'user' }, 'USER'),
        createElement(
          Diagram.Signal,
          { from: 'agent', to: 'user', accent: true },
          'Ask question',
        ),
        createElement(
          Diagram.Frame,
          { label: 'UNTIL CLEAR' },
          createElement(
            Diagram.Signal,
            { from: 'user', to: 'agent' },
            'Answer',
          ),
        ),
      ],
    }),
  );

  assert.match(markup, /AGENT/);
  assert.match(markup, /USER/);
  assert.match(markup, /Ask question/);
  assert.match(markup, /Answer/);
  assert.match(markup, /UNTIL CLEAR/);
});

function frameHeaderBottom(markup: string) {
  const header = markup.match(
    /<rect x="[^"]+" y="([^"]+)" width="64" height="([^"]+)"[^>]*><\/rect><text[^>]*>FRAME<\/text>/,
  );
  assert.ok(header, 'frame header tag should render');
  return Number(header[1]) + Number(header[2]);
}

test('first in-frame signal label stays below the frame header', () => {
  const markup = render(
    createElement(SvgTimelineDiagram, {
      title: 'frame-header-clearance',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Lane, { id: 'tree' }, 'TREE'),
        createElement(Diagram.Lane, { id: 'copy' }, 'COPY'),
        createElement(Diagram.Lane, { id: 'prover' }, 'PROVER'),
        createElement(Diagram.Lane, { id: 'target' }, 'TARGET'),
        createElement(
          Diagram.Signal,
          { from: 'tree', to: 'copy' },
          'copy the tree',
        ),
        createElement(
          Diagram.Frame,
          { label: 'PER CLAIM' },
          createElement(
            Diagram.Signal,
            { from: 'prover', to: 'copy' },
            createElement(Diagram.Line, null, 'break it as claimed'),
            createElement(Diagram.Line, null, 'then run the test'),
          ),
        ),
      ],
    }),
  );

  const label = markup.match(
    /<text[^>]* y="([^"]+)"[^>]* font-size="([^"]+)"[^>]*><tspan[^>]*>break it as claimed<\/tspan>/,
  );
  assert.ok(label, 'first in-frame signal label should render');
  const labelTop = Number(label[1]) - Number(label[2]);
  const headerBottom = frameHeaderBottom(markup);
  assert.ok(
    labelTop >= headerBottom,
    `label top (${labelTop}) should clear the frame header bottom (${headerBottom})`,
  );
});

test('first in-frame boxed signal stays below the frame header', () => {
  const markup = render(
    createElement(SvgTimelineDiagram, {
      title: 'frame-header-boxed',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Lane, { id: 'client' }, 'CLIENT'),
        createElement(Diagram.Lane, { id: 'server' }, 'SERVER'),
        createElement(
          Diagram.Frame,
          { label: 'RETRY' },
          createElement(
            Diagram.Signal,
            { from: 'client', to: 'server', boxed: 'center' },
            createElement(Diagram.Line, null, 'run the'),
            createElement(Diagram.Line, null, 'whole suite'),
          ),
        ),
      ],
    }),
  );

  const box = markup.match(
    /<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)" rx="10"[^>]*><\/rect><rect[^>]*><\/rect><text[^>]*><tspan[^>]*>run the<\/tspan>/,
  );
  assert.ok(box, 'boxed in-frame signal should render its box');
  const frame = markup.match(
    /<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)" rx="6"/,
  );
  assert.ok(frame, 'frame outline should render');
  const boxTop = Number(box[1]);
  const boxBottom = boxTop + Number(box[2]);
  const frameBottom = Number(frame[1]) + Number(frame[2]);
  const headerBottom = frameHeaderBottom(markup);
  assert.ok(
    boxTop >= headerBottom,
    `box top (${boxTop}) should clear the frame header bottom (${headerBottom})`,
  );
  assert.ok(
    boxBottom < frameBottom,
    `box bottom (${boxBottom}) should stay inside the frame bottom (${frameBottom})`,
  );
});

test('rejects arbitrary React components as Diagram children', () => {
  function SemanticChunk() {
    return null;
  }

  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          children: createElement(SemanticChunk, null),
        }),
      ),
    /cannot compile <SemanticChunk \/>/,
  );
});

test('rejects React fragments as Diagram children', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          children: createElement(
            Fragment,
            null,
            createElement(Diagram.Box, { id: 'app', row: 0, col: 0 }, 'APP'),
          ),
        }),
      ),
    /does not accept React fragments/,
  );
});

test('rejects duplicate node ids', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          children: [
            createElement(Diagram.Box, { id: 'app', row: 0, col: 0 }, 'APP'),
            createElement(Diagram.Box, { id: 'app', row: 1, col: 0 }, 'APP 2'),
          ],
        }),
      ),
    /Duplicate Diagram node id "app"/,
  );
});

test('rejects duplicate group ids', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          children: [
            createElement(Diagram.Group, {
              id: 'services',
              label: 'Services',
              row: 0,
              col: 0,
              rowSpan: 2,
              colSpan: 2,
            }),
            createElement(Diagram.Group, {
              id: 'services',
              label: 'Other services',
              row: 2,
              col: 0,
              rowSpan: 2,
              colSpan: 2,
            }),
          ],
        }),
      ),
    /Duplicate Diagram group id "services"/,
  );
});

test('rejects edges that reference a missing target node', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          children: [
            createElement(Diagram.Box, { id: 'app', row: 0, col: 0 }, 'APP'),
            createElement(Diagram.Arrow, { from: 'app', to: 'missing' }),
          ],
        }),
      ),
    /references missing target "missing"/,
  );
});

test('graph diagram rejects timeline primitives', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          children: [
            createElement(Diagram.Box, { id: 'app', row: 0, col: 0 }, 'APP'),
            createElement(Diagram.Lane, { id: 'agent' }, 'AGENT'),
          ],
        }),
      ),
    /A graph diagram cannot contain Diagram\.Lane, Diagram\.Signal or Diagram\.Frame/,
  );
});

test('rejects edges that reference a missing named node port', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'missing-port-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'client', row: 0, col: 0 },
              'Client',
            ),
            createElement(
              Diagram.Box,
              { id: 'service', row: 0, col: 1 },
              'Service',
            ),
            createElement(Diagram.Arrow, {
              from: 'client',
              to: 'service:http',
            }),
          ],
        }),
      ),
    /references missing target port "http" on "service"/,
  );
});

test('background edge layer renders strokes below nodes and overlays above nodes', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-layer-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'source', row: 0, col: 0 }, 'Source'),
        createElement(Diagram.Box, { id: 'target', row: 0, col: 1 }, 'Target'),

        createElement(
          Diagram.Arrow,
          {
            from: 'source',
            to: 'target',
            layer: 'background',
            labelFrame: true,
          },
          'Behind boxes',
        ),
      ],
    }),
  );

  const edgePathIndex = markup.indexOf('data-diagram-edge="source-&gt;target"');
  const sourceNodeIndex = markup.indexOf('data-diagram-node="source"');
  const targetNodeIndex = markup.indexOf('data-diagram-node="target"');
  const labelFrameIndex = markup.indexOf(
    'data-diagram-edge-label-frame="source-&gt;target"',
  );

  assert.notEqual(edgePathIndex, -1);
  assert.notEqual(sourceNodeIndex, -1);
  assert.notEqual(targetNodeIndex, -1);
  assert.notEqual(labelFrameIndex, -1);
  assert.match(
    markup,
    /data-diagram-edge="source-&gt;target"[^>]*data-diagram-edge-layer="background"/,
  );
  assert.ok(
    edgePathIndex < sourceNodeIndex,
    'background edge strokes should render before node frames',
  );
  assert.ok(
    labelFrameIndex > targetNodeIndex,
    'edge label overlays should render after node frames even when the stroke is background-layered',
  );
});

test('semantic edge channels render dashed, thick, and bidirectional infrastructure links', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-channel-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'router', row: 0, col: 0 }, 'Router'),
        createElement(Diagram.Box, { id: 'dns', row: 0, col: 1 }, 'DNS'),
        createElement(
          Diagram.Box,
          { id: 'gateway', row: 0, col: 2 },
          'Gateway',
        ),
        createElement(Diagram.Box, { id: 'mesh', row: 1, col: 2 }, 'Mesh'),

        createElement(Diagram.Arrow, {
          from: 'router',
          to: 'dns',
          channel: 'dns',
          lineStyle: 'dashed',
          direction: 'none',
        }),
        createElement(Diagram.Arrow, {
          from: 'dns',
          to: 'gateway',
          channel: 'tunnel',
          weight: 'bold',
        }),
        createElement(Diagram.Arrow, {
          from: 'gateway',
          to: 'mesh',
          channel: 'mtls',
          direction: 'both',
          lineStyle: 'dotted',
        }),
      ],
    }),
  );

  assert.match(
    markup,
    /data-diagram-edge="router-&gt;dns"[^>]*data-diagram-edge-channel="dns"[^>]*data-diagram-edge-line-style="dashed"[^>]*data-diagram-edge-direction="none"[^>]*stroke-dasharray="6 6"/,
    'DNS channel should render as a dashed headless route',
  );
  assert.doesNotMatch(
    markup.match(/data-diagram-edge="router-&gt;dns"[^>]*>/)?.[0] ?? '',
    /marker-(?:start|end)=/,
    'direction="none" should suppress arrow markers',
  );
  assert.match(
    markup,
    /data-diagram-edge="dns-&gt;gateway"[^>]*data-diagram-edge-channel="tunnel"[^>]*stroke-width="3"[^>]*marker-end="url\(#dgm-arrow-neutral-/,
    'tunnel channel should render as a thicker directed edge',
  );

  assert.match(
    markup,
    /data-diagram-edge="gateway-&gt;mesh"[^>]*data-diagram-edge-channel="mtls"[^>]*data-diagram-edge-line-style="dotted"[^>]*data-diagram-edge-direction="both"[^>]*stroke-dasharray="1 6"[^>]*marker-start="url\(#dgm-arrow-neutral-[^"]+"[^>]*marker-end="url\(#dgm-arrow-neutral-/,
    'mTLS channel should render bidirectional dotted markers',
  );
});

test('rejects edges that reference a missing named group port', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'missing-group-port-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'client', row: 0, col: 0 },
              'Client',
            ),
            createElement(Diagram.Group, {
              id: 'services',
              row: 0,
              col: 1,
              rowSpan: 1,
              colSpan: 1,
            }),
            createElement(Diagram.Arrow, {
              from: 'client',
              to: 'services:ingress',
            }),
          ],
        }),
      ),
    /references missing target port "ingress" on "services"/,
  );
});

test('svg outputs draw text in Geist with kerning on and ligatures off, the shaping their text is measured with', () => {
  // Arrange
  const outputs = [
    createElement(SvgGraphDiagram, {
      title: 'font-graph-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Group,
          { id: 'backend', label: 'Backend' },
          createElement(
            Diagram.Box,
            { id: 'service', row: 0, col: 1 },
            'Service',
          ),
        ),
        createElement(Diagram.Junction, { id: 'bus', row: 1, col: 1 }, 'Bus'),
        createElement(Diagram.Box, { id: 'router', row: 0, col: 0 }, 'Router'),
        createElement(
          Diagram.Arrow,
          { from: 'router', to: 'service' },
          'calls',
        ),
      ],
    }),
    createElement(SvgTimelineDiagram, {
      title: 'font-timeline-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Lane, { id: 'user' }, 'User'),
        createElement(Diagram.Lane, { id: 'api' }, 'API'),
        createElement(Diagram.Signal, { from: 'user', to: 'api' }, 'Request'),
      ],
    }),
  ];

  for (const output of outputs) {
    // Act
    const markup = render(output).replaceAll('&#x27;', "'");

    // Assert
    assert.match(
      markup,
      /<svg[^>]*style="[^"]*font-kerning:normal;font-variant-ligatures:none/,
    );
    const families = [...markup.matchAll(/font-family="([^"]*)"/g)].map(
      ([, family]) => family,
    );
    assert.ok(families.length > 0, 'the diagram draws text');
    for (const family of families) {
      assert.match(family ?? '', /^'Geist (Sans|Mono)',/);
    }
  }
});
