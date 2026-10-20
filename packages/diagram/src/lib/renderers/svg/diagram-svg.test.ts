import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Fragment, createElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';

import {
  CanvasGraphDiagram,
  Diagram,
  SvgGraphDiagram,
  SvgTimelineDiagram,
} from '@zukhruf/diagram';

const REJECT_TITLE = 'rejection-fixture';

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  assert.ok(
    item !== undefined,
    `expected an item at ${index} of ${items.length}`,
  );
  return item;
}

function firstCapture(match: RegExpMatchArray): string {
  const [whole, value] = match;
  assert.ok(value !== undefined, `expected ${whole} to capture a value`);
  return value;
}

function pathPoints(path: string) {
  const points: { x: number; y: number }[] = [];
  const commands = path.matchAll(
    /(?<command>[MLQ]) (?<values>-?\d+(?:\.\d+)?(?: -?\d+(?:\.\d+)?)+)/g,
  );
  for (const match of commands) {
    const command = match.groups?.command;
    const [x1, y1, x2, y2] = (match.groups?.values ?? '')
      .split(' ')
      .map(Number);
    if (command === 'M' || command === 'L') {
      assert.ok(x1 !== undefined && y1 !== undefined, `malformed ${match[0]}`);
      points.push({ x: x1, y: y1 });
    }
    if (command === 'Q') {
      assert.ok(x2 !== undefined && y2 !== undefined, `malformed ${match[0]}`);
      points.push({ x: x2, y: y2 });
    }
  }
  return points;
}

function verticalSegments(path: string) {
  const points = pathPoints(path);
  const segments: { x: number; y1: number; y2: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (!start || !end || start.x !== end.x || start.y === end.y) continue;
    segments.push({
      x: start.x,
      y1: Math.min(start.y, end.y),
      y2: Math.max(start.y, end.y),
    });
  }
  return segments;
}

function pathSegments(path: string) {
  const points = pathPoints(path);
  const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (!start || !end) continue;
    segments.push({
      x1: Math.min(start.x, end.x),
      y1: Math.min(start.y, end.y),
      x2: Math.max(start.x, end.x),
      y2: Math.max(start.y, end.y),
    });
  }
  return segments;
}

function verticalSegmentsOverlap(
  a: { x: number; y1: number; y2: number },
  b: { x: number; y1: number; y2: number },
) {
  return a.x === b.x && Math.max(a.y1, b.y1) < Math.min(a.y2, b.y2);
}

function collinearSegmentsOverlap(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
) {
  if (a.y1 === a.y2 && b.y1 === b.y2 && a.y1 === b.y1) {
    return Math.max(a.x1, b.x1) < Math.min(a.x2, b.x2);
  }
  if (a.x1 === a.x2 && b.x1 === b.x2 && a.x1 === b.x1) {
    return Math.max(a.y1, b.y1) < Math.min(a.y2, b.y2);
  }
  return false;
}

function edgeLabelPoint(markup: string, label: string) {
  const pattern = new RegExp(
    `<text\\b(?<attrs>[^>]*)>(?:(?!</text>)[\\s\\S])*?<tspan[^>]*>${escapeRegExp(label)}</tspan>(?:(?!</text>)[\\s\\S])*?</text>`,
  );
  const match = markup.match(pattern);
  if (!match?.groups?.attrs) {
    throw new Error(`edge label "${label}" not found`);
  }
  const attrs = match.groups.attrs;
  const x = attrs.match(/\bx="(-?\d+(?:\.\d+)?)"/);
  const y = attrs.match(/\by="(-?\d+(?:\.\d+)?)"/);
  if (!x || !y) throw new Error(`edge label "${label}" has no x/y`);
  return { x: Number(x[1]), y: Number(y[1]) };
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

function renderedPathD(markup: string, attr: string, id: string) {
  const match = markup.match(
    new RegExp(
      `<path (?=[^>]*${attr}="${escapeRegExp(id)}")[^>]*\\sd="(?<d>[^"]+)"`,
    ),
  );
  if (!match?.groups?.d) throw new Error(`${attr}="${id}" path not found`);
  return match.groups.d;
}

function renderedTextPoint(markup: string, attr: string, id: string) {
  const match = markup.match(
    new RegExp(
      `<text ${attr}="${escapeRegExp(id)}"[^>]*\\bx="(?<x>-?\\d+(?:\\.\\d+)?)"[^>]*\\by="(?<y>-?\\d+(?:\\.\\d+)?)"`,
    ),
  );
  if (!match?.groups) throw new Error(`${attr}="${id}" text not found`);
  return {
    x: Number(match.groups.x),
    y: Number(match.groups.y),
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

function renderedGroupTranslate(markup: string, attr: string, id: string) {
  const match = markup.match(
    new RegExp(
      `<g ${attr}="${escapeRegExp(
        id,
      )}"[^>]*\\btransform="translate\\((?<x>-?\\d+(?:\\.\\d+)?) (?<y>-?\\d+(?:\\.\\d+)?)\\)"`,
    ),
  );
  if (!match?.groups) throw new Error(`${attr}="${id}" group not found`);
  return {
    x: Number(match.groups.x),
    y: Number(match.groups.y),
  };
}

function renderedEdgeLabelPoint(markup: string, id: string) {
  return renderedTextPoint(
    markup,
    'data-diagram-edge-label',
    id.split('->').join('-&gt;'),
  );
}

function renderedAnnotationLeader(markup: string, id: string, target?: string) {
  const targetPattern = target
    ? `(?=[^>]*data-diagram-annotation-leader-target="${escapeRegExp(target)}")`
    : '';
  const match = markup.match(
    new RegExp(
      `<line data-diagram-annotation-leader="${escapeRegExp(id)}"${targetPattern}[^>]*\\bx1="(?<x1>-?\\d+(?:\\.\\d+)?)"[^>]*\\by1="(?<y1>-?\\d+(?:\\.\\d+)?)"[^>]*\\bx2="(?<x2>-?\\d+(?:\\.\\d+)?)"[^>]*\\by2="(?<y2>-?\\d+(?:\\.\\d+)?)"`,
    ),
  );
  if (!match?.groups) {
    throw new Error(
      `annotation leader ${id}${target ? ` for ${target}` : ''} not found`,
    );
  }
  return {
    x1: Number(match.groups.x1),
    y1: Number(match.groups.y1),
    x2: Number(match.groups.x2),
    y2: Number(match.groups.y2),
  };
}

function renderedAnnotationLeaderPath(
  markup: string,
  id: string,
  target?: string,
) {
  const targetPattern = target
    ? `(?=[^>]*data-diagram-annotation-leader-target="${escapeRegExp(target)}")`
    : '';
  const match = markup.match(
    new RegExp(
      `<path data-diagram-annotation-leader="${escapeRegExp(id)}"${targetPattern}[^>]*\\sd="(?<d>[^"]+)"`,
    ),
  );
  if (!match?.groups?.d) {
    throw new Error(
      `annotation leader path ${id}${target ? ` for ${target}` : ''} not found`,
    );
  }
  return {
    d: match.groups.d,
    points: pathPoints(match.groups.d),
    segments: pathSegments(match.groups.d),
  };
}

function renderedEdgePath(markup: string, id: string) {
  const htmlId = id.split('->').join('-&gt;');
  const match = markup.match(
    new RegExp(
      `<path data-diagram-edge="${escapeRegExp(htmlId)}"[^>]*\\sd="(?<d>[^"]+)"`,
    ),
  );
  if (!match?.groups?.d) throw new Error(`edge ${id} path not found`);
  return match.groups.d;
}

function rectContains(
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
) {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function pointInsideRect(
  point: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number },
) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

function labelPointRect(point: { label: string; x: number; y: number }) {
  const width = point.label.length * 6 + 8;
  return {
    x: point.x - width / 2,
    y: point.y - 16,
    w: width,
    h: 20,
  };
}

function multilineEdgeLabelRect(
  point: { x: number; y: number },
  lines: string[],
  lineGap = 2,
) {
  const lineHeight = 10 + lineGap;
  const width = Math.max(1, ...lines.map((line) => line.length)) * 6;
  return {
    x: point.x - width / 2,
    y: point.y - lineHeight,
    w: width,
    h: lines.length * lineHeight,
  };
}

function multilineStartTextRect(
  point: { x: number; y: number },
  lines: string[],
  lineGap = 1,
) {
  const lineHeight = 10 + lineGap;
  const width = Math.max(1, ...lines.map((line) => line.length)) * 6;
  return {
    x: point.x,
    y: point.y - lineHeight,
    w: width,
    h: lines.length * lineHeight,
  };
}

function segmentIntersectsRectInterior(
  segment: { x1: number; y1: number; x2: number; y2: number },
  rect: { x: number; y: number; w: number; h: number },
) {
  if (segment.x1 === segment.x2) {
    return (
      segment.x1 > rect.x &&
      segment.x1 < rect.x + rect.w &&
      Math.max(segment.y1, rect.y) < Math.min(segment.y2, rect.y + rect.h)
    );
  }
  if (segment.y1 === segment.y2) {
    return (
      segment.y1 > rect.y &&
      segment.y1 < rect.y + rect.h &&
      Math.max(segment.x1, rect.x) < Math.min(segment.x2, rect.x + rect.w)
    );
  }
  return false;
}

function segmentsCrossInterior(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
) {
  const aVertical = a.x1 === a.x2;
  const bVertical = b.x1 === b.x2;
  if (aVertical === bVertical) return false;
  const vertical = aVertical ? a : b;
  const horizontal = aVertical ? b : a;
  return (
    vertical.x1 > horizontal.x1 &&
    vertical.x1 < horizontal.x2 &&
    horizontal.y1 > vertical.y1 &&
    horizontal.y1 < vertical.y2
  );
}

function labelBoxesOverlap(
  a: { label: string; x: number; y: number },
  b: { label: string; x: number; y: number },
) {
  const bounds = (point: { label: string; x: number; y: number }) => {
    const width = point.label.length * 6 + 8;
    const top = point.y - 13.42;
    return {
      x1: point.x - width / 2,
      x2: point.x + width / 2,
      y1: top,
      y2: top + 19.85,
    };
  };
  const aBounds = bounds(a);
  const bBounds = bounds(b);
  return (
    aBounds.x1 < bBounds.x2 &&
    aBounds.x2 > bBounds.x1 &&
    aBounds.y1 < bBounds.y2 &&
    aBounds.y2 > bBounds.y1
  );
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
        createElement(
          Diagram.Arrow,
          { from: 'app', to: 'relay' },
          createElement(Diagram.Exit, { side: 'bottom' }),
          createElement(Diagram.Entry, { side: 'top', gap: 0 }),
          createElement(Diagram.Waypoint, { x: 100, y: 120 }),
        ),
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
        createElement(
          Diagram.Box,
          { id: 'router', row: 0, col: 0, width: 140, height: 70 },
          'Router',
        ),
        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 1, width: 140, height: 70 },
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
  assert.equal(svgNumberAttr(markup, 'width'), viewBox.w * 1.5);
  assert.equal(svgNumberAttr(markup, 'height'), viewBox.h * 1.5);
});

test('contained graph viewport fills its parent box without intrinsic dimensions', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'contain-viewport-test',
      defaultMode: 'static',
      viewport: { fit: 'contain' },
      children: [
        createElement(
          Diagram.Box,
          { id: 'router', row: 0, col: 0, width: 140, height: 70 },
          'Router',
        ),
        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 1, width: 140, height: 70 },
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
      graph: {
        columns: [120, 120],
        rows: [80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'source', row: 0, col: 0, width: 80, height: 48 },
          'Source',
        ),
        createElement(
          Diagram.Box,
          { id: 'target', row: 0, col: 1, width: 80, height: 48 },
          'Target',
        ),
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

test('a row resolving before the first track throws instead of silently shifting a row', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: createElement(
            Diagram.Box,
            { id: 'source', row: -0.5, col: 0 },
            'Source',
          ),
        }),
      ),
    /Diagram row -0\.5 resolves before the first track\./,
  );
});

test('invalid edge anchor offsets throw instead of producing NaN routes', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'source', row: 0, col: 0 },
              'Source',
            ),
            createElement(
              Diagram.Box,
              { id: 'target', row: 0, col: 1 },
              'Target',
            ),
            createElement(Diagram.Arrow, {
              from: 'source',
              to: 'target',
              exitOffset: Number.NaN,
            }),
          ],
        }),
      ),
    /Diagram edge exitOffset must be a finite number, got NaN\./,
  );
});

test('invalid edge stub distances throw instead of producing broken routes', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'source', row: 0, col: 0 },
              'Source',
            ),
            createElement(
              Diagram.Box,
              { id: 'target', row: 0, col: 1 },
              'Target',
            ),
            createElement(Diagram.Arrow, {
              from: 'source',
              to: 'target',
              stubDistance: -1,
            }),
          ],
        }),
      ),
    /Diagram edge stubDistance must be a non-negative finite number, got -1\./,
  );
});

test('unhinted fan-out from a left source to a right column exits the source right side', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'fan-out-test',
      children: [
        createElement(
          Diagram.Card,
          { id: 'registry', row: 1.5, col: 0, accent: true },
          createElement(Diagram.Line, null, 'Registry entry'),
          createElement(Diagram.Line, null, 'needsApproval: true'),
        ),
        createElement(
          Diagram.Card,
          { id: 'handler', row: 0, col: 2 },
          createElement(Diagram.Line, null, 'Tool handler'),
        ),
        createElement(
          Diagram.Card,
          { id: 'pending', row: 1, col: 2 },
          createElement(Diagram.Line, null, 'Pending detector'),
        ),
        createElement(
          Diagram.Card,
          { id: 'timeline', row: 2, col: 2 },
          createElement(Diagram.Line, null, 'Timeline'),
        ),
        createElement(
          Diagram.Card,
          { id: 'continue', row: 3, col: 2 },
          createElement(Diagram.Line, null, 'Auto-continue'),
        ),

        createElement(Diagram.Arrow, { from: 'registry', to: 'handler' }),
        createElement(Diagram.Arrow, { from: 'registry', to: 'pending' }),
        createElement(Diagram.Arrow, { from: 'registry', to: 'timeline' }),
        createElement(Diagram.Arrow, { from: 'registry', to: 'continue' }),
      ],
    }),
  );

  const edgePaths = [
    ...markup.matchAll(/<path [^>]*d="([^"]+)"[^>]*stroke-width="1\.5"[^>]*>/g),
  ].map(firstCapture);

  assert.equal(edgePaths.length, 4);
  for (const path of edgePaths) {
    const start = path.match(/^M (?<x>\d+(?:\.\d+)?) (?<y>\d+(?:\.\d+)?)/);
    assert.ok(start?.groups, `expected path to start with M x y, got ${path}`);
    const startY = Number(start.groups.y);

    assert.match(
      path,
      /^M 268 /,
      `expected fan-out edge to start at the source card right edge, got ${path}`,
    );
    assert.ok(
      startY >= 304 && startY <= 336,
      `expected fan-out edge to start on the source card straight right edge, got ${path}`,
    );
  }

  const segments = edgePaths.flatMap((path, pathIndex) =>
    verticalSegments(path).map((segment) => ({ pathIndex, ...segment })),
  );
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (itemAt(segments, i).pathIndex === itemAt(segments, j).pathIndex)
        continue;
      assert.ok(
        !verticalSegmentsOverlap(itemAt(segments, i), itemAt(segments, j)),
        `expected fan-out routes to use separate vertical corridors, got overlap ${JSON.stringify(
          segments[i],
        )} and ${JSON.stringify(segments[j])}`,
      );
    }
  }
});

test('renders a group with its label and infers bounds from child boxes', () => {
  const inferred = render(
    createElement(SvgGraphDiagram, {
      title: 'group-test',
      children: createElement(
        Diagram.Group,
        { id: 'services', label: 'Services' },
        createElement(Diagram.Box, { id: 'logs', row: 0, col: 2 }, 'Logs'),
        createElement(
          Diagram.Box,
          { id: 'metrics', row: 1, col: 3 },
          'Metrics',
        ),
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
          rowStart: 0,
          rowEnd: 1,
          colStart: 2,
          colEnd: 3,
        },

        createElement(Diagram.Box, { id: 'logs', row: 0, col: 2 }, 'Logs'),
        createElement(
          Diagram.Box,
          { id: 'metrics', row: 1, col: 3 },
          'Metrics',
        ),
      ),
    }),
  );

  assert.match(inferred, /Services/);
  assert.match(inferred, /Logs/);
  assert.match(inferred, /Metrics/);
  assert.equal(
    inferred,
    explicit,
    'inferred group bounds must produce the same SVG as bounds derived by hand from child rows/cols',
  );
});

test('infers group bounds after automatic graph layout', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'auto-group-bounds-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Group,
          { id: 'pipeline', label: 'Pipeline' },
          createElement(Diagram.Box, { id: 'ingest' }, 'Ingest'),
          createElement(Diagram.Box, { id: 'parse' }, 'Parse'),
          createElement(Diagram.Box, { id: 'store' }, 'Store'),
        ),

        createElement(Diagram.Arrow, { from: 'ingest', to: 'parse' }),
        createElement(Diagram.Arrow, { from: 'parse', to: 'store' }),
      ],
    }),
  );

  assert.match(markup, /Pipeline/);
  assert.match(markup, /Ingest/);
  assert.match(markup, /Store/);
  assert.match(
    markup,
    /<rect[^>]*x="36"[^>]*y="40"[^>]*width="768"[^>]*height="176"[^>]*stroke-width="1"/,
    'group without explicit bounds should frame the auto-laid child nodes',
  );
});

test('renders nested infrastructure topology with inferred cluster bounds and aligned section labels', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'homelab-topology-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          { id: 'public-internet', row: 0, col: 3, icon: 'internet' },
          'Public Internet',
        ),
        createElement(
          Diagram.Box,
          { id: 'git-repo', row: 3, col: 4, icon: 'git' },
          'Git Repo',
        ),

        createElement(
          Diagram.Group,
          {
            id: 'cluster',
            label: [
              'K3s Kubernetes Cluster',
              'North-South + East-West Traffic',
            ],
            labelAlign: 'start',
            padding: 48,
            ports: [
              { id: 'tunnel', side: 'top', offset: 200, label: 'Tunnel' },
            ],
          },

          createElement(
            Diagram.Group,
            {
              id: 'ingress',
              label: 'Networking & Ingress',
              labelAlign: 'start',
            },

            createElement(
              Diagram.Box,
              { id: 'metallb', row: 1, col: 1, icon: 'router' },
              createElement(Diagram.Line, null, 'MetalLB'),
              createElement(Diagram.Line, null, '(Load Balancer)'),
            ),
            createElement(
              Diagram.Box,
              { id: 'gateway', row: 1, col: 2, icon: 'shield' },
              createElement(Diagram.Line, null, 'Istio Ingress Gateway'),
              createElement(Diagram.Line, null, '(North-South)'),
            ),
          ),

          createElement(
            Diagram.Group,
            { id: 'mesh', label: 'Service Mesh' },
            createElement(
              Diagram.Card,
              {
                id: 'istio',
                row: 2,
                col: 2,
                colSpan: 2,
                height: 104,
                icon: 'istio',
              },

              createElement(Diagram.Line, null, 'Istio Service Mesh'),
              createElement(Diagram.Line, { textColor: 'dim' }, 'mTLS Enabled'),
            ),
          ),

          createElement(
            Diagram.Group,
            { id: 'storage', label: 'Storage', labelAlign: 'start' },
            createElement(
              Diagram.Box,
              { id: 'longhorn', row: 3, col: 1, icon: 'storage' },
              createElement(Diagram.Line, null, 'Longhorn'),
              createElement(Diagram.Line, null, '(Storage Class)'),
            ),
          ),

          createElement(
            Diagram.Group,
            { id: 'monitoring', label: 'Monitoring' },
            createElement(
              Diagram.Box,
              { id: 'grafana', row: 3, col: 2, icon: 'dashboard' },
              'Grafana',
            ),
            createElement(
              Diagram.Box,
              { id: 'victoria', row: 3, col: 3, icon: 'metrics' },
              'VictoriaMetrics',
            ),
          ),
        ),

        createElement(
          Diagram.Arrow,
          { from: 'public-internet', to: 'cluster:tunnel' },
          'Cloudflare Tunnel',
        ),
        createElement(
          Diagram.Arrow,
          { from: 'metallb', to: 'gateway' },
          'External IPs',
        ),
        createElement(Diagram.Arrow, { from: 'gateway', to: 'istio' }),
        createElement(Diagram.Arrow, { from: 'longhorn', to: 'istio' }),
        createElement(Diagram.Arrow, { from: 'grafana', to: 'istio' }),
        createElement(Diagram.Arrow, { from: 'victoria', to: 'istio' }),
        createElement(
          Diagram.Arrow,
          { from: 'git-repo', to: 'istio' },
          'Continuous deploy',
        ),
      ],
    }),
  );

  assert.match(markup, /K3s Kubernetes Cluster/);
  assert.match(markup, /North-South \+ East-West Traffic/);
  assert.match(markup, /Networking &amp; Ingress/);
  assert.match(markup, /Cloudflare Tunnel/);
  assert.match(markup, /data-diagram-port="cluster:tunnel"/);
  assert.match(markup, />Tunnel</);
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
    assert.match(
      markup,
      new RegExp(`data-diagram-node-icon="${icon}"`),
      `homelab topology should render semantic ${icon} icon`,
    );
  }
  assert.match(
    markup,
    /<rect data-diagram-group="cluster" x="252" y="144" width="816" height="480"[^>]*stroke-width="1"/,
    'outer cluster group should infer bounds from nested child groups and apply its own padding collar',
  );
  assert.match(
    markup,
    /<text data-diagram-group-label="cluster" x="268" y="172" text-anchor="start"[^>]*>[\s\S]*<tspan[^>]*>K3s Kubernetes Cluster<\/tspan>[\s\S]*<tspan[^>]*>North-South \+ East-West Traffic<\/tspan>/,
    'cluster label should render as a start-aligned multi-line group title',
  );
  assert.match(
    markup,
    /<text data-diagram-group-label="ingress" x="292" y="196" text-anchor="start"/,
    'inner section labels should support top-start placement',
  );

  const edgePaths = [
    ...markup.matchAll(/<path [^>]*d="([^"]+)"[^>]*stroke-width="1\.5"[^>]*>/g),
  ].map(firstCapture);
  assert.equal(edgePaths.length, 7);
  assert.ok(
    edgePaths.every((path) => /^[MLQ] /.test(path)),
    `all complex topology relationships should render as SVG paths, got ${edgePaths.join(' | ')}`,
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
            width: 132,
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

test('renders markers as compact connectable icon anchors from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'compact-marker-test',
      defaultMode: 'static',
      graph: {
        columns: [96, 96],
        rows: [96],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Marker,
          {
            id: 'repo',
            row: 0,
            col: 0,
            icon: 'git',
            iconSize: 34,
            width: 72,
            height: 76,
          },
          'Git Repo',
        ),
        createElement(
          Diagram.Box,
          { id: 'deploy', row: 0, col: 1, width: 40, height: 40 },
          'Argo',
        ),

        createElement(Diagram.Arrow, { from: 'repo', to: 'deploy' }),
      ],
    }),
  );

  assert.match(
    markup,
    /<g data-diagram-marker="repo"/,
    'marker should expose a stable marker wrapper for black-box integration tests',
  );
  assert.match(
    markup,
    /<rect data-diagram-node="repo" data-diagram-marker-bounds="repo" x="12" y="10" width="72" height="76" rx="0" fill="transparent" stroke="none"/,
    'marker should expose transparent connectable bounds without drawing a card frame',
  );
  assert.match(
    markup,
    /data-diagram-node-icon="git" transform="translate\(31 21\) scale\(0\.53125\)"/,
    'marker should render its icon centered inside the compact marker bounds',
  );
  assert.match(
    markup,
    /<text data-diagram-marker-label="repo" x="48" y="74" text-anchor="middle"[^>]*>[\s\S]*Git Repo/,
    'marker should render its label below the icon instead of using card header layout',
  );
  assert.match(
    renderedEdgePath(markup, 'repo->deploy'),
    /^M 84 48\b/,
    'marker should remain a connectable endpoint routed from its transparent bounds',
  );
});

test('renders custom node icon sizes from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'node-icon-size-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Box,
        { id: 'router', row: 0, col: 0, icon: 'router', iconSize: 28 },
        'Router',
      ),
    }),
  );

  assert.match(
    markup,
    /data-diagram-node-icon="router" transform="translate\([^"]+\) scale\(0\.4375\)"/,
  );
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
          rowStart: 0,
          rowEnd: 0,
          colStart: 0,
          colEnd: 1,
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

test('renders node captions outside node frames and includes them in the content viewBox', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'node-caption-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, {
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
            id: 'adguard',
            row: 0,
            col: 1,
            caption: ['VM', 'DNS Forwarder'],
            captionSide: 'top',
            captionColor: 'dim',
          },
          'AdGuard Home',
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /data-diagram-node-caption="router"[\s\S]*Fritzbox Router/,
    'bottom caption should render as semantic text outside the router node',
  );
  assert.match(
    markup,
    /<text data-diagram-node-caption="adguard" x="420" y="70" text-anchor="middle"[^>]*fill="var\(--dgm-dim/,
    'top multi-line caption should anchor above the node with its own text color',
  );
  assert.match(markup, /<tspan x="420" dy="0">VM<\/tspan>/);
  assert.match(markup, /<tspan x="420" dy="14">DNS Forwarder<\/tspan>/);

  const viewBox = svgViewBox(markup);
  assert.ok(
    viewBox.y < 56,
    `caption bounds should expand the content viewBox above the node body, got y=${viewBox.y}`,
  );
});

test('lets an authored exitOffset override the automatic parallel-edge stagger', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'stagger-override-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'source', row: 0, col: 1 }, 'Source'),
        createElement(Diagram.Box, { id: 'below', row: 1, col: 1 }, 'Below'),
        createElement(Diagram.Box, { id: 'aside', row: 1, col: 0 }, 'Aside'),

        createElement(Diagram.Arrow, {
          from: 'source',
          to: 'below',
          exitSide: 'bottom',
          exitOffset: 0,
          entrySide: 'top',
          route: 'straight',
        }),
        createElement(Diagram.Arrow, {
          from: 'source',
          to: 'aside',
          exitSide: 'bottom',
        }),
      ],
    }),
  );

  const source = renderedRect(markup, 'data-diagram-node', 'source');
  const path = renderedEdgePath(markup, 'source->below');
  const exit = itemAt(pathPoints(path), 0);

  assert.equal(
    exit.x,
    source.x + source.w / 2,
    'an authored exitOffset of 0 should exit the centre of the side, not the centre plus an automatic stagger',
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

test('straddles a framed caption across the node edge it names, and frames nothing otherwise', () => {
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

  assert.equal(
    badge.y + badge.h / 2,
    node.y,
    'a top-side framed caption should centre on the node top edge',
  );
  assert.equal(
    badge.x + badge.w / 2,
    node.x + node.w / 2,
    'a top-side framed caption should centre on the node horizontally',
  );
});

const MEASURED_CAPTIONS = [
  { text: 'Workspace agent', fontSize: 13, width: 109.84 },
  { text: 'SYSTEM ADMINISTRATOR', fontSize: 13, width: 165.27 },
  { text: 'WORKSPACE AGENT', fontSize: 13, width: 130.52 },
  { text: 'MMMMMMMMMM', fontSize: 13, width: 115.66 },
  { text: 'VM', fontSize: 11, width: 17.74 },
  { text: 'Human', fontSize: 13, width: 44.91 },
  { text: 'LLM Call', fontSize: 13, width: 54.05 },
  { text: 'DNS Forwarder', fontSize: 11, width: 83.17 },
  { text: 'Fritzbox Router', fontSize: 11, width: 84.22 },
];

const CAPTION_FRAME_MIN_SIDE_PAD = 4;

const CAPTION_EM_ASCENT = 0.972;
const CAPTION_EM_HEIGHT = 1.19;

function renderedCaptionBaseline(markup: string, id: string) {
  const match = markup.match(
    new RegExp(
      `<text data-diagram-node-caption="${escapeRegExp(id)}"[^>]*\\by="(?<y>-?\\d+(?:\\.\\d+)?)"`,
    ),
  );
  if (!match?.groups) throw new Error(`caption "${id}" has no baseline`);
  return Number(match.groups.y);
}

test('centres a framed caption vertically within its pill', () => {
  const sizes = [13, 11];
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'caption-frame-centring-test',
      defaultMode: 'static',
      children: sizes.map((fontSize, i) =>
        createElement(
          Diagram.Box,
          {
            key: fontSize,
            id: `badge-${i}`,
            row: i,
            col: 0,
            caption: 'Workspace agent',
            captionSide: 'top',
            captionFontSize: fontSize,
            captionFrame: true,
          },
          'node',
        ),
      ),
    }),
  );

  const offCentre = sizes
    .map((fontSize, i) => {
      const badge = renderedRect(
        markup,
        'data-diagram-node-caption-frame',
        `badge-${i}`,
      );
      const baseline = renderedCaptionBaseline(markup, `badge-${i}`);
      const inkTop = baseline - CAPTION_EM_ASCENT * fontSize;
      const inkBottom = inkTop + CAPTION_EM_HEIGHT * fontSize;
      const above = Math.round((inkTop - badge.y) * 10) / 10;
      const below = Math.round((badge.y + badge.h - inkBottom) * 10) / 10;
      return { fontSize, above, below };
    })
    .filter((row) => Math.abs(row.above - row.below) > 0.5);

  assert.deepEqual(
    offCentre,
    [],
    'a framed caption should leave equal space above and below its text; em metrics measured in Chrome at ui-sans-serif/600',
  );
});

test('reserves enough width for a framed caption to contain its rendered text', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'caption-frame-width-test',
      defaultMode: 'static',
      children: MEASURED_CAPTIONS.map((sample, i) =>
        createElement(
          Diagram.Box,
          {
            key: sample.text,
            id: `badge-${i}`,
            row: i,
            col: 0,
            caption: sample.text,
            captionSide: 'top',
            captionFontSize: sample.fontSize,
            captionFrame: true,
          },
          'node',
        ),
      ),
    }),
  );

  const tooNarrow = MEASURED_CAPTIONS.map((sample, i) => {
    const badge = renderedRect(
      markup,
      'data-diagram-node-caption-frame',
      `badge-${i}`,
    );
    const sidePad = (badge.w - sample.width) / 2;
    return { ...sample, badgeW: badge.w, sidePad };
  }).filter((row) => row.sidePad < CAPTION_FRAME_MIN_SIDE_PAD);

  assert.deepEqual(
    tooNarrow,
    [],
    `every framed caption must reserve at least ${CAPTION_FRAME_MIN_SIDE_PAD}px beside its text; widths measured in Chrome at ui-sans-serif/600`,
  );
});

test('renders connector nodes as compact inline topology controls from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'connector-node-test',
      defaultMode: 'static',
      graph: {
        columns: [144, 144],
        rows: [96, 96],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          {
            id: 'public-internet',
            row: 0,
            col: 0,
            width: 96,
            height: 44,
            icon: 'internet',
          },
          'Public',
        ),
        createElement(
          Diagram.Connector,
          {
            id: 'cloudflare-tunnel',
            row: 0.5,
            col: 0.5,
            width: 152,
            height: 40,
            icon: 'tunnel',
            iconSize: 20,
            tone: 'blue',
            texture: 'none',
          },

          createElement(Diagram.Line, null, 'Cloudflare Tunnel'),
          createElement(Diagram.Line, { textColor: 'dim' }, '(Zero Trust)'),
        ),
        createElement(
          Diagram.Box,
          {
            id: 'gateway',
            row: 1,
            col: 1,
            width: 96,
            height: 44,
            icon: 'shield',
          },
          'Gateway',
        ),

        createElement(
          Diagram.Wire,
          {
            from: 'public-internet',
            to: 'cloudflare-tunnel',
            channel: 'tunnel',
            strokeWidth: 3,
          },

          createElement(Diagram.Exit, { side: 'bottom' }),
          createElement(Diagram.Entry, { side: 'top', gap: 0 }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'cloudflare-tunnel',
            to: 'gateway',
            channel: 'tunnel',
            strokeWidth: 3,
          },

          createElement(Diagram.Exit, { side: 'bottom' }),
          createElement(Diagram.Entry, { side: 'top', gap: 0 }),
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /<rect data-diagram-node="cloudflare-tunnel" data-diagram-connector="cloudflare-tunnel" data-diagram-node-tone="blue"/,
    'connector should render as a compact semantic node instead of an edge label',
  );
  assert.match(markup, /data-diagram-node-icon="tunnel"/);
  assert.match(markup, /data-diagram-connector-label="cloudflare-tunnel"/);
  assert.match(markup, /Cloudflare Tunnel/);
  assert.match(markup, /\(Zero Trust\)/);
  assert.match(
    markup,
    /data-diagram-edge="public-internet-&gt;cloudflare-tunnel"[^>]*data-diagram-edge-channel="tunnel"[^>]*data-diagram-edge-direction="none"[^>]*stroke-width="3"/,
    'the inbound connector leg should render as a headless tunnel wire',
  );
  assert.match(
    markup,
    /data-diagram-edge="cloudflare-tunnel-&gt;gateway"[^>]*data-diagram-edge-channel="tunnel"[^>]*data-diagram-edge-direction="forward"[^>]*stroke-width="3"/,
    'the outbound connector leg should render as the directed tunnel flow',
  );

  const connector = renderedRect(
    markup,
    'data-diagram-node',
    'cloudflare-tunnel',
  );
  const inbound = pathPoints(
    renderedEdgePath(markup, 'public-internet->cloudflare-tunnel'),
  );
  const outbound = pathPoints(
    renderedEdgePath(markup, 'cloudflare-tunnel->gateway'),
  );

  assert.equal(
    itemAt(inbound, -1).y,
    connector.y,
    'inbound wire should terminate on the connector top edge',
  );
  assert.equal(
    itemAt(outbound, 0).y,
    connector.y + connector.h,
    'outbound tunnel edge should start from the connector bottom edge',
  );
});

test('renders network appliances as physical chassis nodes from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'network-appliance-test',
      defaultMode: 'static',
      graph: {
        columns: [144, 160],
        rows: [96],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(Diagram.Appliance, {
          id: 'router',
          row: 0,
          col: 0,
          width: 116,
          height: 72,
          tone: 'slate',
          texture: 'hatch',
          appliancePorts: 5,
          antenna: true,
          caption: 'Fritzbox Router',
          captionSide: 'bottom',
        }),
        createElement(
          Diagram.Box,
          { id: 'adguard', row: 0, col: 1, width: 112, height: 54 },
          'AdGuard',
        ),
        createElement(Diagram.Arrow, { from: 'router', to: 'adguard' }),
      ],
    }),
  );

  assert.match(
    markup,
    /data-diagram-appliance="router"/,
    'appliance should render as its own semantic node kind',
  );
  assert.match(
    markup,
    /<path data-diagram-node="router" data-diagram-node-tone="slate" data-diagram-appliance-body="router"/,
    'appliance should expose a connectable chassis body through the rendered SVG',
  );
  assert.match(markup, /data-diagram-appliance-antenna="router"/);
  assert.match(markup, /data-diagram-appliance-face="router"/);
  assert.match(markup, /data-diagram-appliance-port="router:4"/);
  assert.match(markup, /data-diagram-node-texture="router:hatch"/);
  assert.match(
    markup,
    /data-diagram-node-caption="router"[\s\S]*Fritzbox Router/,
  );
  assert.match(
    markup,
    /data-diagram-edge="router-&gt;adguard"/,
    'appliance nodes should participate in normal graph routing',
  );
});

test('renders explicit straight graph edges from public side anchors', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'straight-edge-route-test',
      defaultMode: 'static',
      graph: {
        columns: [128, 224],
        rows: [128],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'source', row: 0, col: 0, width: 80, height: 56 },
          'Source',
        ),
        createElement(
          Diagram.Box,
          { id: 'target', row: 0, col: 1, width: 104, height: 56 },
          'Target',
        ),
        createElement(Diagram.Arrow, {
          from: 'source',
          to: 'target',
          route: 'straight',
          exitSide: 'right',
          entrySide: 'left',
        }),
      ],
    }),
  );

  const source = renderedRect(markup, 'data-diagram-node', 'source');
  const target = renderedRect(markup, 'data-diagram-node', 'target');
  const path = renderedEdgePath(markup, 'source->target');
  assert.match(
    markup,
    /<path data-diagram-edge="source-&gt;target"[^>]*data-diagram-edge-route="straight"/,
  );
  assert.equal(
    path,
    `M ${source.x + source.w} ${source.y + source.h / 2} L ${target.x - 10} ${
      target.y + target.h / 2
    }`,
    'straight edge routes should draw one direct segment into the selected target entry gap',
  );
});

test('edge anchor offsets adjust side anchors without visible port nodes', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-anchor-offset-test',
      defaultMode: 'static',
      graph: {
        columns: [128, 160],
        rows: [160],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'source', row: 0, col: 0, width: 80, height: 56 },
          'Source',
        ),
        createElement(
          Diagram.Box,
          { id: 'target', row: 0, col: 1, width: 88, height: 56 },
          'Target',
        ),
        createElement(Diagram.Arrow, {
          from: 'source',
          to: 'target',
          route: 'straight',
          exitSide: 'bottom',
          exitOffset: 20,
          entrySide: 'top',
          entryOffset: -16,
        }),
      ],
    }),
  );

  const source = renderedRect(markup, 'data-diagram-node', 'source');
  const target = renderedRect(markup, 'data-diagram-node', 'target');
  const path = renderedEdgePath(markup, 'source->target');
  assert.equal(
    path,
    `M ${source.x + source.w / 2 + 20} ${source.y + source.h} L ${
      target.x + target.w / 2 - 16
    } ${target.y - 10}`,
    'edge offsets should move the resolved side anchors without adding visible node ports',
  );
  assert.doesNotMatch(markup, /data-diagram-port=/);
});

test('edge stubDistance aligns guide corridors with endpoint stubs', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-stub-distance-test',
      defaultMode: 'static',
      graph: {
        columns: [120, 120, 120],
        rows: [80, 80, 80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'external-disk', row: 2, col: 0, width: 80, height: 44 },
          'External Disk',
        ),
        createElement(
          Diagram.Group,
          {
            id: 'storage-group',
            label: 'Storage',
            rowStart: 0,
            rowEnd: 1,
            colStart: 2,
            colEnd: 2,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'longhorn', row: 0, col: 2, width: 84, height: 44 },
            'Longhorn',
          ),
        ),
        createElement(Diagram.Guide, {
          id: 'storage-rail',
          orientation: 'horizontal',
          target: 'storage-group',
          anchor: 'bottom',
          gap: 28,
        }),

        createElement(
          Diagram.Arrow,
          {
            from: 'external-disk',
            to: 'longhorn',
            exitSide: 'right',
            entrySide: 'bottom',
            lineStyle: 'dashed',
            stubDistance: 20,
          },

          createElement(Diagram.Waypoint, {
            guide: 'storage-rail',
            target: 'external-disk',
            anchor: 'right',
            gap: 20,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'storage-rail',
            target: 'longhorn',
            anchor: 'bottom',
          }),
        ),
      ],
    }),
  );

  const externalDisk = renderedRect(
    markup,
    'data-diagram-node',
    'external-disk',
  );
  const storageGroup = renderedRect(
    markup,
    'data-diagram-group',
    'storage-group',
  );
  const path = renderedEdgePath(markup, 'external-disk->longhorn');
  const railY = storageGroup.y + storageGroup.h + 28;
  const sourceStubX = externalDisk.x + externalDisk.w + 20;

  assert.match(
    path,
    new RegExp(`Q ${sourceStubX} ${railY}`),
    `stubDistance should align the source-side endpoint stub with the storage rail, got ${path}`,
  );
  assert.match(
    path,
    new RegExp(`Q ${sourceStubX} ${externalDisk.y + externalDisk.h / 2}`),
    `stubDistance should make the source stub and rail bend share one x-coordinate, got ${path}`,
  );
});

test('custom graph tracks drive node, group, port, and route geometry from the public API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'custom-graph-tracks-test',
      defaultMode: 'static',
      graph: {
        columns: [160, 320, 200],
        rows: [96, 160],
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'router', row: 0, col: 0, width: 120, height: 50 },
          'Router',
        ),
        createElement(
          Diagram.Group,
          {
            id: 'services',
            label: 'Services',
            rowStart: 0,
            rowEnd: 1,
            colStart: 1,
            colEnd: 2,
            ports: [
              { id: 'ingress', side: 'top', offset: 48, label: 'Ingress' },
            ],
          },

          createElement(
            Diagram.Box,
            { id: 'gateway', row: 0, col: 1, width: 180 },
            'Gateway',
          ),
          createElement(
            Diagram.Box,
            { id: 'database', row: 1, col: 2, width: 140 },
            'Database',
          ),
        ),
        createElement(Diagram.Arrow, {
          from: 'router',
          to: 'services:ingress',
        }),
      ],
    }),
  );

  assert.match(
    markup,
    /<rect data-diagram-node="router" x="80" y="87" width="120" height="50"/,
    'custom first column and first row should place the router inside a 160x96 track',
  );
  assert.match(
    markup,
    /<rect data-diagram-node="gateway" x="290" y="80" width="180" height="64"/,
    'custom second column should center the gateway in a 320px track',
  );
  assert.match(
    markup,
    /<rect data-diagram-node="database" x="570" y="208" width="140" height="64"/,
    'custom third column and second row should place the database in a 200x160 track',
  );
  assert.match(
    markup,
    /<rect data-diagram-group="services" x="196" y="40" width="568" height="304"/,
    'group bounds should span the declared custom column and row tracks',
  );
  assert.match(
    markup,
    /data-diagram-port="services:ingress" data-diagram-port-side="top"[\s\S]*<circle cx="528" cy="40"/,
    'group port placement should use the custom group boundary',
  );
  assert.match(
    markup,
    /<path [^>]*d="[^"]*L 528 30"/,
    'routed edge should terminate at the custom-track group port entry point',
  );
});

test('track-relative waypoints resolve through public graph tracks', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'track-waypoint-test',
      defaultMode: 'static',
      graph: {
        columns: [120, 160, 120],
        rows: [80, 120],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'source', row: 0, col: 0, width: 40, height: 40 },
          'Source',
        ),
        createElement(
          Diagram.Box,
          { id: 'target', row: 0, col: 2, width: 40, height: 40 },
          'Target',
        ),

        createElement(
          Diagram.Arrow,
          { from: 'source', to: 'target' },
          createElement(Diagram.Waypoint, { row: 1, col: 1, dx: 12, dy: 8 }),
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /data-diagram-edge="source-&gt;target"[^>]*\sd="[^"]*Q 132 88/,
    'track-relative waypoints should resolve row/col through graph tracks before routing',
  );
});

test('target waypoints route via node and group geometry from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'target-waypoint-test',
      defaultMode: 'static',
      graph: {
        columns: [120, 120, 120],
        rows: [80, 80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'source', row: 0, col: 0, width: 40, height: 40 },
          'Source',
        ),
        createElement(
          Diagram.Group,
          {
            id: 'service-group',
            label: 'Service',
            rowStart: 0,
            rowEnd: 1,
            colStart: 1,
            colEnd: 1,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'relay', row: 0, col: 1, width: 80, height: 40 },
            'Relay',
          ),
        ),
        createElement(
          Diagram.Box,
          { id: 'target', row: 1, col: 2, width: 40, height: 40 },
          'Target',
        ),

        createElement(
          Diagram.Arrow,
          { from: 'source', to: 'target' },
          createElement(Diagram.Waypoint, {
            target: 'relay',
            anchor: 'right',
            gap: 12,
            dy: 8,
          }),
          createElement(Diagram.Waypoint, {
            target: 'service-group',
            anchor: 'bottom',
            gap: 16,
            dx: 24,
          }),
        ),
      ],
    }),
  );

  const relay = renderedRect(markup, 'data-diagram-node', 'relay');
  const serviceGroup = renderedRect(
    markup,
    'data-diagram-group',
    'service-group',
  );
  const path = renderedEdgePath(markup, 'source->target');
  const relayWaypoint = {
    x: relay.x + relay.w + 12,
    y: relay.y + relay.h / 2 + 8,
  };
  const groupWaypoint = {
    x: serviceGroup.x + serviceGroup.w / 2 + 24,
    y: serviceGroup.y + serviceGroup.h + 16,
  };

  assert.match(
    path,
    new RegExp(`Q ${relayWaypoint.x} ${relayWaypoint.y}`),
    `target waypoint should route through the relay right edge, got ${path}`,
  );
  assert.match(
    path,
    new RegExp(`Q ${groupWaypoint.x} ${groupWaypoint.y}`),
    `target waypoint should route through the service group bottom edge, got ${path}`,
  );
});

test('guide waypoints route through named target-anchored corridors from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'guide-waypoint-test',
      defaultMode: 'static',
      graph: {
        columns: [120, 80, 160],
        rows: [80, 80, 80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'router', row: 1, col: 0, width: 60, height: 40 },
          'Router',
        ),

        createElement(
          Diagram.Group,
          {
            id: 'service-group',
            label: 'Services',
            rowStart: 0,
            rowEnd: 2,
            colStart: 2,
            colEnd: 2,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'adguard', row: 0, col: 2, width: 80, height: 40 },
            'AdGuard',
          ),
          createElement(
            Diagram.Box,
            { id: 'storage', row: 2, col: 2, width: 80, height: 40 },
            'Storage',
          ),
        ),

        createElement(Diagram.Guide, {
          id: 'service-rail',
          orientation: 'vertical',
          target: 'service-group',
          anchor: 'left',
          gap: 32,
        }),

        createElement(
          Diagram.Arrow,
          {
            from: 'router',
            to: 'adguard',
            exitSide: 'right',
            entrySide: 'left',
            labelSide: 'left',
            labelOffset: 24,
            labelDy: -8,
            labelFrame: true,
          },
          'DNS forwarding',

          createElement(Diagram.Waypoint, {
            guide: 'service-rail',
            target: 'router',
            anchor: 'right',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'service-rail',
            target: 'adguard',
            anchor: 'left',
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'router',
            to: 'storage',
            exitSide: 'right',
            entrySide: 'left',
            lineStyle: 'dashed',
            labelSide: 'left',
            labelOffset: 24,
            labelT: 0.68,
            labelDy: 10,
            labelFrame: true,
          },
          'Storage sync',

          createElement(Diagram.Waypoint, {
            guide: 'service-rail',
            target: 'router',
            anchor: 'right',
            dy: 16,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'service-rail',
            target: 'storage',
            anchor: 'left',
          }),
        ),
      ],
    }),
  );

  const router = renderedRect(markup, 'data-diagram-node', 'router');
  const serviceGroup = renderedRect(
    markup,
    'data-diagram-group',
    'service-group',
  );
  const adguard = renderedRect(markup, 'data-diagram-node', 'adguard');
  const storage = renderedRect(markup, 'data-diagram-node', 'storage');
  const guideX = serviceGroup.x - 32;
  const dnsPath = renderedEdgePath(markup, 'router->adguard');
  const storagePath = renderedEdgePath(markup, 'router->storage');
  const routerRightY = router.y + router.h / 2;
  const adguardLeftY = adguard.y + adguard.h / 2;
  const storageLeftY = storage.y + storage.h / 2;

  assert.match(
    dnsPath,
    new RegExp(`Q ${guideX} ${routerRightY}`),
    `DNS edge should enter the service rail from the router anchor, got ${dnsPath}`,
  );
  assert.match(
    dnsPath,
    new RegExp(`Q ${guideX} ${adguardLeftY}`),
    `DNS edge should leave the service rail at the AdGuard anchor, got ${dnsPath}`,
  );
  assert.match(
    storagePath,
    new RegExp(`Q ${guideX} ${routerRightY + 16}`),
    `storage edge should support per-waypoint offsets on the named rail, got ${storagePath}`,
  );
  assert.match(
    storagePath,
    new RegExp(`Q ${guideX} ${storageLeftY}`),
    `storage edge should leave the service rail at the storage anchor, got ${storagePath}`,
  );

  const dnsLabel = {
    label: 'DNS forwarding',
    ...edgeLabelPoint(markup, 'DNS forwarding'),
  };
  const storageLabel = {
    label: 'Storage sync',
    ...edgeLabelPoint(markup, 'Storage sync'),
  };
  assert.ok(
    !labelBoxesOverlap(dnsLabel, storageLabel),
    `guide-routed labels should remain staggered, got ${JSON.stringify({
      dnsLabel,
      storageLabel,
    })}`,
  );
  for (const label of [dnsLabel, storageLabel]) {
    for (const [id, rect] of [
      ['router', router],
      ['service-group', serviceGroup],
      ['adguard', adguard],
      ['storage', storage],
    ] as const) {
      assert.ok(
        !pointInsideRect(label, rect),
        `${label.label} should render outside ${id}, got label=${JSON.stringify(
          label,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
});

test('horizontal guide waypoints route through named group-anchored corridors from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'horizontal-guide-waypoint-test',
      defaultMode: 'static',
      graph: {
        columns: [120, 120, 120],
        rows: [80, 80, 80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'external-disk', row: 2, col: 0, width: 80, height: 44 },
          'External Disk',
        ),
        createElement(
          Diagram.Group,
          {
            id: 'storage-group',
            label: 'Storage',
            rowStart: 0,
            rowEnd: 1,
            colStart: 2,
            colEnd: 2,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'longhorn', row: 0, col: 2, width: 84, height: 44 },
            'Longhorn',
          ),
        ),

        createElement(Diagram.Guide, {
          id: 'storage-rail',
          orientation: 'horizontal',
          target: 'storage-group',
          anchor: 'bottom',
          gap: 28,
        }),

        createElement(
          Diagram.Arrow,
          {
            from: 'external-disk',
            to: 'longhorn',
            exitSide: 'right',
            entrySide: 'bottom',
            lineStyle: 'dashed',
            labelSide: 'below',
            labelOffset: 18,
            labelFrame: true,
          },
          'Backups',

          createElement(Diagram.Waypoint, {
            guide: 'storage-rail',
            target: 'external-disk',
            anchor: 'right',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'storage-rail',
            target: 'longhorn',
            anchor: 'bottom',
          }),
        ),
      ],
    }),
  );

  const externalDisk = renderedRect(
    markup,
    'data-diagram-node',
    'external-disk',
  );
  const storageGroup = renderedRect(
    markup,
    'data-diagram-group',
    'storage-group',
  );
  const longhorn = renderedRect(markup, 'data-diagram-node', 'longhorn');
  const path = renderedEdgePath(markup, 'external-disk->longhorn');
  const railY = storageGroup.y + storageGroup.h + 28;
  const externalDiskRightX = externalDisk.x + externalDisk.w;
  const longhornBottomX = longhorn.x + longhorn.w / 2;

  assert.match(
    path,
    new RegExp(`Q ${externalDiskRightX} ${railY}`),
    `storage edge should enter the horizontal rail from the external disk anchor, got ${path}`,
  );
  assert.match(
    path,
    new RegExp(`Q ${longhornBottomX} ${railY}`),
    `storage edge should leave the horizontal rail below Longhorn, got ${path}`,
  );

  const railSegments = pathSegments(path).filter(
    (segment) =>
      segment.y1 === railY &&
      segment.y2 === railY &&
      segment.x2 - segment.x1 > 80,
  );
  assert.ok(
    railSegments.length > 0,
    `storage edge should include a long horizontal rail below the storage group, got ${path}`,
  );
  const label = edgeLabelPoint(markup, 'Backups');
  assert.ok(
    label.y > railY,
    `horizontal guide label should sit below the storage rail, got label=${JSON.stringify(
      label,
    )} railY=${railY}`,
  );
  assert.ok(
    !pointInsideRect(label, longhorn),
    `horizontal guide label should not overlap Longhorn, got label=${JSON.stringify(
      label,
    )} longhorn=${JSON.stringify(longhorn)}`,
  );
});

test('right-side guide waypoints route stacked control-plane edges through a named rail', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'right-side-guide-waypoint-test',
      defaultMode: 'static',
      graph: {
        columns: [160, 120, 120],
        rows: [72, 72, 72],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Card,
          { id: 'mesh', row: 1, col: 0, width: 112, height: 52 },
          'Service Mesh',
        ),
        createElement(
          Diagram.Box,
          { id: 'cert', row: 0, col: 2, width: 88, height: 40 },
          'Cert',
        ),
        createElement(
          Diagram.Box,
          { id: 'auth', row: 1, col: 2, width: 88, height: 40 },
          'Auth',
        ),
        createElement(
          Diagram.Box,
          { id: 'deploy', row: 2, col: 2, width: 88, height: 40 },
          'Deploy',
        ),

        createElement(Diagram.Guide, {
          id: 'control-rail',
          orientation: 'vertical',
          target: 'auth',
          anchor: 'left',
          gap: 28,
        }),

        createElement(
          Diagram.Arrow,
          {
            from: 'cert',
            to: 'mesh',
            exitSide: 'left',
            entrySide: 'right',
            lineStyle: 'dashed',
            labelSide: 'right',
            labelOffset: 22,
            labelDy: -10,
            labelFrame: true,
          },
          'Cert sync',

          createElement(Diagram.Waypoint, {
            guide: 'control-rail',
            target: 'cert',
            anchor: 'left',
            dy: -8,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'control-rail',
            target: 'mesh',
            anchor: 'right',
            dy: -8,
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'auth',
            to: 'mesh',
            exitSide: 'left',
            entrySide: 'right',
            labelSide: 'right',
            labelOffset: 22,
            labelDy: 28,
            labelFrame: true,
          },
          'SSO',

          createElement(Diagram.Waypoint, {
            guide: 'control-rail',
            target: 'auth',
            anchor: 'left',
            dy: -18,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'control-rail',
            target: 'mesh',
            anchor: 'right',
            dy: -18,
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'deploy',
            to: 'mesh',
            exitSide: 'left',
            entrySide: 'right',
            labelSide: 'right',
            labelOffset: 22,
            labelDy: 34,
            labelFrame: true,
          },
          'Deploy flow',

          createElement(Diagram.Waypoint, {
            guide: 'control-rail',
            target: 'deploy',
            anchor: 'left',
            dy: 10,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'control-rail',
            target: 'mesh',
            anchor: 'right',
            dy: 10,
          }),
        ),
      ],
    }),
  );

  const mesh = renderedRect(markup, 'data-diagram-node', 'mesh');
  const cert = renderedRect(markup, 'data-diagram-node', 'cert');
  const auth = renderedRect(markup, 'data-diagram-node', 'auth');
  const deploy = renderedRect(markup, 'data-diagram-node', 'deploy');
  const railX = auth.x - 28;
  const meshCenterY = mesh.y + mesh.h / 2;

  for (const [edge, source, dy] of [
    ['cert->mesh', cert, -8],
    ['auth->mesh', auth, -18],
    ['deploy->mesh', deploy, 10],
  ] as const) {
    const path = renderedEdgePath(markup, edge);
    const sourceCenterY = Math.round((source.y + source.h / 2 + dy) / 4) * 4;
    const targetCenterY = Math.round((meshCenterY + dy) / 4) * 4;
    assert.match(
      path,
      new RegExp(`Q ${railX} ${sourceCenterY}`),
      `${edge} should enter the right-side control rail from its source anchor, got ${path}`,
    );
    assert.match(
      path,
      new RegExp(`Q ${railX} ${targetCenterY}`),
      `${edge} should leave the right-side control rail at the mesh anchor, got ${path}`,
    );
  }

  const labels = [
    { label: 'Cert sync', ...edgeLabelPoint(markup, 'Cert sync') },
    { label: 'SSO', ...edgeLabelPoint(markup, 'SSO') },
    { label: 'Deploy flow', ...edgeLabelPoint(markup, 'Deploy flow') },
  ];

  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      assert.ok(
        !labelBoxesOverlap(itemAt(labels, i), itemAt(labels, j)),
        `right-side rail labels should not overlap, got ${JSON.stringify(labels)}`,
      );
    }
  }
  for (const label of labels) {
    for (const [id, rect] of [
      ['mesh', mesh],
      ['cert', cert],
      ['auth', auth],
      ['deploy', deploy],
    ] as const) {
      assert.ok(
        !pointInsideRect(label, rect),
        `${label.label} should render outside ${id}, got label=${JSON.stringify(
          label,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
});

test('guide-anchored annotations align in a side callout lane from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'guide-annotation-lane-test',
      defaultMode: 'static',
      graph: {
        columns: [128, 128],
        rows: [72, 72, 72],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Group,
          {
            id: 'cluster',
            label: 'Cluster',
            rowStart: 0,
            rowEnd: 2,
            colStart: 0,
            colEnd: 1,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'cert', row: 0, col: 1, width: 84, height: 40 },
            'Cert',
          ),
          createElement(
            Diagram.Box,
            { id: 'auth', row: 1, col: 1, width: 84, height: 40 },
            'Auth',
          ),
          createElement(
            Diagram.Box,
            { id: 'deploy', row: 2, col: 1, width: 84, height: 40 },
            'Deploy',
          ),
        ),

        createElement(Diagram.Guide, {
          id: 'right-callouts',
          orientation: 'vertical',
          target: 'cluster',
          anchor: 'right',
          gap: 48,
        }),

        createElement(
          Diagram.Note,
          {
            target: 'cert',
            anchor: 'right',
            guide: 'right-callouts',
            dy: -8,
            leader: true,
          },
          'Manages certificates',
        ),
        createElement(
          Diagram.Note,
          {
            target: 'auth',
            anchor: 'right',
            guide: 'right-callouts',
            leader: true,
          },
          'Authentication lane',
        ),
        createElement(
          Diagram.Note,
          {
            target: 'deploy',
            anchor: 'right',
            guide: 'right-callouts',
            dy: 8,
            leader: true,
          },
          'Deployment requests',
        ),
      ],
    }),
  );

  const cluster = renderedRect(markup, 'data-diagram-group', 'cluster');
  const cert = renderedRect(markup, 'data-diagram-node', 'cert');
  const auth = renderedRect(markup, 'data-diagram-node', 'auth');
  const deploy = renderedRect(markup, 'data-diagram-node', 'deploy');
  const calloutX = cluster.x + cluster.w + 48;
  const notes = [
    { id: 'cert:right', target: cert, dy: -8 },
    { id: 'auth:right', target: auth, dy: 0 },
    { id: 'deploy:right', target: deploy, dy: 8 },
  ] as const;

  assert.match(
    markup,
    /data-diagram-annotation="cert:right"[^>]*data-diagram-annotation-guide="right-callouts"/,
    'guide-backed annotations should expose the guide id for black-box tests',
  );

  for (const note of notes) {
    const text = renderedTextPoint(markup, 'data-diagram-annotation', note.id);
    const leader = renderedAnnotationLeader(markup, note.id);
    const targetCenterY = note.target.y + note.target.h / 2;
    assert.equal(
      text.x,
      calloutX,
      `${note.id} should align to the shared right callout lane`,
    );
    assert.equal(
      text.y,
      targetCenterY + note.dy,
      `${note.id} should keep its vertical position tied to the target edge`,
    );
    assert.ok(
      text.x > cluster.x + cluster.w,
      `${note.id} should render outside the cluster frame`,
    );
    assert.equal(
      leader.x1,
      note.target.x + note.target.w,
      `${note.id} leader should start on the target right edge`,
    );
    assert.equal(
      leader.y1,
      targetCenterY,
      `${note.id} leader should start at the target edge center`,
    );
    assert.equal(
      leader.x2,
      calloutX - 6,
      `${note.id} leader should stop just before the callout text`,
    );
    assert.equal(
      leader.y2,
      text.y,
      `${note.id} leader should point at the resolved lane text`,
    );
    assert.ok(
      leader.x2 > note.target.x + note.target.w,
      `${note.id} leader should route outward instead of crossing the target node`,
    );
  }

  const viewBox = svgViewBox(markup);
  assert.ok(
    viewBox.x + viewBox.w > calloutX + 80,
    `content viewBox should include callout text beyond the lane anchor, got ${JSON.stringify(
      viewBox,
    )} calloutX=${calloutX}`,
  );
});

test('annotation lineGap controls dense multiline note spacing from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'annotation-line-gap-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 0 },
          'Service',
        ),

        createElement(
          Diagram.Note,
          { target: 'service', anchor: 'right', fontSize: 12, lineGap: 1 },
          createElement(Diagram.Line, null, 'First line'),
          createElement(Diagram.Line, null, 'Second line'),
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /data-diagram-annotation="service:right"[^>]*data-diagram-annotation-line-gap="1"[^>]*font-size="12"/,
    'lineGap should be exposed on the rendered annotation text for black-box verification',
  );
  assert.match(
    markup,
    /<tspan[^>]*dy="13"[^>]*>Second line<\/tspan>/,
    'lineGap should tighten multiline annotation tspan spacing from the default fontSize + 4',
  );
});

test('multi-target guide annotations keep an external repo and GitOps service paired', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'multi-target-gitops-callout-test',
      defaultMode: 'static',
      graph: {
        columns: [128, 128, 128],
        rows: [72, 72],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Group,
          {
            id: 'cluster',
            label: 'Cluster',
            rowStart: 0,
            rowEnd: 1,
            colStart: 0,
            colEnd: 1,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'deploy', row: 1, col: 1, width: 84, height: 40 },
            'ArgoCD',
          ),
        ),
        createElement(
          Diagram.Box,
          { id: 'repo', row: 1, col: 2, width: 84, height: 40 },
          'Git Repo',
        ),

        createElement(Diagram.Guide, {
          id: 'right-callouts',
          orientation: 'vertical',
          target: 'repo',
          anchor: 'right',
          gap: 32,
        }),
        createElement(
          Diagram.Note,
          {
            targets: ['deploy', 'repo'],
            anchor: 'top',
            guide: 'right-callouts',
            dy: -28,
            fontSize: 10,
            leader: true,
          },

          createElement(Diagram.Line, null, 'Continuous deployment'),
          createElement(Diagram.Line, null, 'requests'),
        ),

        createElement(Diagram.Arrow, {
          from: 'repo',
          to: 'deploy',
          exitSide: 'left',
          entrySide: 'right',
          lineStyle: 'dashed',
          layer: 'background',
        }),
      ],
    }),
  );

  const cluster = renderedRect(markup, 'data-diagram-group', 'cluster');
  const deploy = renderedRect(markup, 'data-diagram-node', 'deploy');
  const repo = renderedRect(markup, 'data-diagram-node', 'repo');
  const noteId = 'deploy+repo:top';
  const note = renderedTextPoint(markup, 'data-diagram-annotation', noteId);
  const calloutX = Math.round((repo.x + repo.w + 32) / 4) * 4;

  assert.match(
    markup,
    /data-diagram-annotation="deploy\+repo:top"[^>]*data-diagram-annotation-targets="deploy repo"[^>]*data-diagram-annotation-anchor="top"[^>]*data-diagram-annotation-guide="right-callouts"/,
    'multi-target notes should expose the paired target ids and guide id for black-box tests',
  );
  assert.match(
    markup,
    /data-diagram-annotation-leader="deploy\+repo:top"[^>]*data-diagram-annotation-leader-target="deploy"[^>]*data-diagram-annotation-leader-anchor="top"/,
    'multi-target notes should render a leader back to the in-cluster service',
  );
  assert.match(
    markup,
    /data-diagram-annotation-leader="deploy\+repo:top"[^>]*data-diagram-annotation-leader-target="repo"[^>]*data-diagram-annotation-leader-anchor="top"/,
    'multi-target notes should render a leader back to the external repository',
  );
  assert.equal(
    note.x,
    calloutX,
    'paired GitOps note should align to the shared right-side callout lane',
  );
  assert.ok(
    note.x > cluster.x + cluster.w,
    `paired GitOps note should sit outside the cluster frame, got note=${JSON.stringify(
      note,
    )} cluster=${JSON.stringify(cluster)}`,
  );
  assert.ok(
    note.x > repo.x + repo.w,
    `paired GitOps note should sit outside the external repo card, got note=${JSON.stringify(
      note,
    )} repo=${JSON.stringify(repo)}`,
  );

  for (const [targetId, target] of [
    ['deploy', deploy],
    ['repo', repo],
  ] as const) {
    const leader = renderedAnnotationLeader(markup, noteId, targetId);
    assert.equal(
      leader.x1,
      target.x + target.w / 2,
      `${targetId} leader should start from the card top-center anchor`,
    );
    assert.equal(
      leader.y1,
      target.y,
      `${targetId} leader should start on the card top edge`,
    );
    assert.equal(
      leader.x2,
      calloutX,
      `${targetId} leader should terminate on the shared callout lane`,
    );
    assert.ok(
      leader.y2 < target.y,
      `${targetId} leader should stop above the card body, got leader=${JSON.stringify(
        leader,
      )} target=${JSON.stringify(target)}`,
    );
  }

  const route = renderedEdgePath(markup, 'repo->deploy');
  for (const segment of pathSegments(route)) {
    const midpoint = {
      x: (segment.x1 + segment.x2) / 2,
      y: (segment.y1 + segment.y2) / 2,
    };
    assert.ok(
      !pointInsideRect(midpoint, deploy),
      `repo->deploy route should not run through deploy body, got segment=${JSON.stringify(
        segment,
      )} deploy=${JSON.stringify(deploy)}`,
    );
    assert.ok(
      !pointInsideRect(midpoint, repo),
      `repo->deploy route should not run through repo body, got segment=${JSON.stringify(
        segment,
      )} repo=${JSON.stringify(repo)}`,
    );
  }
});

test('elbow annotation leaders route around dense right-side callouts', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'elbow-annotation-leader-test',
      defaultMode: 'static',
      graph: {
        columns: [128, 128, 128],
        rows: [72, 72],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Group,
          {
            id: 'cluster',
            label: 'Cluster',
            rowStart: 0,
            rowEnd: 1,
            colStart: 0,
            colEnd: 1,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'auth', row: 0, col: 1, width: 84, height: 40 },
            'Auth',
          ),
          createElement(
            Diagram.Box,
            { id: 'deploy', row: 1, col: 1, width: 84, height: 40 },
            'ArgoCD',
          ),
        ),
        createElement(
          Diagram.Box,
          { id: 'repo', row: 1, col: 2, width: 84, height: 40 },
          'Git Repo',
        ),

        createElement(Diagram.Guide, {
          id: 'side-callouts',
          orientation: 'vertical',
          target: 'cluster',
          anchor: 'right',
          gap: 48,
        }),
        createElement(Diagram.Guide, {
          id: 'pair-callouts',
          orientation: 'vertical',
          target: 'repo',
          anchor: 'right',
          gap: 32,
        }),

        createElement(
          Diagram.Note,
          {
            target: 'auth',
            anchor: 'right',
            guide: 'side-callouts',
            dy: 24,
            leader: true,
            leaderRoute: 'elbow',
          },
          'Authentication lane',
        ),
        createElement(
          Diagram.Note,
          {
            targets: ['deploy', 'repo'],
            anchor: 'top',
            guide: 'pair-callouts',
            dy: -28,
            fontSize: 10,
            leader: true,
            leaderRoute: 'elbow',
          },

          createElement(Diagram.Line, null, 'Continuous deployment'),
          createElement(Diagram.Line, null, 'requests'),
        ),
      ],
    }),
  );

  const cluster = renderedRect(markup, 'data-diagram-group', 'cluster');
  const auth = renderedRect(markup, 'data-diagram-node', 'auth');
  const deploy = renderedRect(markup, 'data-diagram-node', 'deploy');
  const repo = renderedRect(markup, 'data-diagram-node', 'repo');
  const sideCalloutX = Math.round((cluster.x + cluster.w + 48) / 4) * 4;
  const pairCalloutX = Math.round((repo.x + repo.w + 32) / 4) * 4;

  assert.match(
    markup,
    /data-diagram-annotation-leader="auth:right"[^>]*data-diagram-annotation-leader-target="auth"[^>]*data-diagram-annotation-leader-route="elbow"/,
    'single-target side callouts should expose elbow leader routes',
  );
  assert.match(
    markup,
    /data-diagram-annotation-leader="deploy\+repo:top"[^>]*data-diagram-annotation-leader-target="deploy"[^>]*data-diagram-annotation-leader-route="elbow"/,
    'multi-target callouts should expose elbow leader routes per target',
  );

  const authNote = renderedTextPoint(
    markup,
    'data-diagram-annotation',
    'auth:right',
  );
  const authPath = renderedAnnotationLeaderPath(markup, 'auth:right', 'auth');
  assert.deepEqual(authPath.points, [
    { x: auth.x + auth.w, y: auth.y + auth.h / 2 },
    { x: auth.x + auth.w, y: authNote.y },
    { x: sideCalloutX - 6, y: authNote.y },
  ]);

  const pairNote = renderedTextPoint(
    markup,
    'data-diagram-annotation',
    'deploy+repo:top',
  );
  const pairLeaderY = pairNote.y + 10 + 6;
  for (const [targetId, target] of [
    ['deploy', deploy],
    ['repo', repo],
  ] as const) {
    const path = renderedAnnotationLeaderPath(
      markup,
      'deploy+repo:top',
      targetId,
    );
    assert.deepEqual(path.points, [
      { x: target.x + target.w / 2, y: target.y },
      { x: target.x + target.w / 2, y: pairLeaderY },
      { x: pairCalloutX, y: pairLeaderY },
    ]);
  }

  const elbowSegments = [
    ...authPath.segments,
    ...renderedAnnotationLeaderPath(markup, 'deploy+repo:top', 'deploy')
      .segments,
    ...renderedAnnotationLeaderPath(markup, 'deploy+repo:top', 'repo').segments,
  ];

  for (const [rectId, rect] of [
    ['auth', auth],
    ['deploy', deploy],
    ['repo', repo],
  ] as const) {
    for (const segment of elbowSegments) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `elbow annotation leader should not cross ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
});

test('rejects target waypoints that do not match a node or group', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'missing-target-waypoint-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'source', row: 0, col: 0 },
              'Source',
            ),
            createElement(
              Diagram.Box,
              { id: 'target', row: 0, col: 1 },
              'Target',
            ),
            createElement(
              Diagram.Arrow,
              { from: 'source', to: 'target' },
              createElement(Diagram.Waypoint, {
                target: 'missing',
                anchor: 'right',
              }),
            ),
          ],
        }),
      ),
    /Diagram\.Waypoint target "missing" does not match a node or group\./,
  );
});

test('rejects guide waypoints that do not match a Diagram.Guide id', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'missing-guide-waypoint-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'source', row: 0, col: 0 },
              'Source',
            ),
            createElement(
              Diagram.Box,
              { id: 'target', row: 0, col: 1 },
              'Target',
            ),
            createElement(
              Diagram.Arrow,
              { from: 'source', to: 'target' },
              createElement(Diagram.Waypoint, { guide: 'missing', y: 80 }),
            ),
          ],
        }),
      ),
    /Diagram\.Waypoint guide "missing" does not match a Diagram\.Guide id\./,
  );
});

test('rejects guide annotations that do not match a Diagram.Guide id', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'missing-guide-annotation-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'service', row: 0, col: 0 },
              'Service',
            ),
            createElement(
              Diagram.Note,
              { target: 'service', anchor: 'right', guide: 'missing' },
              'Missing guide',
            ),
          ],
        }),
      ),
    /Diagram\.Text guide "missing" does not match a Diagram\.Guide id\./,
  );
});

test('rejects guide annotations when the Diagram.Guide has no orientation', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'missing-guide-orientation-annotation-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'service', row: 0, col: 0 },
              'Service',
            ),
            createElement(Diagram.Guide, {
              id: 'callouts',
              target: 'service',
              anchor: 'right',
            }),
            createElement(
              Diagram.Note,
              { target: 'service', anchor: 'right', guide: 'callouts' },
              'Needs orientation',
            ),
          ],
        }),
      ),
    /Diagram\.Guide "callouts" needs an orientation before Diagram\.Text can use it\./,
  );
});

test('rejects negative annotation lineGap values', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'negative-annotation-line-gap-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'service', row: 0, col: 0 },
              'Service',
            ),
            createElement(
              Diagram.Note,
              { target: 'service', anchor: 'right', lineGap: -1 },
              'Bad line gap',
            ),
          ],
        }),
      ),
    /Diagram\.Text lineGap must be a non-negative finite number, got -1\./,
  );
});

test('rejects annotations that mix target and targets', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'mixed-note-targets-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'service', row: 0, col: 0 },
              'Service',
            ),
            createElement(Diagram.Box, { id: 'repo', row: 0, col: 1 }, 'Repo'),
            createElement(
              Diagram.Note,
              { target: 'service', targets: ['repo'], anchor: 'top' },
              'Ambiguous target',
            ),
          ],
        }),
      ),
    /Diagram\.Text accepts either target or targets, not both\./,
  );
});

test('rejects empty multi-target annotations', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'empty-note-targets-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'service', row: 0, col: 0 },
              'Service',
            ),
            createElement(
              Diagram.Note,
              { targets: [], anchor: 'top' },
              'Empty target list',
            ),
          ],
        }),
      ),
    /Diagram\.Text targets must include at least one id\./,
  );
});

test('rejects duplicate Diagram.Guide ids before routing', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'duplicate-guide-test',
          defaultMode: 'static',
          children: [
            createElement(
              Diagram.Box,
              { id: 'source', row: 0, col: 0 },
              'Source',
            ),
            createElement(
              Diagram.Box,
              { id: 'target', row: 0, col: 1 },
              'Target',
            ),
            createElement(Diagram.Guide, {
              id: 'shared-rail',
              orientation: 'vertical',
              x: 120,
            }),
            createElement(Diagram.Guide, {
              id: 'shared-rail',
              orientation: 'vertical',
              x: 160,
            }),
            createElement(
              Diagram.Arrow,
              { from: 'source', to: 'target' },
              createElement(Diagram.Waypoint, {
                guide: 'shared-rail',
                target: 'source',
              }),
            ),
          ],
        }),
      ),
    /Duplicate Diagram guide id "shared-rail"\./,
  );
});

test('renders the full homelab reference topology as a dense graph fixture', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'full-homelab-reference-test',
      defaultMode: 'static',
      graph: {
        columns: [160, 176, 188, 188, 256, 188, 216, 160],
        rows: [96, 112, 120, 120, 120, 112],
      },
      children: [
        createElement(
          Diagram.Box,
          {
            id: 'cloudflare-dns',
            row: 0,
            col: 3,
            icon: 'cloudflare',
            tone: 'amber',
            texture: 'hatch',
          },

          createElement(Diagram.Line, null, 'Cloudflare'),
          createElement(Diagram.Line, null, 'DNS & Domain'),
          createElement(Diagram.Line, null, 'Management'),
        ),
        createElement(
          Diagram.Box,
          {
            id: 'public-internet',
            row: 0,
            col: 4,
            icon: 'internet',
            tone: 'blue',
          },
          'Public Internet',
        ),
        createElement(
          Diagram.Box,
          { id: 'isp', row: 2, col: 0, icon: 'internet', tone: 'slate' },
          createElement(Diagram.Line, null, 'ISP Connection'),
          createElement(Diagram.Line, null, '(1 Gbps)'),
        ),
        createElement(Diagram.Marker, {
          id: 'router',
          row: 2,
          col: 1,
          icon: 'router',
          iconSize: 30,
          width: 72,
          height: 56,
          tone: 'slate',
          caption: 'Fritzbox Router',
          captionSide: 'bottom',
        }),
        createElement(
          Diagram.Card,
          {
            id: 'laptop',
            row: 4,
            col: 1,
            width: 232,
            height: 184,
            icon: 'server',
            tone: 'slate',
            texture: 'hatch',
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
            id: 'adguard',
            row: 1,
            col: 2,
            icon: 'shield',
            tone: 'green',
            texture: 'hatch',
            caption: 'DNS Forwarder',
            captionSide: 'bottom',
          },
          'AdGuard Home',
        ),
        createElement(
          Diagram.Group,
          {
            id: 'proxmox',
            label: ['Proxmox VE', '(Hypervisor)'],
            rowStart: 3,
            rowEnd: 4,
            colStart: 2,
            colEnd: 2,
            tone: 'amber',
            texture: 'hatch',
          },

          createElement(
            Diagram.Card,
            {
              id: 'proxmox-vm',
              row: 3.5,
              col: 2,
              stack: 3,
              icon: 'server',
              tone: 'amber',
              caption: 'VM',
              captionSide: 'top',
            },
            'VM',
          ),
        ),
        createElement(
          Diagram.Box,
          {
            id: 'external-ssd',
            row: 5,
            col: 2,
            icon: 'storage',
            tone: 'slate',
            texture: 'hatch',
          },

          createElement(Diagram.Line, null, '4TB'),
          createElement(Diagram.Line, null, 'External SSD'),
        ),
        createElement(
          Diagram.Marker,
          {
            id: 'git-repo',
            row: 3,
            col: 7,
            icon: 'git',
            iconSize: 34,
            width: 72,
            height: 76,
            tone: 'slate',
          },
          'Git Repo',
        ),

        createElement(
          Diagram.Group,
          {
            id: 'cluster',
            label: 'K3s Kubernetes Cluster',
            labelAlign: 'start',
            padding: 48,
            tone: 'blue',
            texture: 'hatch',
            ports: [
              { id: 'tunnel', side: 'top', offset: 170, label: 'Tunnel' },
            ],
          },

          createElement(
            Diagram.Group,
            {
              id: 'ingress',
              label: 'Networking & Ingress',
              labelAlign: 'start',
              tone: 'blue',
            },

            createElement(
              Diagram.Box,
              { id: 'metallb', row: 1, col: 3, icon: 'router', tone: 'blue' },
              createElement(Diagram.Line, null, 'MetalLB'),
              createElement(Diagram.Line, null, '(Load Balancer)'),
            ),
            createElement(
              Diagram.Box,
              { id: 'gateway', row: 1, col: 4, icon: 'shield', tone: 'blue' },
              createElement(Diagram.Line, null, 'Istio Ingress Gateway'),
              createElement(Diagram.Line, null, '(North-South Gateway)'),
            ),
          ),

          createElement(
            Diagram.Group,
            { id: 'k3s-vms', label: 'K3s', tone: 'green', texture: 'hatch' },
            createElement(
              Diagram.Card,
              {
                id: 'k3s-master',
                row: 2,
                col: 3,
                icon: 'kubernetes',
                tone: 'green',
                texture: 'hatch',
              },

              createElement(Diagram.Line, null, 'K3s master'),
              createElement(Diagram.Line, null, 'Pods'),
            ),
          ),

          createElement(
            Diagram.Group,
            { id: 'mesh', label: 'Service Mesh', tone: 'blue' },
            createElement(
              Diagram.Card,
              {
                id: 'istio',
                row: 2,
                col: 4,
                colSpan: 2,
                height: 112,
                icon: 'istio',
                tone: 'blue',
              },

              createElement(Diagram.Line, null, 'Istio Service Mesh'),
              createElement(Diagram.Line, { textColor: 'dim' }, 'mTLS Enabled'),
            ),
          ),

          createElement(
            Diagram.Group,
            { id: 'certificates', label: 'Certificates', tone: 'slate' },
            createElement(
              Diagram.Box,
              {
                id: 'cert-manager',
                row: 1,
                col: 5,
                icon: 'certificate',
                tone: 'slate',
              },
              'Cert-Manager',
            ),
          ),

          createElement(
            Diagram.Box,
            { id: 'authentik', row: 2, col: 6, icon: 'shield', tone: 'rose' },
            createElement(Diagram.Line, null, 'Authentik'),
            createElement(Diagram.Line, null, '(SSO)'),
          ),
          createElement(
            Diagram.Box,
            { id: 'argocd', row: 3, col: 6, icon: 'git', tone: 'amber' },
            createElement(Diagram.Line, null, 'ArgoCD'),
            createElement(Diagram.Line, null, '(GitOps Deployment)'),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'storage',
              label: 'Storage',
              labelAlign: 'start',
              tone: 'slate',
            },

            createElement(
              Diagram.Box,
              {
                id: 'longhorn',
                row: 4,
                col: 3,
                icon: 'storage',
                tone: 'slate',
              },

              createElement(Diagram.Line, null, 'Longhorn'),
              createElement(Diagram.Line, null, '(Storage Class)'),
            ),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'monitoring',
              label: 'Monitoring',
              dividers: { rows: [5], cols: [5] },
              tone: 'amber',
              texture: 'hatch',
            },

            createElement(
              Diagram.Box,
              {
                id: 'grafana',
                row: 4,
                col: 4,
                icon: 'dashboard',
                tone: 'amber',
              },

              createElement(Diagram.Line, null, 'Grafana'),
              createElement(Diagram.Line, null, '(Dashboards)'),
            ),
            createElement(
              Diagram.Box,
              {
                id: 'victoria-metrics',
                row: 4,
                col: 5,
                icon: 'metrics',
                tone: 'amber',
              },

              createElement(Diagram.Line, null, 'VictoriaMetrics'),
              createElement(Diagram.Line, null, '(Metrics)'),
            ),
            createElement(
              Diagram.Box,
              {
                id: 'victoria-logs',
                row: 5,
                col: 4,
                icon: 'logs',
                tone: 'amber',
              },

              createElement(Diagram.Line, null, 'VictoriaLogs'),
              createElement(Diagram.Line, null, '(Logs)'),
            ),
            createElement(
              Diagram.Box,
              { id: 'jaeger', row: 5, col: 5, icon: 'trace', tone: 'amber' },
              createElement(Diagram.Line, null, 'Jaeger'),
              createElement(Diagram.Line, null, '(Traces)'),
            ),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'gpu-scheduling',
              label: 'GPU Scheduling',
              labelAlign: 'start',
              tone: 'green',
              texture: 'hatch',
              titleBand: true,
              tight: true,
              padding: { top: 14, right: 12, bottom: 12, left: 12 },
            },

            createElement(
              Diagram.Card,
              {
                id: 'gpu-workflow',
                group: 'gpu-scheduling',
                row: 5,
                col: 6,
                width: 204,
                height: 112,
                icon: 'gpu',
                tone: 'green',
                texture: 'hatch',
                description: ['GPU Workflow', 'NVIDIA RTX 3050'],
                items: ['K3s Node Affinity', 'Automatic GPU Scheduling'],
              },
              'GPU Workflow',
            ),
          ),
        ),

        createElement(Diagram.Arrow, {
          from: 'cloudflare-dns',
          to: 'public-internet',
        }),
        createElement(
          Diagram.Arrow,
          {
            from: 'public-internet',
            to: 'cluster:tunnel',
            channel: 'tunnel',
            strokeWidth: 3,
            labelSide: 'right',
            badgeIcon: 'tunnel',
            badgeLabel: ['Cloudflare Tunnel', '(Zero Trust)'],
            badgeSide: 'right',
            badgeOffset: 34,
            badgeT: 0.35,
          },
          'Cloudflare Tunnel',
        ),
        createElement(Diagram.Arrow, { from: 'isp', to: 'router' }),
        createElement(Diagram.Arrow, {
          from: 'router',
          to: 'adguard',
          channel: 'dns',
          lineStyle: 'dashed',
        }),
        createElement(Diagram.Arrow, { from: 'router', to: 'proxmox' }),
        createElement(Diagram.Arrow, { from: 'laptop', to: 'external-ssd' }),
        createElement(
          Diagram.Arrow,
          {
            from: 'external-ssd',
            to: 'longhorn',
            channel: 'storage',
            lineStyle: 'dashed',
          },
          'Distributed Storage & Backups',
        ),
        createElement(Diagram.Arrow, { from: 'proxmox', to: 'k3s-master' }),
        createElement(
          Diagram.Arrow,
          {
            from: 'metallb',
            to: 'gateway',
            labelSide: 'above',
            labelFrame: true,
          },
          'External IPs',
        ),
        createElement(Diagram.Arrow, {
          from: 'gateway',
          to: 'istio',
          channel: 'mtls',
          direction: 'both',
        }),
        createElement(
          Diagram.Arrow,
          {
            from: 'cert-manager',
            to: 'gateway',
            channel: 'certificates',
            labelSide: 'above',
            lineStyle: 'dashed',
            labelFrame: true,
          },
          "Let's Encrypt certificates",
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'authentik',
            to: 'istio',
            channel: 'auth',
            labelSide: 'right',
          },
          'Authentication for services in mesh',
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'argocd',
            to: 'istio',
            channel: 'deploy',
            labelSide: 'right',
          },
          'Deploys applications into k3s',
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'git-repo',
            to: 'argocd',
            channel: 'gitops',
            lineStyle: 'dashed',
            labelSide: 'left',
          },
          'Continuous deployment requests',
        ),
        createElement(Diagram.Arrow, {
          from: 'longhorn',
          to: 'istio',
          channel: 'storage',
        }),
        createElement(Diagram.Arrow, {
          from: 'grafana',
          to: 'istio',
          channel: 'observability',
        }),
        createElement(Diagram.Arrow, {
          from: 'victoria-metrics',
          to: 'istio',
          channel: 'observability',
        }),
        createElement(Diagram.Arrow, {
          from: 'victoria-logs',
          to: 'istio',
          channel: 'observability',
        }),
        createElement(Diagram.Arrow, {
          from: 'jaeger',
          to: 'istio',
          channel: 'observability',
        }),
        createElement(Diagram.Arrow, {
          from: 'gpu-scheduling',
          to: 'istio',
          channel: 'gpu',
        }),
      ],
    }),
  );

  for (const label of [
    'Cloudflare',
    'Public Internet',
    'Fritzbox Router',
    'Dell Laptop',
    'Proxmox VE',
    'K3s Kubernetes Cluster',
    'Istio Service Mesh',
    'Cert-Manager',
    'Authentik',
    'ArgoCD',
    'Longhorn',
    'Monitoring',
    'GPU Scheduling',
    'Git Repo',
  ]) {
    assert.match(markup, new RegExp(escapeRegExp(label)));
  }

  for (const groupId of [
    'cluster',
    'ingress',
    'k3s-vms',
    'mesh',
    'certificates',
    'storage',
    'monitoring',
    'gpu-scheduling',
  ]) {
    assert.match(
      markup,
      new RegExp(`data-diagram-group="${groupId}"`),
      `expected ${groupId} group frame to render`,
    );
  }

  assert.match(markup, /data-diagram-port="cluster:tunnel"/);
  assert.match(markup, /data-diagram-group-tone="blue"/);
  assert.match(markup, /data-diagram-group-texture="cluster:hatch"/);
  assert.match(markup, /data-diagram-node-tone="green"/);
  assert.match(markup, /data-diagram-node-texture="adguard:hatch"/);
  assert.match(markup, /data-diagram-node-caption="router"/);
  assert.match(markup, /data-diagram-node-caption="adguard"/);
  assert.match(
    markup,
    /data-diagram-edge-channel="tunnel"[^>]*stroke-width="3"/,
  );
  assert.match(
    markup,
    /data-diagram-edge-channel="dns"[^>]*stroke-dasharray="6 6"/,
  );
  assert.match(markup, /data-diagram-edge-channel="mtls"[^>]*marker-start=/);
  assert.match(markup, /data-diagram-group-divider="monitoring:row:5"/);
  assert.match(markup, /data-diagram-group-divider="monitoring:col:5"/);
  assert.match(markup, /data-diagram-node-stack="proxmox-vm:2"/);
  assert.match(markup, /data-diagram-node-item="laptop:3"/);
  assert.match(markup, /data-diagram-node-item="gpu-workflow:1"/);
  assert.match(markup, /Continuous deployment requests/);
  assert.match(markup, /Let&#x27;s Encrypt certificates/);
  assert.match(
    markup,
    /data-diagram-edge-badge="public-internet-&gt;cluster:tunnel"/,
  );
  assert.match(markup, /data-diagram-edge-label-frame="metallb-&gt;gateway"/);
  assert.match(
    markup,
    /data-diagram-edge-label-frame="cert-manager-&gt;gateway"/,
  );

  const edgePaths = [
    ...markup.matchAll(/<path data-diagram-edge="[^"]+"[^>]*\sd="([^"]+)"/g),
  ].map(firstCapture);
  assert.equal(edgePaths.length, 20);
  assert.ok(
    edgePaths.every((path) => path.includes('L') || path.includes('Q')),
    `full reference topology should render all relationships as routed SVG paths, got ${edgePaths.join(' | ')}`,
  );
});

test('renders the homelab reference diagram through the public package API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: ['Homelab K3s reference', 'Zero-trust service platform'],
      defaultMode: 'static',
      controls: false,
      showHeader: false,
      stylePreset: 'sketch',
      paper: true,
      graph: {
        columns: [160, 176, 188, 188, 256, 188, 216, 160],
        rows: [280, 112, 120, 120, 120, 112],
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          {
            id: 'cloudflare-dns',
            row: 0,
            col: 3,
            icon: 'cloudflare',
            iconSize: 28,
            tone: 'amber',
            texture: 'hatch',
          },

          createElement(Diagram.Line, null, 'Cloudflare'),
          createElement(Diagram.Line, null, 'DNS & Domain'),
          createElement(Diagram.Line, null, 'Management'),
        ),
        createElement(
          Diagram.Box,
          {
            id: 'public-internet',
            row: 0,
            col: 4,
            icon: 'internet',
            iconSize: 30,
            tone: 'blue',
          },
          'Public Internet',
        ),
        createElement(
          Diagram.Connector,
          {
            id: 'cloudflare-tunnel',
            row: 0.17,
            col: 4,
            width: 148,
            height: 28,
            icon: 'tunnel',
            iconSize: 16,
            fontSize: 9,
            tone: 'blue',
            texture: 'none',
          },

          createElement(Diagram.Line, null, 'Cloudflare Tunnel'),
          createElement(Diagram.Line, { textColor: 'dim' }, '(Zero Trust)'),
        ),
        createElement(
          Diagram.Box,
          {
            id: 'isp',
            row: 2,
            col: 0,
            icon: 'internet',
            iconSize: 30,
            tone: 'slate',
          },

          createElement(Diagram.Line, null, 'ISP Connection'),
          createElement(Diagram.Line, null, '(1 Gbps)'),
        ),
        createElement(Diagram.Appliance, {
          id: 'router',
          row: 2,
          col: 1,
          width: 116,
          height: 72,
          tone: 'slate',
          texture: 'hatch',
          appliancePorts: 5,
          antenna: true,
          caption: 'Fritzbox Router',
          captionSide: 'bottom',
        }),
        createElement(
          Diagram.Card,
          {
            id: 'laptop',
            row: 4,
            col: 0.7,
            width: 208,
            height: 184,
            icon: 'server',
            iconSize: 28,
            tone: 'slate',
            texture: 'hatch',
            bodyFontSize: 10,
            bodyLineGap: 2,
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
            id: 'adguard',
            row: 1,
            col: 2,
            icon: 'shield',
            iconSize: 28,
            tone: 'green',
            texture: 'hatch',
            caption: 'DNS Forwarder',
            captionSide: 'bottom',
          },
          'AdGuard Home',
        ),
        createElement(
          Diagram.Group,
          {
            id: 'proxmox',
            label: ['Proxmox VE', '(Hypervisor)'],
            rowStart: 3,
            rowEnd: 4,
            colStart: 2,
            colEnd: 2,
            tight: true,
            tightX: true,
            titleBand: true,
            padding: { top: 46, right: 6, bottom: 18, left: 8 },
            tone: 'amber',
            texture: 'hatch',
          },

          createElement(
            Diagram.Card,
            {
              id: 'proxmox-vm',
              row: 3.5,
              col: 2,
              width: 120,
              height: 56,
              stack: 4,
              stackDirection: 'up-left',
              stackDx: 15,
              stackDy: 10,
              stackWidthStep: 12,
              stackHeightStep: 8,
              icon: 'server',
              iconSize: 26,
              tone: 'amber',
              caption: 'VM',
              captionSide: 'top',
            },
            'VM',
          ),
        ),
        createElement(
          Diagram.Box,
          {
            id: 'external-ssd',
            row: 5,
            col: 2,
            icon: 'storage',
            iconSize: 30,
            tone: 'slate',
            texture: 'hatch',
          },

          createElement(Diagram.Line, null, '4TB'),
          createElement(Diagram.Line, null, 'External SSD'),
        ),
        createElement(
          Diagram.Marker,
          {
            id: 'git-repo',
            row: 3,
            col: 7,
            icon: 'git',
            iconSize: 34,
            width: 72,
            height: 76,
            tone: 'slate',
          },
          'Git Repo',
        ),

        createElement(
          Diagram.Group,
          {
            id: 'cluster',
            label: 'K3s Kubernetes Cluster',
            labelAlign: 'start',
            titleBand: true,
            titleGap: 10,
            padding: { top: 34, right: 28, bottom: 24, left: 28 },
            tone: 'blue',
            texture: 'hatch',
          },

          createElement(
            Diagram.Group,
            {
              id: 'ingress',
              label: 'Networking & Ingress',
              labelAlign: 'start',
              tone: 'blue',
              titleBand: true,
              padding: { top: 18, right: 16, bottom: 18, left: 16 },
            },

            createElement(
              Diagram.Box,
              {
                id: 'metallb',
                row: 1,
                col: 3,
                icon: 'router',
                iconSize: 28,
                tone: 'blue',
              },

              createElement(Diagram.Line, null, 'MetalLB'),
              createElement(Diagram.Line, null, '(Load Balancer)'),
            ),
            createElement(
              Diagram.Box,
              {
                id: 'gateway',
                row: 1,
                col: 4,
                icon: 'shield',
                iconSize: 28,
                tone: 'blue',
              },

              createElement(Diagram.Line, null, 'Istio Ingress Gateway'),
              createElement(Diagram.Line, null, '(North-South Gateway)'),
            ),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'k3s-vms',
              label: 'K3s',
              tight: true,
              titleBand: true,
              padding: { top: 34, right: 14, bottom: 14, left: 14 },
              tone: 'green',
              texture: 'hatch',
            },

            createElement(
              Diagram.Card,
              {
                id: 'k3s-master',
                row: 2,
                col: 3,
                icon: 'kubernetes',
                iconSize: 28,
                tone: 'green',
                texture: 'hatch',
              },

              createElement(Diagram.Line, null, 'K3s master'),
              createElement(Diagram.Line, null, 'Pods'),
            ),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'mesh',
              label: 'Service Mesh',
              tight: true,
              titleBand: true,
              padding: { top: 34, right: 14, bottom: 14, left: 14 },
              tone: 'blue',
            },

            createElement(
              Diagram.Card,
              {
                id: 'istio',
                row: 2,
                col: 4,
                colSpan: 2,
                height: 112,
                icon: 'istio',
                iconSize: 36,
                tone: 'blue',
              },

              createElement(Diagram.Line, null, 'Istio Service Mesh'),
              createElement(Diagram.Line, { textColor: 'dim' }, 'mTLS Enabled'),
            ),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'certificates',
              label: 'Certificates',
              tight: true,
              titleBand: true,
              padding: { top: 34, right: 14, bottom: 14, left: 14 },
              tone: 'slate',
            },

            createElement(
              Diagram.Box,
              {
                id: 'cert-manager',
                row: 1,
                col: 5,
                icon: 'certificate',
                iconSize: 26,
                tone: 'slate',
              },
              'Cert-Manager',
            ),
          ),

          createElement(
            Diagram.Box,
            {
              id: 'authentik',
              row: 2,
              col: 6,
              icon: 'shield',
              iconSize: 28,
              tone: 'rose',
            },

            createElement(Diagram.Line, null, 'Authentik'),
            createElement(Diagram.Line, null, '(SSO)'),
          ),
          createElement(
            Diagram.Box,
            {
              id: 'argocd',
              row: 3,
              col: 6,
              icon: 'git',
              iconSize: 28,
              tone: 'amber',
            },

            createElement(Diagram.Line, null, 'ArgoCD'),
            createElement(Diagram.Line, null, '(GitOps Deployment)'),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'storage',
              label: 'Storage',
              labelAlign: 'start',
              tight: true,
              titleBand: true,
              padding: { top: 34, right: 14, bottom: 14, left: 14 },
              tone: 'slate',
            },

            createElement(
              Diagram.Box,
              {
                id: 'longhorn',
                row: 4,
                col: 3,
                icon: 'storage',
                iconSize: 28,
                tone: 'slate',
              },

              createElement(Diagram.Line, null, 'Longhorn'),
              createElement(Diagram.Line, null, '(Storage Class)'),
            ),
          ),

          createElement(
            Diagram.Group,
            {
              id: 'monitoring',
              label: 'Monitoring',
              dividers: { rows: [5], cols: [5] },
              tightX: true,
              tightY: true,
              titleBand: true,
              padding: { top: 34, right: 8, bottom: 16, left: 16 },
              tone: 'amber',
              texture: 'hatch',
            },

            createElement(
              Diagram.Box,
              {
                id: 'grafana',
                row: 4,
                col: 4,
                icon: 'dashboard',
                iconSize: 28,
                tone: 'amber',
              },

              createElement(Diagram.Line, null, 'Grafana'),
              createElement(Diagram.Line, null, '(Dashboards)'),
            ),
            createElement(
              Diagram.Box,
              {
                id: 'victoria-metrics',
                row: 4,
                col: 5,
                icon: 'metrics',
                iconSize: 28,
                tone: 'amber',
              },

              createElement(Diagram.Line, null, 'VictoriaMetrics'),
              createElement(Diagram.Line, null, '(Metrics)'),
            ),
            createElement(
              Diagram.Box,
              {
                id: 'victoria-logs',
                row: 5,
                col: 4,
                icon: 'logs',
                iconSize: 28,
                tone: 'amber',
              },

              createElement(Diagram.Line, null, 'VictoriaLogs'),
              createElement(Diagram.Line, null, '(Logs)'),
            ),
            createElement(
              Diagram.Box,
              {
                id: 'jaeger',
                row: 5,
                col: 5,
                icon: 'trace',
                iconSize: 28,
                tone: 'amber',
              },

              createElement(Diagram.Line, null, 'Jaeger'),
              createElement(Diagram.Line, null, '(Traces)'),
            ),
          ),

          createElement(Diagram.Junction, {
            id: 'observability-bus',
            row: 3.5,
            col: 4.5,
            hidden: true,
            tone: 'blue',
          }),

          createElement(
            Diagram.Group,
            {
              id: 'gpu-scheduling',
              label: 'GPU Scheduling',
              labelAlign: 'start',
              tone: 'green',
              texture: 'hatch',
              titleBand: true,
              tight: true,
              padding: { top: 14, right: 4, bottom: 12, left: 4 },
            },

            createElement(
              Diagram.Card,
              {
                id: 'gpu-workflow',
                group: 'gpu-scheduling',
                row: 5,
                col: 6.07,
                width: 204,
                height: 112,
                icon: 'gpu',
                iconSize: 26,
                tone: 'green',
                texture: 'hatch',
                bodyFontSize: 10,
                bodyLineGap: 2,
                description: ['GPU Workflow', 'NVIDIA RTX 3050'],
                items: ['K3s Node Affinity', 'Automatic GPU Scheduling'],
              },
              'GPU Workflow',
            ),
          ),
        ),

        createElement(
          Diagram.Note,
          {
            target: 'cert-manager',
            anchor: 'right',
            guide: 'right-callout-lane',
            dy: -18,
            align: 'start',
            fontSize: 10,
            fontWeight: 600,
            lineGap: 1,
            leader: true,
            leaderRoute: 'elbow',
          },

          createElement(Diagram.Line, null, 'Manages'),
          createElement(Diagram.Line, null, "Let's Encrypt"),
          createElement(Diagram.Line, null, 'certificates'),
        ),
        createElement(
          Diagram.Note,
          {
            target: 'authentik',
            anchor: 'right',
            guide: 'right-callout-lane',
            dy: 34,
            fontSize: 10,
            fontWeight: 600,
            lineGap: 1,
            leader: true,
            leaderRoute: 'elbow',
          },

          createElement(Diagram.Line, null, 'Authentication'),
          createElement(Diagram.Line, null, 'for services'),
          createElement(Diagram.Line, null, 'in mesh'),
        ),
        createElement(
          Diagram.Note,
          {
            target: 'argocd',
            anchor: 'bottom',
            offset: 16,
            dx: -72,
            align: 'start',
            fontSize: 10,
            fontWeight: 600,
            lineGap: 1,
          },

          createElement(Diagram.Line, null, 'Deploys applications'),
          createElement(Diagram.Line, null, 'into k3s'),
        ),
        createElement(Diagram.Guide, {
          id: 'storage-backup-rail',
          orientation: 'horizontal',
          target: 'longhorn',
          anchor: 'bottom',
          gap: 58,
        }),
        createElement(Diagram.Guide, {
          id: 'storage-mesh-rail',
          orientation: 'horizontal',
          target: 'storage',
          anchor: 'top',
          gap: 36,
        }),
        createElement(Diagram.Guide, {
          id: 'left-cluster-handoff-rail',
          orientation: 'vertical',
          target: 'k3s-vms',
          anchor: 'left',
          dx: -2,
        }),
        createElement(Diagram.Guide, {
          id: 'control-plane-rail',
          orientation: 'vertical',
          target: 'cert-manager',
          anchor: 'left',
          gap: 34,
        }),
        createElement(Diagram.Guide, {
          id: 'service-control-entry-rail',
          orientation: 'vertical',
          target: 'istio',
          anchor: 'right',
          gap: 22,
        }),
        createElement(Diagram.Guide, {
          id: 'right-callout-lane',
          orientation: 'vertical',
          target: 'git-repo',
          anchor: 'right',
          gap: 12,
        }),
        createElement(Diagram.Guide, {
          id: 'observability-header-rail',
          orientation: 'horizontal',
          target: 'monitoring',
          anchor: 'top',
          dy: 12,
        }),
        createElement(Diagram.Guide, {
          id: 'observability-branch-rail',
          orientation: 'vertical',
          target: 'monitoring',
          anchor: 'center',
          dx: -6,
        }),
        createElement(Diagram.Guide, {
          id: 'observability-bottom-row-rail',
          orientation: 'horizontal',
          target: 'victoria-logs',
          anchor: 'top',
          gap: 28,
        }),
        createElement(Diagram.Guide, {
          id: 'gpu-top-rail',
          orientation: 'horizontal',
          target: 'monitoring',
          anchor: 'top',
          gap: 58,
        }),
        createElement(Diagram.Arrow, {
          from: 'cloudflare-dns',
          to: 'public-internet',
          layer: 'background',
        }),
        createElement(Diagram.Wire, {
          from: 'public-internet',
          to: 'cloudflare-tunnel',
          layer: 'background',
          channel: 'tunnel',
          strokeWidth: 3,
          exitSide: 'bottom',
          entrySide: 'top',
          entryGap: 0,
        }),
        createElement(Diagram.Arrow, {
          from: 'cloudflare-tunnel',
          to: 'gateway',
          layer: 'background',
          channel: 'tunnel',
          strokeWidth: 3,
          exitSide: 'bottom',
          entrySide: 'top',
          entryGap: 0,
        }),
        createElement(Diagram.Arrow, {
          from: 'isp',
          to: 'router',
          layer: 'background',
        }),
        createElement(Diagram.Arrow, {
          from: 'router',
          to: 'adguard',
          layer: 'background',
          route: 'straight',
          exitSide: 'right',
          entrySide: 'left',
        }),
        createElement(Diagram.Arrow, {
          from: 'router',
          to: 'laptop',
          layer: 'background',
          route: 'straight',
          exitSide: 'bottom',
          exitOffset: -52,
          entrySide: 'top',
        }),
        createElement(Diagram.Arrow, {
          from: 'router',
          to: 'proxmox',
          layer: 'background',
        }),
        createElement(Diagram.Arrow, {
          from: 'laptop',
          to: 'external-ssd',
          layer: 'background',
          route: 'straight',
          exitSide: 'bottom',
          exitOffset: 40,
          entrySide: 'left',
        }),
        createElement(
          Diagram.Arrow,
          {
            from: 'external-ssd',
            to: 'longhorn',
            layer: 'background',
            channel: 'storage',
            lineStyle: 'dashed',
            labelT: 0.68,
            labelSide: 'below',
            labelOffset: 22,
            stubDistance: 18,
            exitSide: 'right',
            entrySide: 'bottom',
          },
          'Distributed Storage & Backups',

          createElement(Diagram.Waypoint, {
            guide: 'storage-backup-rail',
            target: 'external-ssd',
            anchor: 'right',
            gap: 18,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'storage-backup-rail',
            target: 'longhorn',
            anchor: 'bottom',
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'proxmox',
            to: 'k3s-master',
            layer: 'background',
            exitSide: 'right',
            entrySide: 'left',
            entryGap: 0,
            stubDistance: 12,
          },

          createElement(Diagram.Waypoint, {
            guide: 'left-cluster-handoff-rail',
            target: 'proxmox',
            anchor: 'right',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'left-cluster-handoff-rail',
            target: 'k3s-master',
            anchor: 'left',
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'metallb',
            to: 'gateway',
            layer: 'background',
            labelSide: 'above',
            labelDy: -31,
            labelFrame: true,
          },
          'External IPs',
        ),
        createElement(Diagram.Arrow, {
          from: 'gateway',
          to: 'istio',
          layer: 'background',
          channel: 'mtls',
          route: 'straight',
          direction: 'both',
          exitSide: 'bottom',
          entrySide: 'top',
          entryGap: 0,
          entryOffset: -96,
        }),
        createElement(Diagram.Arrow, {
          from: 'k3s-master',
          to: 'istio',
          layer: 'background',
          channel: 'mtls',
          route: 'straight',
          exitSide: 'right',
          entrySide: 'left',
          entryGap: 0,
        }),
        createElement(
          Diagram.Arrow,
          {
            from: 'cert-manager',
            to: 'gateway',
            layer: 'background',
            channel: 'certificates',
            labelT: 0.42,
            labelSide: 'below',
            labelOffset: 58,
            labelDx: 252,
            lineStyle: 'dashed',
            route: 'straight',
            exitSide: 'left',
            entrySide: 'right',
            entryGap: 0,
            labelFrame: true,
            labelLineGap: 1,
          },

          createElement(Diagram.Line, null, "Let's Encrypt"),
          createElement(Diagram.Line, null, 'certificates'),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'authentik',
            to: 'istio',
            layer: 'background',
            channel: 'auth',
            exitSide: 'left',
            entrySide: 'right',
            entryGap: 0,
            entryOffset: -2,
            labelSide: 'right',
            labelOffset: 22,
            labelDy: -8,
            labelFrame: true,
          },

          createElement(Diagram.Waypoint, {
            guide: 'service-control-entry-rail',
            target: 'authentik',
            anchor: 'left',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'service-control-entry-rail',
            target: 'istio',
            anchor: 'right',
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'argocd',
            to: 'istio',
            layer: 'background',
            channel: 'deploy',
            exitSide: 'left',
            entrySide: 'right',
            entryGap: 0,
            labelSide: 'right',
            labelOffset: 24,
            labelDy: 10,
            labelFrame: true,
          },

          createElement(Diagram.Waypoint, {
            guide: 'service-control-entry-rail',
            target: 'argocd',
            anchor: 'left',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'service-control-entry-rail',
            target: 'istio',
            anchor: 'right',
            dy: 16,
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'git-repo',
            to: 'argocd',
            layer: 'background',
            channel: 'gitops',
            lineStyle: 'dashed',
            exitSide: 'left',
            entrySide: 'right',
            labelSide: 'above',
            labelOffset: 64,
            labelDx: -50,
            labelSegment: 0,
            labelAlign: 'middle',
            labelLineGap: 1,
          },

          createElement(Diagram.Line, null, 'Continuous deployment'),
          createElement(Diagram.Line, null, 'requests'),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'longhorn',
            to: 'istio',
            layer: 'background',
            channel: 'storage',
            exitSide: 'top',
            entrySide: 'bottom',
            entryOffset: -60,
            entryGap: 0,
          },

          createElement(Diagram.Waypoint, {
            guide: 'storage-mesh-rail',
            target: 'longhorn',
            anchor: 'top',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'storage-mesh-rail',
            target: 'istio',
            anchor: 'bottom',
            dx: -60,
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'grafana',
            to: 'observability-bus',
            layer: 'background',
            channel: 'observability',
            exitSide: 'top',
            entrySide: 'left',
            headless: true,
          },

          createElement(Diagram.Waypoint, {
            guide: 'observability-header-rail',
            target: 'grafana',
            anchor: 'top',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-header-rail',
            target: 'observability-bus',
            anchor: 'center',
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'victoria-metrics',
            to: 'observability-bus',
            layer: 'background',
            channel: 'observability',
            exitSide: 'top',
            entrySide: 'right',
            headless: true,
          },

          createElement(Diagram.Waypoint, {
            guide: 'observability-header-rail',
            target: 'victoria-metrics',
            anchor: 'top',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-header-rail',
            target: 'observability-bus',
            anchor: 'center',
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'victoria-logs',
            to: 'observability-bus',
            layer: 'background',
            channel: 'observability',
            exitSide: 'top',
            entrySide: 'left',
            headless: true,
          },

          createElement(Diagram.Waypoint, {
            guide: 'observability-bottom-row-rail',
            target: 'victoria-logs',
            anchor: 'top',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-bottom-row-rail',
            target: 'monitoring',
            anchor: 'center',
            dx: -6,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-branch-rail',
            target: 'monitoring',
            anchor: 'top',
            dy: 12,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-header-rail',
            target: 'observability-bus',
            anchor: 'center',
          }),
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'jaeger',
            to: 'observability-bus',
            layer: 'background',
            channel: 'observability',
            exitSide: 'top',
            entrySide: 'right',
            headless: true,
          },

          createElement(Diagram.Waypoint, {
            guide: 'observability-bottom-row-rail',
            target: 'jaeger',
            anchor: 'top',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-bottom-row-rail',
            target: 'monitoring',
            anchor: 'center',
            dx: -6,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-branch-rail',
            target: 'monitoring',
            anchor: 'top',
            dy: 12,
          }),
          createElement(Diagram.Waypoint, {
            guide: 'observability-header-rail',
            target: 'observability-bus',
            anchor: 'center',
          }),
        ),
        createElement(Diagram.Arrow, {
          from: 'observability-bus',
          to: 'istio',
          layer: 'background',
          channel: 'observability',
          exitSide: 'top',
          entrySide: 'bottom',
          entryGap: 0,
        }),
        createElement(
          Diagram.Arrow,
          {
            from: 'gpu-scheduling',
            to: 'istio',
            layer: 'background',
            channel: 'gpu',
            exitSide: 'top',
            entrySide: 'bottom',
            entryOffset: 60,
            entryGap: 0,
          },

          createElement(Diagram.Waypoint, {
            guide: 'gpu-top-rail',
            target: 'gpu-scheduling',
            anchor: 'top',
          }),
          createElement(Diagram.Waypoint, {
            guide: 'gpu-top-rail',
            target: 'istio',
            anchor: 'bottom',
            dx: 60,
          }),
        ),
      ],
    }),
  );

  for (const label of [
    'Homelab K3s reference',
    'Cloudflare',
    'Public Internet',
    'Fritzbox Router',
    'Dell Laptop',
    'Proxmox VE',
    'K3s Kubernetes Cluster',
    'Service Mesh',
    'Istio Service Mesh',
    'Cert-Manager',
    'Authentik',
    'ArgoCD',
    'Longhorn',
    'Monitoring',
    'GPU Scheduling',
    'Git Repo',
    'Cloudflare Tunnel',
    'Continuous deployment',
    'Manages',
    'Authentication',
    'for services',
    'in mesh',
    'Deploys applications',
  ]) {
    assert.match(markup, new RegExp(escapeRegExp(label)));
  }

  assert.match(markup, /data-diagram-group="cluster"/);
  assert.match(markup, /data-diagram-group-texture="cluster:hatch"/);
  assert.match(markup, /data-diagram-style-preset="sketch"/);
  assert.match(markup, /\[--dgm-tone-blue-stroke:rgba\(17,24,39,0\.66\)\]/);
  const viewBox = svgViewBox(markup);
  const paper = renderedRect(markup, 'data-diagram-paper', 'graph');
  assert.deepEqual(
    paper,
    viewBox,
    'exported homelab reference should render a stable graph paper background covering the whole viewBox',
  );
  assert.match(markup, /data-diagram-paper-fill="background"/);
  assert.match(markup, /data-diagram-node-stack="proxmox-vm:3"/);
  assert.match(markup, /data-diagram-node-caption="router"/);
  const proxmoxGroup = renderedRect(markup, 'data-diagram-group', 'proxmox');
  const proxmoxBand = renderedRect(
    markup,
    'data-diagram-group-title-band',
    'proxmox',
  );
  const proxmoxVm = renderedRect(markup, 'data-diagram-node', 'proxmox-vm');
  const proxmoxBackVm = renderedRect(
    markup,
    'data-diagram-node-stack',
    'proxmox-vm:3',
  );
  assert.equal(proxmoxVm.x - proxmoxBackVm.x, 45);
  assert.equal(proxmoxVm.y - proxmoxBackVm.y, 30);
  assert.equal(proxmoxBackVm.w - proxmoxVm.w, 36);
  assert.equal(proxmoxBackVm.h - proxmoxVm.h, 24);
  assert.ok(
    proxmoxBackVm.x >= proxmoxGroup.x &&
      proxmoxVm.x + proxmoxVm.w <= proxmoxGroup.x + proxmoxGroup.w,
    'Proxmox VM stack should stay inside the hypervisor group horizontally',
  );
  assert.ok(
    proxmoxBackVm.y >= proxmoxBand.y + proxmoxBand.h,
    'Proxmox back VM cards should sit below the reserved group title gutter',
  );
  assert.match(
    markup,
    /<path data-diagram-node="router" data-diagram-node-tone="slate" data-diagram-appliance-body="router"/,
    'exported reference should model the Fritzbox as a physical router appliance',
  );
  assert.match(markup, /data-diagram-appliance-antenna="router"/);
  assert.match(markup, /data-diagram-appliance-port="router:4"/);
  assert.doesNotMatch(
    markup,
    /<circle data-diagram-junction="observability-bus"/,
    'exported reference should keep the observability bundle junction hidden so it does not draw over the Monitoring title',
  );
  assert.match(
    markup,
    /data-diagram-edge="observability-bus-&gt;istio"/,
    'exported reference should still route from the hidden observability bundle junction',
  );
  assert.match(
    markup,
    /<rect data-diagram-node="cloudflare-tunnel" data-diagram-connector="cloudflare-tunnel" data-diagram-node-tone="blue"/,
    'exported reference should model the Cloudflare tunnel as a first-class inline connector',
  );
  assert.match(
    markup,
    /data-diagram-edge="public-internet-&gt;cloudflare-tunnel"[^>]*data-diagram-edge-channel="tunnel"[^>]*data-diagram-edge-direction="none"[^>]*stroke-width="3"/,
    'exported reference should route public internet into the tunnel connector with a headless wire',
  );
  assert.match(
    markup,
    /data-diagram-edge="cloudflare-tunnel-&gt;gateway"[^>]*data-diagram-edge-channel="tunnel"[^>]*data-diagram-edge-direction="forward"[^>]*stroke-width="3"/,
    'exported reference should route the tunnel connector into the ingress gateway as a directed flow',
  );
  assert.match(
    markup,
    /data-diagram-edge="victoria-metrics-&gt;observability-bus"[^>]*data-diagram-edge-direction="none"[^>]*data-diagram-edge-layer="background"/,
    'exported reference should feed metrics into the observability junction as a headless branch',
  );
  assert.match(
    markup,
    /data-diagram-edge="observability-bus-&gt;istio"[^>]*data-diagram-edge-layer="background"/,
    'exported reference should route one observability trunk from the junction into Istio',
  );
  assert.match(
    markup,
    /data-diagram-annotation="cert-manager:right"[^>]*data-diagram-annotation-target="cert-manager"[^>]*data-diagram-annotation-anchor="right"[^>]*data-diagram-annotation-guide="right-callout-lane"/,
  );
  assert.match(
    markup,
    /data-diagram-annotation-leader="cert-manager:right"[^>]*data-diagram-annotation-leader-target="cert-manager"[^>]*data-diagram-annotation-leader-anchor="right"[^>]*data-diagram-annotation-leader-route="elbow"/,
  );
  assert.match(
    markup,
    /data-diagram-annotation="authentik:right"[^>]*data-diagram-annotation-target="authentik"[^>]*data-diagram-annotation-anchor="right"[^>]*data-diagram-annotation-guide="right-callout-lane"/,
  );
  assert.match(
    markup,
    /data-diagram-annotation-leader="authentik:right"[^>]*data-diagram-annotation-leader-target="authentik"[^>]*data-diagram-annotation-leader-anchor="right"[^>]*data-diagram-annotation-leader-route="elbow"/,
  );
  assert.match(
    markup,
    /data-diagram-annotation="argocd:bottom"[^>]*data-diagram-annotation-target="argocd"[^>]*data-diagram-annotation-anchor="bottom"/,
    'exported reference should keep the ArgoCD deployment copy in a local band under ArgoCD',
  );
  assert.doesNotMatch(
    markup,
    /data-diagram-annotation="argocd:right"/,
    'exported reference should not push the ArgoCD deployment copy into the far-right callout lane',
  );
  assert.doesNotMatch(
    markup,
    /data-diagram-annotation-leader="argocd:bottom"/,
    'local ArgoCD deployment copy should not add a right-side annotation leader',
  );
  assert.match(
    markup,
    /data-diagram-edge-label="git-repo-&gt;argocd"[^>]*data-diagram-edge-label-segment="0"/,
    'exported reference should attach the GitOps sync copy to the Git Repo -> ArgoCD edge route',
  );
  for (const id of ['cert-manager:right', 'authentik:right', 'argocd:bottom']) {
    assert.match(
      markup,
      new RegExp(
        `data-diagram-annotation="${escapeRegExp(
          id,
        )}"[^>]*data-diagram-annotation-line-gap="1"[^>]*font-size="10"`,
      ),
      `${id} should use compact line spacing for dense right-side callout copy`,
    );
  }
  assert.match(markup, /data-diagram-edge-channel="mtls"[^>]*marker-start=/);
  assert.doesNotMatch(
    markup,
    /data-diagram-edge-badge="public-internet-&gt;cluster:tunnel"/,
  );
  assert.match(markup, /data-diagram-edge-label-frame="metallb-&gt;gateway"/);
  assert.match(
    markup,
    /data-diagram-edge-label-frame="cert-manager-&gt;gateway"[^>]*data-diagram-edge-label-line-gap="1"[^>]*height="30.85"/,
    'exported reference should use a compact measured frame for the multiline certificate label',
  );
  assert.match(
    markup,
    /data-diagram-edge-label="cert-manager-&gt;gateway"[^>]*data-diagram-edge-label-line-gap="1"[^>]*font-size="10"[\s\S]*<tspan[^>]*>Let&#x27;s Encrypt<\/tspan>[\s\S]*<tspan[^>]*dy="11">certificates<\/tspan>/,
    'exported reference should split the certificate copy into compact multiline edge text',
  );
  assert.match(
    markup,
    /data-diagram-node-item="laptop:2"[^>]*data-diagram-node-body-font-size="10"[^>]*data-diagram-node-body-line-gap="2"[\s\S]*<text[^>]*font-size="10"[\s\S]*NVIDIA RTX 3050 4GB GPU/,
    'exported reference should render the laptop hardware inventory with compact body typography',
  );
  assert.match(
    markup,
    /data-diagram-node-description="gpu-workflow"[^>]*data-diagram-node-body-font-size="10"[^>]*data-diagram-node-body-line-gap="2"[^>]*font-size="10"[\s\S]*NVIDIA RTX 3050/,
    'exported reference should render the GPU workflow description with compact body typography',
  );

  const edgePaths = [
    ...markup.matchAll(/<path data-diagram-edge="[^"]+"[^>]*\sd="([^"]+)"/g),
  ].map(firstCapture);
  assert.equal(edgePaths.length, 24);

  const observabilityTrunkIndex = markup.indexOf(
    'data-diagram-edge="observability-bus-&gt;istio"',
  );
  const istioNodeIndex = markup.indexOf('data-diagram-node="istio"');
  assert.notEqual(observabilityTrunkIndex, -1);
  assert.notEqual(istioNodeIndex, -1);
  assert.ok(
    observabilityTrunkIndex < istioNodeIndex,
    'exported reference should draw bundled observability wiring behind the Istio service mesh node',
  );

  const publicInternet = renderedRect(
    markup,
    'data-diagram-node',
    'public-internet',
  );
  const cloudflareTunnel = renderedRect(
    markup,
    'data-diagram-node',
    'cloudflare-tunnel',
  );
  const cluster = renderedRect(markup, 'data-diagram-group', 'cluster');
  const ingress = renderedRect(markup, 'data-diagram-group', 'ingress');
  const k3sVms = renderedRect(markup, 'data-diagram-group', 'k3s-vms');
  const mesh = renderedRect(markup, 'data-diagram-group', 'mesh');
  const certificates = renderedRect(
    markup,
    'data-diagram-group',
    'certificates',
  );
  const storage = renderedRect(markup, 'data-diagram-group', 'storage');
  const monitoring = renderedRect(markup, 'data-diagram-group', 'monitoring');
  const adguard = renderedRect(markup, 'data-diagram-node', 'adguard');
  const routerBodyPath = renderedPathD(
    markup,
    'data-diagram-appliance-body',
    'router',
  );
  const metallb = renderedRect(markup, 'data-diagram-node', 'metallb');
  const k3sMaster = renderedRect(markup, 'data-diagram-node', 'k3s-master');
  const gateway = renderedRect(markup, 'data-diagram-node', 'gateway');
  const istio = renderedRect(markup, 'data-diagram-node', 'istio');
  const certManager = renderedRect(markup, 'data-diagram-node', 'cert-manager');
  const authentik = renderedRect(markup, 'data-diagram-node', 'authentik');
  const argocd = renderedRect(markup, 'data-diagram-node', 'argocd');
  const gitRepo = renderedRect(markup, 'data-diagram-node', 'git-repo');
  const gitRepoLabel = renderedTextPoint(
    markup,
    'data-diagram-marker-label',
    'git-repo',
  );
  const longhorn = renderedRect(markup, 'data-diagram-node', 'longhorn');
  const grafana = renderedRect(markup, 'data-diagram-node', 'grafana');
  const victoriaMetrics = renderedRect(
    markup,
    'data-diagram-node',
    'victoria-metrics',
  );
  const victoriaLogs = renderedRect(
    markup,
    'data-diagram-node',
    'victoria-logs',
  );
  const jaeger = renderedRect(markup, 'data-diagram-node', 'jaeger');
  const observabilityTrunkPath = renderedEdgePath(
    markup,
    'observability-bus->istio',
  );
  const observabilityBusStart = itemAt(pathPoints(observabilityTrunkPath), 0);
  const externalSsd = renderedRect(markup, 'data-diagram-node', 'external-ssd');
  const proxmox = renderedRect(markup, 'data-diagram-group', 'proxmox');
  const laptop = renderedRect(markup, 'data-diagram-node', 'laptop');
  const gpuScheduling = renderedRect(
    markup,
    'data-diagram-group',
    'gpu-scheduling',
  );
  const gpuWorkflow = renderedRect(markup, 'data-diagram-node', 'gpu-workflow');
  const storageLabel = edgeLabelPoint(
    markup,
    'Distributed Storage &amp; Backups',
  );
  const externalIpsLabel = edgeLabelPoint(markup, 'External IPs');
  const externalIpsLabelFrame = renderedRect(
    markup,
    'data-diagram-edge-label-frame',
    'metallb-&gt;gateway',
  );
  const certLabel = edgeLabelPoint(markup, 'Let&#x27;s Encrypt');
  const certLabelFrame = renderedRect(
    markup,
    'data-diagram-edge-label-frame',
    'cert-manager-&gt;gateway',
  );
  const certManagerToGatewayPath = renderedEdgePath(
    markup,
    'cert-manager->gateway',
  );
  const certManagerToGatewayPoints = pathPoints(certManagerToGatewayPath);
  const laptopFirstItem = renderedGroupTranslate(
    markup,
    'data-diagram-node-item',
    'laptop:0',
  );
  const laptopSecondItem = renderedGroupTranslate(
    markup,
    'data-diagram-node-item',
    'laptop:1',
  );
  const storageMeshRailY = Math.round((storage.y - 36) / 4) * 4;
  const clusterLabel = renderedTextPoint(
    markup,
    'data-diagram-group-label',
    'cluster',
  );
  const ingressLabel = renderedTextPoint(
    markup,
    'data-diagram-group-label',
    'ingress',
  );
  const monitoringLabel = renderedTextPoint(
    markup,
    'data-diagram-group-label',
    'monitoring',
  );
  const titleBands = [
    {
      id: 'cluster',
      band: renderedRect(markup, 'data-diagram-group-title-band', 'cluster'),
      child: ingress,
    },
    {
      id: 'ingress',
      band: renderedRect(markup, 'data-diagram-group-title-band', 'ingress'),
      child: metallb,
    },
    {
      id: 'k3s-vms',
      band: renderedRect(markup, 'data-diagram-group-title-band', 'k3s-vms'),
      child: k3sMaster,
    },
    {
      id: 'mesh',
      band: renderedRect(markup, 'data-diagram-group-title-band', 'mesh'),
      child: istio,
    },
    {
      id: 'certificates',
      band: renderedRect(
        markup,
        'data-diagram-group-title-band',
        'certificates',
      ),
      child: certManager,
    },
    {
      id: 'storage',
      band: renderedRect(markup, 'data-diagram-group-title-band', 'storage'),
      child: longhorn,
    },
    {
      id: 'monitoring',
      band: renderedRect(markup, 'data-diagram-group-title-band', 'monitoring'),
      child: grafana,
    },
    {
      id: 'gpu-scheduling',
      band: renderedRect(
        markup,
        'data-diagram-group-title-band',
        'gpu-scheduling',
      ),
      child: gpuWorkflow,
    },
    {
      id: 'proxmox',
      band: renderedRect(markup, 'data-diagram-group-title-band', 'proxmox'),
      child: renderedRect(markup, 'data-diagram-node', 'proxmox-vm'),
    },
  ];

  assert.match(
    markup,
    /data-diagram-node-item="gpu-workflow:1"[\s\S]*Automatic GPU Scheduling/,
    'exported reference should keep GPU scheduling details inside the GPU workflow card',
  );
  assert.ok(
    rectContains(gpuScheduling, gpuWorkflow),
    `exported GPU Scheduling group should contain the GPU workflow card, got group=${JSON.stringify(
      gpuScheduling,
    )} workflow=${JSON.stringify(gpuWorkflow)}`,
  );

  assert.match(
    markup,
    /<g data-diagram-marker="git-repo"[\s\S]*data-diagram-node-icon="git"/,
    'exported reference should model Git Repo as an iconographic marker, not a full service card',
  );
  assert.equal(
    gitRepo.w,
    72,
    'exported Git Repo marker should use compact marker bounds',
  );
  assert.ok(
    gitRepoLabel.y > gitRepo.y + gitRepo.h / 2,
    `exported Git Repo marker label should sit below its icon, got label=${JSON.stringify(
      gitRepoLabel,
    )} marker=${JSON.stringify(gitRepo)}`,
  );

  for (const { id, band, child } of titleBands) {
    assert.ok(
      child.y >= band.y + band.h,
      `${id} title band should reserve space above child content, got band=${JSON.stringify(
        band,
      )} child=${JSON.stringify(child)}`,
    );
    assert.match(
      markup,
      new RegExp(`data-diagram-group-title-separator="${id}"`),
      `${id} title band should include a visible separator`,
    );
  }

  const certNote = renderedTextPoint(
    markup,
    'data-diagram-annotation',
    'cert-manager:right',
  );
  const authentikNote = renderedTextPoint(
    markup,
    'data-diagram-annotation',
    'authentik:right',
  );
  const certNoteLines = renderedTextLines(
    markup,
    'data-diagram-annotation',
    'cert-manager:right',
  );
  const authentikNoteLines = renderedTextLines(
    markup,
    'data-diagram-annotation',
    'authentik:right',
  );
  assert.deepEqual(certNoteLines, ['Manages', "Let's Encrypt", 'certificates']);
  assert.deepEqual(
    authentikNoteLines,
    ['Authentication', 'for services', 'in mesh'],
    'Authentik explanatory copy should render as a compact right-side label band',
  );
  const rightCalloutX = certNote.x;
  const rightCalloutGap = rightCalloutX - (gitRepo.x + gitRepo.w);
  assert.ok(
    rightCalloutGap >= 10 && rightCalloutGap <= 18,
    `right-side callout lane should sit outside the Git Repo marker lane, got gap=${rightCalloutGap} lane=${rightCalloutX} gitRepo=${JSON.stringify(
      gitRepo,
    )}`,
  );
  const certNoteRect = multilineStartTextRect(certNote, certNoteLines);
  const authentikNoteRect = multilineStartTextRect(
    authentikNote,
    authentikNoteLines,
  );
  const maxRightCalloutWidth = Math.max(certNoteRect.w, authentikNoteRect.w);
  assert.ok(
    maxRightCalloutWidth <= 84,
    `right-side label bands should stay compact, got width=${maxRightCalloutWidth} cert=${JSON.stringify(
      certNoteRect,
    )} authentik=${JSON.stringify(authentikNoteRect)}`,
  );
  const argocdNote = renderedTextPoint(
    markup,
    'data-diagram-annotation',
    'argocd:bottom',
  );

  for (const [id, note] of [
    ['cert-manager:right', certNote],
    ['authentik:right', authentikNote],
  ] as const) {
    assert.equal(
      note.x,
      rightCalloutX,
      `${id} should align to the shared right-side callout lane`,
    );
    assert.ok(
      note.x > cluster.x + cluster.w,
      `${id} should render outside the cluster frame, got note=${JSON.stringify(
        note,
      )} cluster=${JSON.stringify(cluster)}`,
    );
  }
  assert.ok(
    argocdNote.x >= argocd.x && argocdNote.x < argocd.x + argocd.w,
    `ArgoCD deployment note should start inside the ArgoCD card column, got note=${JSON.stringify(
      argocdNote,
    )} argocd=${JSON.stringify(argocd)}`,
  );
  assert.ok(
    argocdNote.x < gitRepo.x && argocdNote.x < rightCalloutX,
    `ArgoCD deployment note should stay in a local band left of Git Repo and the callout lane, got note=${JSON.stringify(
      argocdNote,
    )} gitRepo=${JSON.stringify(gitRepo)} rightCalloutX=${rightCalloutX}`,
  );
  assert.ok(
    argocdNote.y > argocd.y + argocd.h,
    `ArgoCD deployment note should sit below ArgoCD, got note=${JSON.stringify(
      argocdNote,
    )} argocd=${JSON.stringify(argocd)}`,
  );

  const gitOpsLabel = renderedEdgeLabelPoint(markup, 'git-repo->argocd');
  const gitOpsLabelRect = multilineEdgeLabelRect(
    gitOpsLabel,
    ['Continuous deployment', 'requests'],
    1,
  );
  const rightSideTextBands = [
    ['cert-manager:right', certNoteRect],
    ['authentik:right', authentikNoteRect],
    ['git-repo->argocd label', gitOpsLabelRect],
    [
      'git-repo marker label',
      labelPointRect({ label: 'Git Repo', ...gitRepoLabel }),
    ],

    [
      'argocd:bottom',
      multilineStartTextRect(argocdNote, ['Deploys applications', 'into k3s']),
    ],
  ] as const;
  for (let i = 0; i < rightSideTextBands.length; i++) {
    const [aId, aRect] = itemAt(rightSideTextBands, i);
    for (let j = i + 1; j < rightSideTextBands.length; j++) {
      const [bId, bRect] = itemAt(rightSideTextBands, j);
      assert.ok(
        !rectsOverlap(aRect, bRect),
        `right-side text bands should not overlap, got ${aId}=${JSON.stringify(
          aRect,
        )} ${bId}=${JSON.stringify(bRect)}`,
      );
    }
  }
  const gitOpsPathPoints = pathPoints(
    renderedEdgePath(markup, 'git-repo->argocd'),
  );
  const gitOpsLabelSegment = {
    from: itemAt(gitOpsPathPoints, 0),
    to: itemAt(gitOpsPathPoints, 1),
  };
  assert.match(
    markup,
    /data-diagram-edge="git-repo-&gt;argocd"[^>]*data-diagram-edge-channel="gitops"[^>]*data-diagram-edge-line-style="dashed"/,
    'Git Repo -> ArgoCD should render as a dashed GitOps handoff',
  );
  assert.match(
    markup,
    /data-diagram-edge-label="git-repo-&gt;argocd"[^>]*data-diagram-edge-label-segment="0"[^>]*data-diagram-edge-label-line-gap="1"/,
    'GitOps deployment label should be bound to the local route segment with compact line spacing',
  );
  assert.match(
    markup,
    /data-diagram-edge-label="git-repo-&gt;argocd"[^>]*data-diagram-edge-label-line-gap="1"[\s\S]*<tspan[^>]*>Continuous deployment<\/tspan>[\s\S]*<tspan[^>]*dy="11">requests<\/tspan>/,
    'GitOps deployment label should render as compact two-line edge text',
  );
  assert.equal(
    gitOpsLabel.x,
    (gitOpsLabelSegment.from.x + gitOpsLabelSegment.to.x) / 2 - 50,
    'GitOps edge label should sit left of the selected local handoff segment midpoint',
  );
  assert.equal(
    gitOpsLabel.y,
    (gitOpsLabelSegment.from.y + gitOpsLabelSegment.to.y) / 2 - 64,
    'GitOps edge label should honor labelSide="above" and labelOffset on the selected segment',
  );
  assert.ok(
    gitOpsLabel.y < Math.min(argocd.y, gitRepo.y),
    `GitOps edge label should live above the GitOps cards, got label=${JSON.stringify(
      gitOpsLabel,
    )} argocd=${JSON.stringify(argocd)} gitRepo=${JSON.stringify(gitRepo)}`,
  );
  assert.ok(
    gitOpsLabel.y + 14 < gitRepo.y,
    `GitOps edge label should leave a visible gap above the compact Git Repo marker, got label=${JSON.stringify(
      gitOpsLabel,
    )} gitRepo=${JSON.stringify(gitRepo)}`,
  );
  assert.ok(
    gitOpsLabelRect.x + gitOpsLabelRect.w < rightCalloutX,
    `GitOps edge label should clear the right-side callout text lane, got label=${JSON.stringify(
      gitOpsLabelRect,
    )} rightCalloutX=${rightCalloutX}`,
  );
  assert.ok(
    rightCalloutX - (gitOpsLabelRect.x + gitOpsLabelRect.w) >= 48,
    `GitOps edge label should leave a readable gutter before the callout lane, got label=${JSON.stringify(
      gitOpsLabelRect,
    )} rightCalloutX=${rightCalloutX}`,
  );
  assert.ok(
    gitOpsLabelRect.x + gitOpsLabelRect.w <= gitRepo.x - 12,
    `GitOps edge label should clear the Git Repo marker lane horizontally, got label=${JSON.stringify(
      gitOpsLabelRect,
    )} gitRepo=${JSON.stringify(gitRepo)}`,
  );
  assert.ok(
    gitOpsLabelRect.y + gitOpsLabelRect.h <= gitRepo.y - 12,
    `GitOps edge label should stay above the Git Repo marker with a visible lane gap, got label=${JSON.stringify(
      gitOpsLabelRect,
    )} gitRepo=${JSON.stringify(gitRepo)}`,
  );
  for (const [id, rect] of [
    ['Authentik', authentik],
    ['ArgoCD', argocd],
    ['Git Repo', gitRepo],
  ] as const) {
    assert.ok(
      !rectsOverlap(gitOpsLabelRect, rect),
      `GitOps edge label should clear ${id}, got label=${JSON.stringify(
        gitOpsLabelRect,
      )} ${id}=${JSON.stringify(rect)}`,
    );
  }
  const gitOpsSegments = pathSegments(
    renderedEdgePath(markup, 'git-repo->argocd'),
  );
  assert.equal(
    gitOpsSegments.length,
    1,
    `Git Repo -> ArgoCD should be one short local handoff segment, got ${JSON.stringify(
      gitOpsSegments,
    )}`,
  );
  assert.equal(
    itemAt(gitOpsSegments, 0).y1,
    argocd.y + argocd.h / 2,
    `Git Repo -> ArgoCD should stay horizontally aligned to ArgoCD center, got ${JSON.stringify(
      gitOpsSegments[0],
    )}`,
  );
  assert.equal(
    itemAt(gitOpsSegments, 0).x1,
    argocd.x + argocd.w + 10,
    `Git Repo -> ArgoCD should land just outside ArgoCD right edge, got ${JSON.stringify(
      gitOpsSegments[0],
    )} argocd=${JSON.stringify(argocd)}`,
  );
  assert.equal(
    itemAt(gitOpsSegments, 0).x2,
    gitRepo.x,
    `Git Repo -> ArgoCD should leave from the compact Git Repo left edge, got ${JSON.stringify(
      gitOpsSegments[0],
    )} gitRepo=${JSON.stringify(gitRepo)}`,
  );

  const rightCalloutLeaderSegments: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }[] = [];
  for (const [id, targetId, target, note] of [
    ['cert-manager:right', 'cert-manager', certManager, certNote],
    ['authentik:right', 'authentik', authentik, authentikNote],
  ] as const) {
    const leader = renderedAnnotationLeaderPath(markup, id, targetId);
    rightCalloutLeaderSegments.push(...leader.segments);
    assert.deepEqual(
      leader.points,
      [
        { x: target.x + target.w, y: target.y + target.h / 2 },
        { x: target.x + target.w, y: note.y },
        { x: rightCalloutX - 6, y: note.y },
      ],

      `${id} leader should leave the target edge vertically before crossing to the callout lane`,
    );
  }

  for (const [rectId, rect] of [
    ['cert-manager', certManager],
    ['authentik', authentik],
    ['argocd', argocd],
    ['git-repo', gitRepo],
    ['git-repo marker label', itemAt(rightSideTextBands, 3)[1]],
    ['gitops label', gitOpsLabelRect],
  ] as const) {
    for (const segment of rightCalloutLeaderSegments) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `homelab elbow annotation leader should not cross ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }

  assert.ok(
    cluster.y > publicInternet.y + publicInternet.h,
    'exported reference should keep public internet above the cluster frame instead of colliding with it',
  );
  assert.ok(
    cloudflareTunnel.y >= publicInternet.y + publicInternet.h,
    `exported reference should place the tunnel connector below Public Internet, got tunnel=${JSON.stringify(
      cloudflareTunnel,
    )} public=${JSON.stringify(publicInternet)}`,
  );
  assert.ok(
    cloudflareTunnel.y + cloudflareTunnel.h <= cluster.y,
    `exported reference should place the tunnel connector above the cluster frame, got tunnel=${JSON.stringify(
      cloudflareTunnel,
    )} cluster=${JSON.stringify(cluster)}`,
  );
  const publicToTunnel = pathPoints(
    renderedEdgePath(markup, 'public-internet->cloudflare-tunnel'),
  );
  const tunnelToGatewayPath = renderedEdgePath(
    markup,
    'cloudflare-tunnel->gateway',
  );
  const tunnelToGateway = pathPoints(tunnelToGatewayPath);
  assert.equal(
    itemAt(publicToTunnel, -1).y,
    cloudflareTunnel.y,
    'exported reference should route the public internet wire into the tunnel connector top edge',
  );
  assert.equal(
    itemAt(tunnelToGateway, 0).y,
    cloudflareTunnel.y + cloudflareTunnel.h,
    'exported reference should route the gateway tunnel edge out of the connector bottom edge',
  );
  const clusterTitleBand = titleBands.find((band) => band.id === 'cluster');
  assert.ok(clusterTitleBand);
  const topCorridorLabelFrames = [
    ['External IPs', externalIpsLabelFrame],
  ] as const;
  for (let i = 0; i < topCorridorLabelFrames.length; i++) {
    const [aId, aRect] = itemAt(topCorridorLabelFrames, i);
    assert.ok(
      aRect.y + aRect.h <= gateway.y,
      `top ingress label ${aId} should stay above the gateway card, got label=${JSON.stringify(
        aRect,
      )} gateway=${JSON.stringify(gateway)}`,
    );
    assert.ok(
      aRect.y >= clusterTitleBand.band.y + clusterTitleBand.band.h,
      `top ingress label ${aId} should sit below the cluster title band, got label=${JSON.stringify(
        aRect,
      )} band=${JSON.stringify(clusterTitleBand.band)}`,
    );
    for (let j = i + 1; j < topCorridorLabelFrames.length; j++) {
      const [bId, bRect] = itemAt(topCorridorLabelFrames, j);
      assert.ok(
        !rectsOverlap(aRect, bRect),
        `top ingress labels should not overlap, got ${aId}=${JSON.stringify(
          aRect,
        )} ${bId}=${JSON.stringify(bRect)}`,
      );
    }
  }
  assert.ok(
    externalIpsLabel.y < gateway.y,
    `External IPs label should read in the ingress corridor above the gateway, got label=${JSON.stringify(
      externalIpsLabel,
    )} gateway=${JSON.stringify(gateway)}`,
  );
  assert.ok(
    certLabelFrame.y >=
      Math.max(gateway.y + gateway.h, certManager.y + certManager.h) + 6,
    `Let's Encrypt label frame should sit below the Gateway/Cert-Manager card row with a readable gap, got frame=${JSON.stringify(
      certLabelFrame,
    )} gateway=${JSON.stringify(gateway)} certManager=${JSON.stringify(
      certManager,
    )}`,
  );
  assert.ok(
    certLabelFrame.y + certLabelFrame.h <= authentik.y - 8,
    `Let's Encrypt label frame should stay above the Authentik row, got frame=${JSON.stringify(
      certLabelFrame,
    )} authentik=${JSON.stringify(authentik)}`,
  );
  assert.ok(
    certLabel.y > gateway.y + gateway.h,
    `Let's Encrypt label should read in the certificate band below the Gateway/Cert-Manager row, got label=${JSON.stringify(
      certLabel,
    )} gateway=${JSON.stringify(gateway)}`,
  );
  assert.equal(
    certManagerToGatewayPoints.length,
    2,
    `cert-manager -> gateway should render as a short local certificate handoff, got path=${certManagerToGatewayPath}`,
  );
  assert.deepEqual(
    certManagerToGatewayPoints[0],
    {
      x: certManager.x,
      y: Math.round((certManager.y + certManager.h / 2) / 4) * 4,
    },
    `cert-manager -> gateway should leave from the Cert-Manager left edge, got path=${certManagerToGatewayPath}`,
  );
  assert.deepEqual(
    certManagerToGatewayPoints[certManagerToGatewayPoints.length - 1],
    {
      x: gateway.x + gateway.w,
      y: Math.round((gateway.y + gateway.h / 2) / 4) * 4,
    },
    `cert-manager -> gateway should enter the Gateway right edge, got path=${certManagerToGatewayPath}`,
  );
  assert.ok(
    certManagerToGatewayPoints.every((point) => point.y > gateway.y),
    `cert-manager -> gateway should not loop through the upper control-plane rail, got path=${certManagerToGatewayPath}`,
  );
  assert.ok(
    ingressLabel.y > clusterLabel.y + 12,
    `exported reference should keep the ingress group label below the cluster title, got cluster=${JSON.stringify(
      clusterLabel,
    )} ingress=${JSON.stringify(ingressLabel)}`,
  );
  const monitoringBand = renderedRect(
    markup,
    'data-diagram-group-title-band',
    'monitoring',
  );
  const observabilityHeaderY = Math.round((monitoring.y + 12) / 4) * 4;
  assert.ok(
    observabilityBusStart.y >= monitoringBand.y &&
      observabilityBusStart.y < monitoringLabel.y - 8,
    `exported reference should keep the hidden observability route anchor in the Monitoring title band above the label text, got start=${JSON.stringify(
      observabilityBusStart,
    )} label=${JSON.stringify(monitoringLabel)} band=${JSON.stringify(
      monitoringBand,
    )}`,
  );
  assert.ok(
    observabilityHeaderY >= monitoringBand.y &&
      observabilityHeaderY < Math.min(grafana.y, monitoringLabel.y - 8),
    `exported reference should route the shared observability header corridor through the title band above card content and label text, got railY=${observabilityHeaderY} band=${JSON.stringify(
      monitoringBand,
    )} grafana=${JSON.stringify(grafana)} label=${JSON.stringify(
      monitoringLabel,
    )}`,
  );
  const observabilityBusRouteX = Math.round(observabilityBusStart.x / 4) * 4;
  const observabilityBranchX =
    Math.round((monitoring.x + monitoring.w / 2 - 6) / 4) * 4;
  const observabilityBottomRailY = Math.round((victoriaLogs.y - 28) / 4) * 4;
  assert.ok(
    observabilityBottomRailY > grafana.y + grafana.h &&
      observabilityBottomRailY < victoriaLogs.y,
    `exported reference should place the bottom observability rail in the gap between monitoring rows, got railY=${observabilityBottomRailY} top=${JSON.stringify(
      grafana,
    )} bottom=${JSON.stringify(victoriaLogs)}`,
  );
  const observabilityBranchEdges = [
    ['grafana->observability-bus', 'grafana', grafana, false],
    [
      'victoria-metrics->observability-bus',
      'victoria-metrics',
      victoriaMetrics,
      false,
    ],

    ['victoria-logs->observability-bus', 'victoria-logs', victoriaLogs, true],
    ['jaeger->observability-bus', 'jaeger', jaeger, true],
  ] as const;
  const monitoringCards = [
    ['grafana', grafana],
    ['victoria-metrics', victoriaMetrics],
    ['victoria-logs', victoriaLogs],
    ['jaeger', jaeger],
  ] as const;
  assert.equal(
    monitoring.y,
    Math.min(grafana.y, victoriaMetrics.y) - monitoringBand.h,
    'exported reference should vertically tighten the monitoring frame to the top card row plus the rendered title band',
  );
  assert.equal(
    monitoring.y + monitoring.h,
    Math.max(victoriaLogs.y + victoriaLogs.h, jaeger.y + jaeger.h) + 16,
    'exported reference should vertically tighten the monitoring frame to the bottom card row plus bottom padding',
  );
  for (const [
    edge,
    sourceId,
    source,
    usesBranchRail,
  ] of observabilityBranchEdges) {
    const path = renderedEdgePath(markup, edge);
    if (usesBranchRail) {
      const sourceRouteCenterX = Math.round((source.x + source.w / 2) / 4) * 4;
      assert.match(
        path,
        new RegExp(`Q ${sourceRouteCenterX} ${observabilityBottomRailY}`),
        `${edge} should rise from the bottom-row card onto the shared bottom-row rail, got ${path}`,
      );
      assert.match(
        path,
        new RegExp(`Q ${observabilityBranchX} ${observabilityBottomRailY}`),
        `${edge} should cross the bottom-row rail into the shared vertical branch rail, got ${path}`,
      );
      assert.match(
        path,
        new RegExp(`Q ${observabilityBranchX} ${observabilityHeaderY}`),
        `${edge} should climb the shared branch rail into the header corridor, got ${path}`,
      );
    } else {
      assert.match(
        path,
        new RegExp(`Q ${observabilityBusRouteX} ${observabilityHeaderY}`),
        `${edge} should converge on the shared monitoring header corridor before entering the junction, got ${path}`,
      );
      const sourceRouteCenterX = Math.round((source.x + source.w / 2) / 4) * 4;
      assert.match(
        path,
        new RegExp(`Q ${sourceRouteCenterX} ${observabilityHeaderY}`),
        `${edge} should leave the top-row card into the shared header corridor, got ${path}`,
      );
    }
    for (const segment of pathSegments(path)) {
      for (const [rectId, rect] of monitoringCards) {
        if (rectId === sourceId) continue;
        assert.ok(
          !segmentIntersectsRectInterior(segment, rect),
          `${edge} should not cross ${rectId} interior on the way to the observability junction, got segment=${JSON.stringify(
            segment,
          )} rect=${JSON.stringify(rect)}`,
        );
      }
      assert.ok(
        !segmentIntersectsRectInterior(segment, gpuScheduling),
        `${edge} should stay out of the GPU scheduling group, got segment=${JSON.stringify(
          segment,
        )} gpu=${JSON.stringify(gpuScheduling)}`,
      );
    }
  }
  for (const segment of pathSegments(observabilityTrunkPath)) {
    for (const [rectId, rect] of monitoringCards) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `observability trunk should leave the monitoring region without crossing ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
  const gpuPath = renderedEdgePath(markup, 'gpu-scheduling->istio');
  const gpuPathPoints = pathPoints(gpuPath);
  const gpuPathStart = itemAt(gpuPathPoints, 0);
  const gpuPathTarget = gpuPathPoints[gpuPathPoints.length - 1];
  assert.ok(gpuPathTarget);
  const gpuSourceRouteX =
    Math.round((gpuScheduling.x + gpuScheduling.w / 2) / 4) * 4;
  const gpuTopRailY = Math.round((monitoring.y - 58) / 4) * 4;
  assert.match(
    gpuPath,
    new RegExp(`Q ${gpuSourceRouteX} ${gpuTopRailY}`),
    `exported reference should lift the GPU edge into the top rail above monitoring, got ${gpuPath}`,
  );
  assert.equal(
    gpuPathStart.y,
    gpuScheduling.y,
    `exported GPU edge should leave the GPU Scheduling group boundary, not the inner workflow card, got path=${gpuPath} group=${JSON.stringify(
      gpuScheduling,
    )} workflow=${JSON.stringify(gpuWorkflow)}`,
  );
  assert.ok(
    gpuPathStart.y < gpuWorkflow.y,
    `exported GPU edge should start above the GPU workflow card, got path=${gpuPath} workflow=${JSON.stringify(
      gpuWorkflow,
    )}`,
  );
  assert.match(
    gpuPath,
    new RegExp(`Q ${gpuPathTarget.x} ${gpuTopRailY}`),
    `exported reference should carry the GPU edge across the top rail before entering Istio, got ${gpuPath}`,
  );
  assert.equal(
    gpuPathTarget.y,
    istio.y + istio.h,
    `GPU route should terminate on the Istio bottom boundary, got ${gpuPath}`,
  );
  for (const segment of pathSegments(gpuPath)) {
    assert.ok(
      !segmentIntersectsRectInterior(segment, monitoring),
      `GPU edge should route around the monitoring group interior, got segment=${JSON.stringify(
        segment,
      )} monitoring=${JSON.stringify(monitoring)}`,
    );
    for (const [rectId, rect] of monitoringCards) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `GPU edge should not cross ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
    assert.ok(
      !segmentIntersectsRectInterior(segment, gpuScheduling),
      `GPU edge should leave the GPU scheduling group from its boundary instead of crossing the group interior, got segment=${JSON.stringify(
        segment,
      )} gpu=${JSON.stringify(gpuScheduling)}`,
    );
  }
  assert.ok(
    !rectsOverlap(monitoring, gpuScheduling),
    `Monitoring and GPU Scheduling frames should be adjacent lower-right regions, got monitoring=${JSON.stringify(
      monitoring,
    )} gpu=${JSON.stringify(gpuScheduling)}`,
  );
  const lowerRightFrameGap = gpuScheduling.x - (monitoring.x + monitoring.w);
  assert.ok(
    lowerRightFrameGap >= 8,
    `Monitoring and GPU Scheduling frames should keep a readable lower-right gutter, got gap=${lowerRightFrameGap} monitoring=${JSON.stringify(
      monitoring,
    )} gpu=${JSON.stringify(gpuScheduling)}`,
  );
  const dnsPath = renderedEdgePath(markup, 'router->adguard');
  const dnsEdgeTag = markup.match(
    /<path data-diagram-edge="router-&gt;adguard"[^>]*>/,
  )?.[0];
  assert.ok(dnsEdgeTag, 'exported reference should render router->adguard');
  assert.doesNotMatch(
    dnsEdgeTag,
    /data-diagram-edge-channel="dns"/,
    'exported reference should render router -> AdGuard as a direct external arrow, not a DNS-channel infrastructure rail',
  );
  assert.doesNotMatch(
    dnsEdgeTag,
    /stroke-dasharray="6 6"/,
    'exported reference should avoid the DNS-channel dashed rail styling on router -> AdGuard',
  );
  assert.match(
    dnsEdgeTag,
    /data-diagram-edge-route="straight"/,
    'exported reference should use an explicit straight route for the router -> AdGuard external connection',
  );
  const dnsPoints = pathPoints(dnsPath);
  const adguardCenterY = adguard.y + adguard.h / 2;
  const routerRightEdgeX = Math.max(
    ...pathPoints(routerBodyPath).map((point) => point.x),
  );
  const adguardLeftEdgeX = Math.round(adguard.x / 4) * 4;
  assert.ok(
    itemAt(dnsPoints, 0).x >= routerRightEdgeX &&
      itemAt(dnsPoints, 0).x <= routerRightEdgeX + 8,
    `router -> AdGuard should leave just outside the router right edge, got ${dnsPath} routerBody=${routerBodyPath}`,
  );
  assert.ok(
    itemAt(dnsPoints, -1).x <= adguardLeftEdgeX &&
      itemAt(dnsPoints, -1).x >= adguardLeftEdgeX - 12,
    `router -> AdGuard should land just outside the AdGuard left edge, got ${dnsPath} adguard=${JSON.stringify(
      adguard,
    )}`,
  );
  assert.equal(
    itemAt(dnsPoints, -1).y,
    adguardCenterY,
    `router -> AdGuard should land on the AdGuard center-left anchor, got ${dnsPath}`,
  );
  assert.equal(
    dnsPoints.length,
    2,
    `router -> AdGuard should be a single direct segment, got ${dnsPath}`,
  );
  const tallDnsRailSegments = verticalSegments(dnsPath).filter(
    (segment) => segment.x < adguard.x && segment.y2 - segment.y1 > 40,
  );
  assert.equal(
    tallDnsRailSegments.length,
    0,
    `exported reference should not route router -> AdGuard through a tall vertical DNS rail, got ${dnsPath}`,
  );
  for (const segment of pathSegments(dnsPath)) {
    for (const [rectId, rect] of [
      ['proxmox', proxmox],
      ['cluster', cluster],
      ['laptop', laptop],
    ] as const) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `router -> AdGuard should stay outside ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
  const routerLaptopPath = renderedEdgePath(markup, 'router->laptop');
  const routerLaptopEdgeTag = markup.match(
    /<path data-diagram-edge="router-&gt;laptop"[^>]*>/,
  )?.[0];
  assert.ok(
    routerLaptopEdgeTag,
    'exported reference should render router->laptop as a physical hardware uplink',
  );
  assert.match(
    routerLaptopEdgeTag,
    /data-diagram-edge-route="straight"/,
    'router -> laptop should use an explicit compact straight hardware route',
  );
  const routerLaptopPoints = pathPoints(routerLaptopPath);
  assert.equal(
    routerLaptopPoints.length,
    2,
    `router -> laptop should be one compact segment, got ${routerLaptopPath}`,
  );
  assert.equal(
    itemAt(routerLaptopPoints, 0).x,
    itemAt(routerLaptopPoints, 1).x,
    `router -> laptop should read as a vertical hardware drop, got ${routerLaptopPath}`,
  );
  const routerBodyBottomY = Math.max(
    ...pathPoints(routerBodyPath).map((point) => point.y),
  );
  assert.ok(
    itemAt(routerLaptopPoints, 0).y > routerBodyBottomY,
    `router -> laptop should leave below the router appliance body, got ${routerLaptopPath} routerBody=${routerBodyPath}`,
  );
  assert.equal(
    itemAt(routerLaptopPoints, 1).y,
    laptop.y - 10,
    `router -> laptop should land just above the laptop hardware top edge, got ${routerLaptopPath}`,
  );
  for (const segment of pathSegments(routerLaptopPath)) {
    for (const [rectId, rect] of [
      ['proxmox', proxmox],
      ['cluster', cluster],
    ] as const) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `router -> laptop should stay outside ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
  const laptopStoragePath = renderedEdgePath(markup, 'laptop->external-ssd');
  const laptopStorageEdgeTag = markup.match(
    /<path data-diagram-edge="laptop-&gt;external-ssd"[^>]*>/,
  )?.[0];
  assert.ok(
    laptopStorageEdgeTag,
    'exported reference should render laptop->external-ssd as local hardware storage',
  );
  assert.match(
    laptopStorageEdgeTag,
    /data-diagram-edge-route="straight"/,
    'laptop -> external SSD should use an explicit compact straight hardware route',
  );
  const laptopStoragePoints = pathPoints(laptopStoragePath);
  assert.equal(
    laptopStoragePoints.length,
    2,
    `laptop -> external SSD should be one compact segment, got ${laptopStoragePath}`,
  );
  assert.ok(
    Math.abs(
      itemAt(laptopStoragePoints, 1).x - itemAt(laptopStoragePoints, 0).x,
    ) <= 120 &&
      Math.abs(
        itemAt(laptopStoragePoints, 1).y - itemAt(laptopStoragePoints, 0).y,
      ) <= 40,
    `laptop -> external SSD should stay in a tight local hardware corridor, got ${laptopStoragePath}`,
  );
  assert.equal(
    itemAt(laptopStoragePoints, 0).y,
    laptop.y + laptop.h,
    `laptop -> external SSD should leave the laptop bottom edge, got ${laptopStoragePath}`,
  );
  assert.ok(
    itemAt(laptopStoragePoints, 1).x <= externalSsd.x &&
      itemAt(laptopStoragePoints, 1).x >= externalSsd.x - 12,
    `laptop -> external SSD should land just outside the SSD left edge, got ${laptopStoragePath} externalSsd=${JSON.stringify(
      externalSsd,
    )}`,
  );
  assert.ok(
    itemAt(laptopStoragePoints, 0).y > proxmox.y + proxmox.h &&
      itemAt(laptopStoragePoints, 1).y > proxmox.y + proxmox.h,
    `laptop -> external SSD should run below the Proxmox frame, got ${laptopStoragePath} proxmox=${JSON.stringify(
      proxmox,
    )}`,
  );
  const proxmoxHandoffPath = renderedEdgePath(markup, 'proxmox->k3s-master');
  const proxmoxHandoffPoints = pathPoints(proxmoxHandoffPath);
  const handoffRailX = k3sVms.x - 2;
  const k3sMasterCenterY = k3sMaster.y + k3sMaster.h / 2;
  assert.ok(
    proxmoxHandoffPoints.length <= 6,
    `proxmox -> K3s should use one compact handoff rail instead of a multi-turn detour, got ${proxmoxHandoffPath}`,
  );
  assert.match(
    proxmoxHandoffPath,
    new RegExp(`Q ${handoffRailX} ${itemAt(proxmoxHandoffPoints, 0).y}`),
    `proxmox -> K3s should bend from Proxmox into the left-cluster handoff rail, got ${proxmoxHandoffPath}`,
  );
  assert.match(
    proxmoxHandoffPath,
    new RegExp(`Q ${handoffRailX} ${k3sMasterCenterY}`),
    `proxmox -> K3s should leave the handoff rail directly into the K3s master left edge, got ${proxmoxHandoffPath}`,
  );
  assert.equal(
    itemAt(proxmoxHandoffPoints, 0).x,
    proxmox.x + proxmox.w,
    `proxmox -> K3s should start on the Proxmox right boundary, got ${proxmoxHandoffPath}`,
  );
  assert.equal(
    proxmoxHandoffPoints[proxmoxHandoffPoints.length - 1]?.x,
    k3sMaster.x,
    `proxmox -> K3s should land on the K3s master left edge, got ${proxmoxHandoffPath}`,
  );
  const handoffRailSegments = verticalSegments(proxmoxHandoffPath).filter(
    (segment) => segment.x === handoffRailX,
  );
  assert.ok(
    handoffRailSegments.some(
      (segment) =>
        segment.y1 <= k3sMasterCenterY + 8 &&
        segment.y2 >= itemAt(proxmoxHandoffPoints, 0).y - 8,
    ),
    `proxmox -> K3s should carry the handoff on one vertical rail beside the K3s VMs group, got ${proxmoxHandoffPath}`,
  );
  for (const segment of pathSegments(proxmoxHandoffPath)) {
    for (const [rectId, rect] of [
      ['laptop', laptop],
      ['storage', storage],
      ['ingress', ingress],
      ['MetalLB', metallb],
    ] as const) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `proxmox -> K3s should stay outside ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
  const gatewayMeshPath = renderedEdgePath(markup, 'gateway->istio');
  const gatewayMeshEdgeTag = markup.match(
    /<path data-diagram-edge="gateway-&gt;istio"[^>]*>/,
  )?.[0];
  assert.ok(
    gatewayMeshEdgeTag,
    'exported reference should render the ingress gateway -> Istio service mesh downlink',
  );
  assert.match(
    gatewayMeshEdgeTag,
    /data-diagram-edge-channel="mtls"/,
    'Ingress gateway -> Istio should use the mTLS service-mesh channel',
  );
  assert.match(
    gatewayMeshEdgeTag,
    /data-diagram-edge-route="straight"/,
    'Ingress gateway -> Istio should be an explicit local straight downlink',
  );
  const gatewayMeshPoints = pathPoints(gatewayMeshPath);
  const gatewayCenterX = gateway.x + gateway.w / 2;
  assert.equal(
    gatewayMeshPoints.length,
    2,
    `Ingress gateway -> Istio should be a single short local segment, got ${gatewayMeshPath}`,
  );
  assert.equal(
    itemAt(gatewayMeshPoints, 0).x,
    gatewayCenterX,
    `Ingress gateway -> Istio should leave from the gateway horizontal center, got ${gatewayMeshPath}`,
  );
  assert.equal(
    itemAt(gatewayMeshPoints, 0).y,
    gateway.y + gateway.h,
    `Ingress gateway -> Istio should leave from the gateway bottom edge, got ${gatewayMeshPath}`,
  );
  assert.equal(
    itemAt(gatewayMeshPoints, 1).x,
    itemAt(gatewayMeshPoints, 0).x,
    `Ingress gateway -> Istio should read as a vertical north-to-south handoff, got ${gatewayMeshPath}`,
  );
  assert.equal(
    itemAt(gatewayMeshPoints, 1).y,
    istio.y,
    `Ingress gateway -> Istio should land on the Istio top edge, got ${gatewayMeshPath}`,
  );
  assert.ok(
    itemAt(gatewayMeshPoints, 1).x > istio.x &&
      itemAt(gatewayMeshPoints, 1).x < istio.x + istio.w,
    `Ingress gateway -> Istio should enter through the Istio top side, got ${gatewayMeshPath} istio=${JSON.stringify(
      istio,
    )}`,
  );
  assert.ok(
    itemAt(gatewayMeshPoints, 1).y < storageMeshRailY,
    `Ingress gateway -> Istio should stay above the storage-to-mesh rail, got ${gatewayMeshPath} railY=${storageMeshRailY}`,
  );
  for (const segment of pathSegments(gatewayMeshPath)) {
    for (const [rectId, rect] of [
      ['K3s VMs', k3sVms],
      ['Cert-Manager', certManager],
      ['Authentik', authentik],
    ] as const) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `Ingress gateway -> Istio should avoid ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
  const k3sMeshPath = renderedEdgePath(markup, 'k3s-master->istio');
  const k3sMeshEdgeTag = markup.match(
    /<path data-diagram-edge="k3s-master-&gt;istio"[^>]*>/,
  )?.[0];
  assert.ok(
    k3sMeshEdgeTag,
    'exported reference should render a local K3s master -> Istio service mesh handoff',
  );
  assert.match(
    k3sMeshEdgeTag,
    /data-diagram-edge-channel="mtls"/,
    'K3s master -> Istio should use the mTLS service-mesh channel',
  );
  assert.match(
    k3sMeshEdgeTag,
    /data-diagram-edge-route="straight"/,
    'K3s master -> Istio should be a compact local straight route',
  );
  const k3sMeshPoints = pathPoints(k3sMeshPath);
  assert.equal(
    k3sMeshPoints.length,
    2,
    `K3s master -> Istio should be a single local segment, got ${k3sMeshPath}`,
  );
  assert.equal(
    itemAt(k3sMeshPoints, 0).x,
    k3sMaster.x + k3sMaster.w,
    `K3s master -> Istio should leave the K3s master right edge, got ${k3sMeshPath}`,
  );
  assert.equal(
    itemAt(k3sMeshPoints, 0).y,
    k3sMasterCenterY,
    `K3s master -> Istio should leave from the K3s master vertical center, got ${k3sMeshPath}`,
  );
  assert.equal(
    itemAt(k3sMeshPoints, 1).x,
    istio.x,
    `K3s master -> Istio should land on the Istio left edge, got ${k3sMeshPath}`,
  );
  assert.equal(
    itemAt(k3sMeshPoints, 1).y,
    itemAt(k3sMeshPoints, 0).y,
    `K3s master -> Istio should read as a horizontal local handoff, got ${k3sMeshPath}`,
  );
  assert.ok(
    itemAt(k3sMeshPoints, 1).y > istio.y &&
      itemAt(k3sMeshPoints, 1).y < istio.y + istio.h,
    `K3s master -> Istio should enter through the Istio left side, got ${k3sMeshPath} istio=${JSON.stringify(
      istio,
    )}`,
  );
  for (const segment of pathSegments(k3sMeshPath)) {
    for (const [rectId, rect] of [
      ['ingress', ingress],
      ['storage', storage],
      ['monitoring', monitoring],
    ] as const) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `K3s master -> Istio should avoid ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
  const longhornMeshPath = renderedEdgePath(markup, 'longhorn->istio');
  const longhornMeshPoints = pathPoints(longhornMeshPath);
  const longhornCenterX = Math.round((longhorn.x + longhorn.w / 2) / 4) * 4;
  const longhornMeshTarget = itemAt(longhornMeshPoints, -1);
  assert.equal(
    itemAt(longhornMeshPoints, 0).x,
    longhornCenterX,
    `Longhorn -> Istio should leave from the Longhorn center top anchor, got ${longhornMeshPath}`,
  );
  assert.equal(
    itemAt(longhornMeshPoints, 0).y,
    longhorn.y,
    `Longhorn -> Istio should leave from the Longhorn top edge, got ${longhornMeshPath}`,
  );
  assert.equal(
    longhornMeshTarget.y,
    istio.y + istio.h,
    `Longhorn -> Istio should land on the Istio bottom edge, got ${longhornMeshPath}`,
  );
  assert.ok(
    longhornMeshTarget.x > istio.x && longhornMeshTarget.x < istio.x + istio.w,
    `Longhorn -> Istio should land inside the Istio bottom side, got ${longhornMeshPath} istio=${JSON.stringify(
      istio,
    )}`,
  );
  assert.match(
    longhornMeshPath,
    new RegExp(`Q ${longhornCenterX} ${storageMeshRailY}`),
    `Longhorn -> Istio should climb from Longhorn into the storage-to-mesh rail, got ${longhornMeshPath}`,
  );
  assert.match(
    longhornMeshPath,
    new RegExp(`Q ${longhornMeshTarget.x} ${storageMeshRailY}`),
    `Longhorn -> Istio should leave the storage-to-mesh rail above the Istio bottom entry, got ${longhornMeshPath}`,
  );
  assert.ok(
    pathSegments(longhornMeshPath).some(
      (segment) =>
        segment.y1 === storageMeshRailY &&
        segment.y2 === storageMeshRailY &&
        segment.x2 - segment.x1 >= 240,
    ),
    `Longhorn -> Istio should include a long horizontal storage-to-mesh rail, got ${longhornMeshPath}`,
  );
  assert.ok(
    verticalSegments(longhornMeshPath).some(
      (segment) =>
        segment.x === longhornMeshTarget.x &&
        segment.y1 <= istio.y + istio.h &&
        segment.y2 >= storageMeshRailY - 8,
    ),
    `Longhorn -> Istio should enter Istio through a vertical bottom-edge segment, got ${longhornMeshPath}`,
  );
  for (const segment of pathSegments(longhornMeshPath)) {
    for (const [rectId, rect] of [
      ['K3s VMs', k3sVms],
      ['ingress', ingress],
      ['monitoring', monitoring],
      ['GPU Scheduling', gpuScheduling],
    ] as const) {
      assert.ok(
        !segmentIntersectsRectInterior(segment, rect),
        `Longhorn -> Istio should avoid ${rectId} interior, got segment=${JSON.stringify(
          segment,
        )} rect=${JSON.stringify(rect)}`,
      );
    }
  }
  const storagePath = renderedEdgePath(markup, 'external-ssd->longhorn');
  const storageRailSegments = pathSegments(storagePath).filter(
    (segment) =>
      segment.y1 === segment.y2 &&
      segment.y1 > longhorn.y + longhorn.h + 30 &&
      segment.x2 - segment.x1 >= 60,
  );
  assert.ok(
    storageRailSegments.length > 0,
    `exported reference should route storage backups through a horizontal rail below Longhorn, got ${storagePath}`,
  );
  const storageRailY = itemAt(storageRailSegments, 0).y1;
  const externalSsdRailX =
    Math.round((externalSsd.x + externalSsd.w + 18) / 4) * 4;
  const longhornRailX = Math.round((longhorn.x + longhorn.w / 2) / 4) * 4;
  assert.match(
    storagePath,
    new RegExp(`Q ${externalSsdRailX} ${externalSsd.y + externalSsd.h / 2}`),
    `exported reference should use the same compact source stub x before turning into the storage rail, got ${storagePath}`,
  );
  assert.match(
    storagePath,
    new RegExp(`Q ${externalSsdRailX} ${storageRailY}`),
    `exported reference should bend from the external SSD into the storage rail, got ${storagePath}`,
  );
  assert.match(
    storagePath,
    new RegExp(`Q ${longhornRailX} ${storageRailY}`),
    `exported reference should bend from the storage rail into Longhorn, got ${storagePath}`,
  );
  const certPath = certManagerToGatewayPath;
  const certHandoffSegment = pathSegments(certPath)[0];
  assert.ok(certHandoffSegment);
  assert.equal(
    certPath,
    `M ${certManager.x} ${
      Math.round((certManager.y + certManager.h / 2) / 4) * 4
    } L ${gateway.x + gateway.w} ${
      Math.round((gateway.y + gateway.h / 2) / 4) * 4
    }`,

    `exported reference should render Cert-Manager -> Gateway as a direct local certificate handoff, got ${certPath}`,
  );
  const topCorridorRoutes = [
    [
      'public-internet->cloudflare-tunnel',
      renderedEdgePath(markup, 'public-internet->cloudflare-tunnel'),
    ],

    ['cloudflare-tunnel->gateway', tunnelToGatewayPath],
    ['metallb->gateway', renderedEdgePath(markup, 'metallb->gateway')],
    ['cert-manager->gateway', certPath],
  ] as const;
  const topCorridorProtectedRects = [
    ['Public Internet', publicInternet],
    ['Gateway', gateway],
    ['Cert-Manager', certManager],
    [
      'cluster title label',
      multilineStartTextRect(clusterLabel, ['K3s Kubernetes Cluster']),
    ],

    ['External IPs label', externalIpsLabelFrame],
    ["Let's Encrypt label", certLabelFrame],
  ] as const;
  for (const [routeId, path] of topCorridorRoutes) {
    for (const segment of pathSegments(path)) {
      for (const [rectId, rect] of topCorridorProtectedRects) {
        assert.ok(
          !segmentIntersectsRectInterior(segment, rect),
          `top ingress corridor route ${routeId} should not cross ${rectId}, got segment=${JSON.stringify(
            segment,
          )} rect=${JSON.stringify(rect)} path=${path}`,
        );
      }
    }
  }

  const serviceControlRailX = Math.round((istio.x + istio.w + 22) / 4) * 4;
  const authPath = renderedEdgePath(markup, 'authentik->istio');
  const authPoints = pathPoints(authPath);
  const authTarget = itemAt(authPoints, -1);
  const authCenterY = authentik.y + authentik.h / 2;
  assert.equal(
    authPoints.length,
    2,
    `Authentik -> Istio should be a short local side entry, got ${authPath}`,
  );
  assert.equal(
    itemAt(authPoints, 0).x,
    authentik.x,
    `Authentik -> Istio should leave the Authentik left edge, got ${authPath}`,
  );
  assert.equal(
    itemAt(authPoints, 0).y,
    authCenterY,
    `Authentik -> Istio should leave from Authentik center height, got ${authPath}`,
  );
  assert.equal(
    authTarget.x,
    istio.x + istio.w,
    `Authentik -> Istio should land directly on the Istio right edge, got ${authPath}`,
  );
  assert.equal(
    authTarget.y,
    authCenterY,
    `Authentik -> Istio should stay horizontal into the service mesh, got ${authPath}`,
  );
  assert.ok(
    pathSegments(authPath).some(
      (segment) =>
        segment.y1 === authCenterY &&
        segment.x1 <= serviceControlRailX &&
        segment.x2 >= serviceControlRailX,
    ),
    `Authentik -> Istio should cross the local service-control entry lane, got ${authPath}`,
  );
  assert.ok(
    pathSegments(authPath).every(
      (segment) => !collinearSegmentsOverlap(segment, certHandoffSegment),
    ),
    `Authentik -> Istio should not reuse the local certificate handoff segment, got ${authPath} certificate=${certPath}`,
  );

  const deployPath = renderedEdgePath(markup, 'argocd->istio');
  const deployPoints = pathPoints(deployPath);
  const deployTarget = itemAt(deployPoints, -1);
  const argocdCenterY = argocd.y + argocd.h / 2;
  assert.equal(
    itemAt(deployPoints, 0).x,
    argocd.x,
    `ArgoCD -> Istio should leave the ArgoCD left edge, got ${deployPath}`,
  );
  assert.equal(
    itemAt(deployPoints, 0).y,
    argocdCenterY,
    `ArgoCD -> Istio should leave from ArgoCD center height, got ${deployPath}`,
  );
  assert.equal(
    deployTarget.x,
    istio.x + istio.w,
    `ArgoCD -> Istio should land directly on the Istio right edge, got ${deployPath}`,
  );
  assert.ok(
    deployTarget.y > authTarget.y &&
      deployTarget.y > istio.y &&
      deployTarget.y < istio.y + istio.h,
    `ArgoCD -> Istio should use a lower separated Istio side anchor, got ${deployPath} authTarget=${JSON.stringify(
      authTarget,
    )} istio=${JSON.stringify(istio)}`,
  );
  assert.match(
    deployPath,
    new RegExp(`Q ${serviceControlRailX} ${argocdCenterY}`),
    `ArgoCD -> Istio should bend from ArgoCD into the local service-control entry rail, got ${deployPath}`,
  );
  assert.match(
    deployPath,
    new RegExp(`Q ${serviceControlRailX} ${deployTarget.y}`),
    `ArgoCD -> Istio should leave the local service-control entry rail into Istio, got ${deployPath}`,
  );
  assert.ok(
    pathSegments(deployPath).every(
      (segment) => !collinearSegmentsOverlap(segment, certHandoffSegment),
    ),
    `ArgoCD -> Istio should not reuse the local certificate handoff segment, got ${deployPath} certificate=${certPath}`,
  );
  const deployRailSegments = verticalSegments(deployPath).filter(
    (segment) =>
      segment.x === serviceControlRailX && segment.y2 - segment.y1 > 20,
  );
  assert.ok(
    deployRailSegments.some(
      (segment) =>
        segment.y1 <= deployTarget.y + 8 && segment.y2 >= argocdCenterY - 8,
    ),
    `ArgoCD -> Istio should use a visible local service-control rail between ArgoCD and Istio, got ${deployPath}`,
  );
  for (const [edge, path, blockers] of [
    [
      'Authentik -> Istio',
      authPath,
      [
        ['ArgoCD', argocd],
        ['Git Repo', gitRepo],
        ['Monitoring', monitoring],
        [
          'gateway downlink',
          { x: itemAt(gatewayMeshPoints, 0).x - 1, y: 400, w: 2, h: 28 },
        ],
      ],
    ],

    [
      'ArgoCD -> Istio',
      deployPath,
      [
        ['Authentik', authentik],
        ['Git Repo', gitRepo],
        ['Monitoring', monitoring],
        [
          'gateway downlink',
          { x: itemAt(gatewayMeshPoints, 0).x - 1, y: 400, w: 2, h: 28 },
        ],
      ],
    ],
  ] as const) {
    for (const segment of pathSegments(path)) {
      for (const [rectId, rect] of blockers) {
        assert.ok(
          !segmentIntersectsRectInterior(segment, rect),
          `${edge} should avoid ${rectId} interior, got segment=${JSON.stringify(
            segment,
          )} rect=${JSON.stringify(rect)}`,
        );
      }
    }
  }
  assert.ok(
    pathSegments(authPath).every((segment) => segment.y2 < monitoring.y) &&
      pathSegments(deployPath).every((segment) => segment.y2 < monitoring.y),
    `right-side service-control entries should stay above Monitoring, got auth=${authPath} deploy=${deployPath}`,
  );

  const observabilityTrunkPoints = pathPoints(observabilityTrunkPath);
  const observabilityMeshTarget = itemAt(observabilityTrunkPoints, -1);
  assert.equal(
    observabilityMeshTarget.y,
    istio.y + istio.h,
    `observability trunk should terminate on the Istio bottom boundary, got ${observabilityTrunkPath}`,
  );
  assert.ok(
    longhornMeshTarget.x < observabilityMeshTarget.x,
    `Longhorn storage should use the left lower Istio entry and observability should use a separate center entry, got longhorn=${JSON.stringify(
      longhornMeshTarget,
    )} observability=${JSON.stringify(observabilityMeshTarget)}`,
  );
  assert.ok(
    observabilityMeshTarget.x - longhornMeshTarget.x >= 56,
    `Longhorn and observability lower Istio entries should have separate lanes, got longhorn=${JSON.stringify(
      longhornMeshTarget,
    )} observability=${JSON.stringify(observabilityMeshTarget)}`,
  );
  assert.ok(
    gpuPathTarget.x > observabilityMeshTarget.x,
    `GPU scheduling should use a right-lower Istio entry separate from observability, got gpu=${JSON.stringify(
      gpuPathTarget,
    )} observability=${JSON.stringify(observabilityMeshTarget)}`,
  );
  assert.ok(
    gpuPathTarget.x - observabilityMeshTarget.x >= 56,
    `GPU scheduling and observability lower Istio entries should have separate lanes, got gpu=${JSON.stringify(
      gpuPathTarget,
    )} observability=${JSON.stringify(observabilityMeshTarget)}`,
  );

  const monitoringLabelRect = multilineStartTextRect(monitoringLabel, [
    'Monitoring',
  ]);
  for (const [edge, path] of [
    ['Longhorn -> Istio', longhornMeshPath],
    ['observability trunk', observabilityTrunkPath],
    ['GPU scheduling -> Istio', gpuPath],
    [
      'Grafana -> observability',
      renderedEdgePath(markup, 'grafana->observability-bus'),
    ],

    [
      'VictoriaMetrics -> observability',
      renderedEdgePath(markup, 'victoria-metrics->observability-bus'),
    ],

    [
      'VictoriaLogs -> observability',
      renderedEdgePath(markup, 'victoria-logs->observability-bus'),
    ],

    [
      'Jaeger -> observability',
      renderedEdgePath(markup, 'jaeger->observability-bus'),
    ],
  ] as const) {
    for (const segment of pathSegments(path)) {
      for (const [rectId, rect] of [
        ['Grafana', grafana],
        ['VictoriaMetrics', victoriaMetrics],
        ['Monitoring label', monitoringLabelRect],
      ] as const) {
        assert.ok(
          !segmentIntersectsRectInterior(segment, rect),
          `${edge} should keep its corridor out of ${rectId}, got segment=${JSON.stringify(
            segment,
          )} rect=${JSON.stringify(rect)} path=${path}`,
        );
      }
    }
  }

  const protectedCorridorSegments = [
    ['gateway -> Istio downlink', gatewayMeshPath],
    ['Authentik side entry', authPath],
    ['ArgoCD side entry', deployPath],
    ['observability trunk', observabilityTrunkPath],
  ] as const;
  for (const [edge, path] of [
    ['Longhorn -> Istio', longhornMeshPath],
    ['observability trunk', observabilityTrunkPath],
    ['GPU scheduling -> Istio', gpuPath],
  ] as const) {
    for (const segment of pathSegments(path)) {
      for (const [protectedId, protectedPath] of protectedCorridorSegments) {
        if (edge === protectedId) continue;
        for (const protectedSegment of pathSegments(protectedPath)) {
          assert.ok(
            !segmentsCrossInterior(segment, protectedSegment),
            `${edge} should not cross ${protectedId}, got segment=${JSON.stringify(
              segment,
            )} protected=${JSON.stringify(
              protectedSegment,
            )} path=${path} protectedPath=${protectedPath}`,
          );
        }
      }
    }
  }

  for (const [id, child] of [
    ['ingress', ingress],
    ['k3s-vms', k3sVms],
    ['mesh', mesh],
    ['certificates', certificates],
    ['storage', storage],
    ['monitoring', monitoring],
    ['gpu-scheduling', gpuScheduling],
  ] as const) {
    assert.ok(
      rectContains(cluster, child),
      `exported reference cluster should contain ${id} group frame, got cluster=${JSON.stringify(
        cluster,
      )} child=${JSON.stringify(child)}`,
    );
  }
  for (const [id, group, node] of [
    ['k3s-master', k3sVms, k3sMaster],
    ['istio', mesh, istio],
    ['cert-manager', certificates, certManager],
    ['longhorn', storage, longhorn],
  ] as const) {
    assert.ok(
      rectContains(group, node),
      `exported reference tight group should contain ${id}, got group=${JSON.stringify(
        group,
      )} node=${JSON.stringify(node)}`,
    );
  }
  assert.ok(
    !rectsOverlap(laptop, proxmox),
    `exported reference should keep laptop hardware separate from the Proxmox frame, got laptop=${JSON.stringify(
      laptop,
    )} proxmox=${JSON.stringify(proxmox)}`,
  );
  assert.ok(
    !rectsOverlap(proxmox, cluster),
    `exported reference should keep Proxmox outside the K3s cluster frame, got proxmox=${JSON.stringify(
      proxmox,
    )} cluster=${JSON.stringify(cluster)}`,
  );
  assert.ok(
    storageLabel.y > storageRailY,
    `exported reference should anchor the storage/backups label below the storage rail, got label=${JSON.stringify(
      storageLabel,
    )} railY=${storageRailY}`,
  );
  const storageLabelRect = labelPointRect({
    label: 'Distributed Storage & Backups',
    ...storageLabel,
  });
  for (const [id, rect] of [
    ['external SSD', externalSsd],
    ['Longhorn', longhorn],
  ] as const) {
    assert.ok(
      !rectsOverlap(storageLabelRect, rect),
      `exported reference should keep the storage/backups label clear of ${id}, got label=${JSON.stringify(
        storageLabelRect,
      )} ${id}=${JSON.stringify(rect)}`,
    );
  }
  assert.equal(
    laptopSecondItem.y - laptopFirstItem.y,
    12,
    'exported reference should use compact hardware item row spacing',
  );
  assert.ok(
    certLabel.y < istio.y,
    `exported reference should keep the certificate label above the Istio service mesh node, got label=${JSON.stringify(
      certLabel,
    )} istio=${JSON.stringify(istio)}`,
  );
  for (const [id, rect] of [
    ['cert-manager', certManager],
    ['gateway', gateway],
    ['istio', istio],
  ] as const) {
    assert.ok(
      !rectsOverlap(certLabelFrame, rect),
      `exported reference should keep the certificate label frame clear of ${id}, got label=${JSON.stringify(
        certLabelFrame,
      )} ${id}=${JSON.stringify(rect)}`,
    );
  }
});

test('renders a labelled phantom as a no-frame connectable node', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'phantom-label-test',
      children: [
        createElement(Diagram.Phantom, { id: 'from', row: 0, col: 0 }),
        createElement(
          Diagram.Phantom,
          { id: 'step', row: 0, col: 1, width: 220, height: 44 },
          'Select target',
        ),
        createElement(Diagram.Phantom, { id: 'to', row: 0, col: 2 }),
        createElement(Diagram.Wire, { from: 'from', to: 'step' }),
        createElement(Diagram.Arrow, { from: 'step', to: 'to' }),
      ],
    }),
  );

  assert.match(markup, /Select target/);
  assert.doesNotMatch(markup, /<rect[^>]+width="220"[^>]+height="44"/);
});

test('renders stacked node frames for repeated VM-style instances without cropping the overhang', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'stacked-vm-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Card,
        { id: 'vm', row: 0, col: 1, stack: 3, stackOffset: 14 },
        createElement(Diagram.Line, null, 'VM'),
        createElement(Diagram.Line, { textColor: 'dim' }, 'K3s worker'),
      ),
    }),
  );

  assert.match(markup, /VM/);
  assert.match(markup, /K3s worker/);
  assert.match(
    markup,
    /<rect data-diagram-node-stack="vm:2" x="304" y="68" width="176" height="64"/,
    'furthest stack frame should render behind the primary VM card',
  );
  assert.match(
    markup,
    /<rect data-diagram-node-stack="vm:1" x="318" y="82" width="176" height="64"/,
    'nearest stack frame should render with the configured offset',
  );
  assert.match(
    markup,
    /<svg[^>]*viewBox="264 28 284 172"/,
    'content viewBox should include stacked-frame overhang instead of cropping it',
  );
});

test('renders directional VM stack frames with vector-controlled overhang', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'directional-vm-stack-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Card,
        {
          id: 'vm',
          row: 0,
          col: 1,
          width: 160,
          height: 80,
          stack: 4,
          stackDirection: 'up-right',
          stackDx: 20,
          stackDy: 10,
          caption: 'Hosted VM',
          captionSide: 'top',
        },
        'VM',
      ),
    }),
  );

  assert.match(markup, /Hosted VM/);
  assert.match(
    markup,
    /<rect data-diagram-node-stack="vm:3" x="400" y="58" width="160" height="80"/,
    'furthest stack frame should fan up and right by the configured vector',
  );
  assert.match(
    markup,
    /<rect data-diagram-node-stack="vm:1" x="360" y="78" width="160" height="80"/,
    'nearest stack frame should use one vector step from the primary card',
  );
  assert.match(
    markup,
    /<svg[^>]*viewBox="300 18 300 190"/,
    'content viewBox should include directional stack overhang instead of cropping it',
  );
});

test('renders shaped VM stack frames and includes their expanded bounds', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'shaped-vm-stack-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Card,
        {
          id: 'vm',
          row: 0,
          col: 1,
          width: 120,
          height: 56,
          stack: 4,
          stackDirection: 'up-left',
          stackDx: 16,
          stackDy: 10,
          stackWidthStep: 12,
          stackHeightStep: 8,
        },
        'VM',
      ),
    }),
  );

  assert.match(
    markup,
    /<rect data-diagram-node-stack="vm:3" x="312" y="70" width="156" height="80"/,
    'furthest stack frame should grow while fanning up-left',
  );
  assert.match(
    markup,
    /<rect data-diagram-node-stack="vm:1" x="344" y="90" width="132" height="64"/,
    'nearest stack frame should apply one shaped-stack step',
  );
  assert.match(
    markup,
    /<svg[^>]*viewBox="272 30 248 166"/,
    'content viewBox should include shaped stack overhang instead of cropping it',
  );
});

test('tightX groups hug shaped stack bounds without colliding with adjacent groups', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'tight-x-stack-group-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Group,
          {
            id: 'hypervisor',
            label: 'Proxmox VE',
            tight: true,
            tightX: true,
            titleBand: true,
            padding: { top: 40, right: 8, bottom: 8, left: 8 },
          },

          createElement(
            Diagram.Card,
            {
              id: 'vm',
              row: 0,
              col: 0,
              width: 120,
              height: 56,
              stack: 4,
              stackDirection: 'up-left',
              stackDx: 16,
              stackDy: 10,
              stackWidthStep: 12,
              stackHeightStep: 8,
            },
            'VM',
          ),
        ),
        createElement(
          Diagram.Group,
          {
            id: 'cluster',
            label: 'K3s',
            rowStart: 0,
            rowEnd: 0,
            colStart: 1,
            colEnd: 1,
            padding: 8,
          },

          createElement(
            Diagram.Box,
            { id: 'k3s', row: 0, col: 1, width: 120, height: 56 },
            'K3s',
          ),
        ),
      ],
    }),
  );

  const hypervisor = renderedRect(markup, 'data-diagram-group', 'hypervisor');
  const cluster = renderedRect(markup, 'data-diagram-group', 'cluster');
  const vm = renderedRect(markup, 'data-diagram-node', 'vm');
  const backVm = renderedRect(markup, 'data-diagram-node-stack', 'vm:3');

  assert.deepEqual(hypervisor, { x: 64, y: 30, w: 184, h: 134 });
  assert.ok(
    rectContains(hypervisor, vm) && rectContains(hypervisor, backVm),
    `tightX hypervisor group should contain the shaped VM stack, got group=${JSON.stringify(
      hypervisor,
    )} vm=${JSON.stringify(vm)} back=${JSON.stringify(backVm)}`,
  );
  assert.ok(
    !rectsOverlap(hypervisor, cluster),
    `tightX hypervisor group should stay separate from the adjacent cluster group, got hypervisor=${JSON.stringify(
      hypervisor,
    )} cluster=${JSON.stringify(cluster)}`,
  );
});

test('tightY groups hug child visual bounds without changing track-driven width', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'tight-y-section-group-test',
      defaultMode: 'static',
      graph: {
        columns: [160, 160, 160],
        rows: [96, 96, 96, 96],
        padX: 40,
        padY: 40,
        titleTopPad: 0,
      },
      children: createElement(
        Diagram.Group,
        {
          id: 'section',
          label: 'Monitoring',
          rowStart: 0,
          rowEnd: 3,
          colStart: 0,
          colEnd: 2,
          titleBand: true,
          tightY: true,
          padding: { top: 40, right: 12, bottom: 8, left: 12 },
        },

        createElement(
          Diagram.Box,
          { id: 'top', row: 1, col: 0, width: 80, height: 40 },
          'Top',
        ),
        createElement(
          Diagram.Box,
          { id: 'bottom', row: 2, col: 2, width: 80, height: 40 },
          'Bottom',
        ),
      ),
    }),
  );

  const section = renderedRect(markup, 'data-diagram-group', 'section');
  const top = renderedRect(markup, 'data-diagram-node', 'top');
  const bottom = renderedRect(markup, 'data-diagram-node', 'bottom');

  assert.equal(
    section.w,
    504,
    'tightY should preserve the normal track-driven group width',
  );
  assert.equal(
    section.y,
    top.y - 40,
    'tightY should place the group top from child visual bounds plus top padding',
  );
  assert.equal(
    section.y + section.h,
    bottom.y + bottom.h + 8,
    'tightY should place the group bottom from child visual bounds plus bottom padding',
  );
  assert.ok(
    section.h < 424,
    `tightY group should be shorter than the full row span, got ${JSON.stringify(
      section,
    )}`,
  );
});

test('rejects negative VM stack vector distances', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'invalid-stack-vector-test',
          defaultMode: 'static',
          children: createElement(
            Diagram.Card,
            { id: 'vm', row: 0, col: 0, stack: 2, stackDx: -4 },
            'VM',
          ),
        }),
      ),
    /Diagram node "vm" stackDx must be non-negative/,
  );
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'invalid-stack-shape-test',
          defaultMode: 'static',
          children: createElement(
            Diagram.Card,
            { id: 'vm', row: 0, col: 0, stack: 2, stackWidthStep: -4 },
            'VM',
          ),
        }),
      ),
    /Diagram node "vm" stackWidthStep must be non-negative/,
  );
});

test('renders dense node body item lists for hardware and scheduling cards', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'node-items-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Card,
          {
            id: 'laptop',
            row: 0,
            col: 0,
            width: 232,
            height: 176,
            icon: 'server',
            bodyFontSize: 10,
            bodyLineGap: 2,
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
          Diagram.Card,
          {
            id: 'gpu',
            row: 0,
            col: 1,
            width: 228,
            height: 160,
            icon: 'gpu',
            bodyFontSize: 10,
            bodyLineGap: 2,
            description: ['GPU Workflow', 'NVIDIA RTX 3050'],
            items: ['K3s Node Affinity', 'Automatic GPU Scheduling'],
          },
          'GPU Scheduling',
        ),
      ],
    }),
  );

  assert.match(markup, /Dell Laptop/);
  assert.match(markup, /GPU Scheduling/);
  for (const [nodeId, count] of [
    ['laptop', 4],
    ['gpu', 2],
  ] as const) {
    for (let i = 0; i < count; i++) {
      assert.match(
        markup,
        new RegExp(`data-diagram-node-item="${nodeId}:${i}"`),
        `expected ${nodeId} item ${i} to render as a semantic body list row`,
      );
    }
  }
  assert.match(
    markup,
    /data-diagram-node-item="laptop:2"[^>]*data-diagram-node-body-font-size="10"[^>]*data-diagram-node-body-line-gap="2"[\s\S]*<text[^>]*font-size="10"[\s\S]*NVIDIA RTX 3050 4GB GPU/,
    'hardware card should render long GPU item text with compact body typography',
  );
  assert.match(
    markup,
    /data-diagram-node-description="gpu"[^>]*data-diagram-node-body-font-size="10"[^>]*data-diagram-node-body-line-gap="2"[^>]*font-size="10"[\s\S]*NVIDIA RTX 3050/,
    'GPU card should render description text with compact body typography',
  );
  assert.match(
    markup,
    /data-diagram-node-item="gpu:1"[^>]*data-diagram-node-body-font-size="10"[^>]*data-diagram-node-body-line-gap="2"[\s\S]*<text[^>]*font-size="10"[\s\S]*Automatic GPU Scheduling/,
    'GPU card should render scheduling item text with compact body typography',
  );
  const firstLaptopItem = renderedGroupTranslate(
    markup,
    'data-diagram-node-item',
    'laptop:0',
  );
  const secondLaptopItem = renderedGroupTranslate(
    markup,
    'data-diagram-node-item',
    'laptop:1',
  );
  assert.equal(
    secondLaptopItem.y - firstLaptopItem.y,
    12,
    'bodyLineGap should make dense item rows use bodyFontSize + bodyLineGap spacing',
  );
});

test('rejects invalid dense node body typography values', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: createElement(
            Diagram.Card,
            { id: 'bad', row: 0, col: 0, bodyFontSize: 0 },
            'Bad',
          ),
        }),
      ),
    /Diagram node "bad" bodyFontSize must be a positive finite number, got 0\./,
  );
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: createElement(
            Diagram.Card,
            { id: 'bad', row: 0, col: 0, bodyLineGap: -1 },
            'Bad',
          ),
        }),
      ),
    /Diagram node "bad" bodyLineGap must be a non-negative finite number, got -1\./,
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
              rowStart: 0,
              rowEnd: 1,
              colStart: 0,
              colEnd: 1,
            }),
            createElement(Diagram.Group, {
              id: 'services',
              label: 'Other services',
              rowStart: 2,
              rowEnd: 3,
              colStart: 0,
              colEnd: 1,
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

test('Group tight + padding render a shorter group rect than the default', () => {
  const tight = render(
    createElement(SvgGraphDiagram, {
      title: 'tight-group',
      children: [
        createElement(Diagram.Group, {
          id: 'g',
          label: 'G',
          tight: true,
          padding: 8,
          rowStart: 0,
          rowEnd: 0,
          colStart: 0,
          colEnd: 0,
        }),
        createElement(
          Diagram.Card,
          { id: 'n', row: 0, col: 0, group: 'g' },
          'N',
        ),
      ],
    }),
  );
  const loose = render(
    createElement(SvgGraphDiagram, {
      title: 'loose-group',
      children: [
        createElement(Diagram.Group, {
          id: 'g',
          label: 'G',
          rowStart: 0,
          rowEnd: 0,
          colStart: 0,
          colEnd: 0,
        }),
        createElement(
          Diagram.Card,
          { id: 'n', row: 0, col: 0, group: 'g' },
          'N',
        ),
      ],
    }),
  );

  const heightOf = (markup: string) => {
    const match = markup.match(
      /<rect [^>]*?height="(\d+(?:\.\d+)?)"[^>]*?stroke-width="1"/,
    );
    assert.ok(match, 'group rect with stroke-width=1 should be present');
    return Number(match[1]);
  };

  const tightH = heightOf(tight);
  const looseH = heightOf(loose);

  assert.ok(
    tightH < looseH,
    `tight group rect (${tightH}) should be shorter than default (${looseH})`,
  );
});

test('renders group frame variants and semantic grid dividers from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-divider-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Group,
        {
          id: 'matrix',
          label: 'Matrix',
          frame: 'dashed',
          fill: 'none',
          rowStart: 0,
          rowEnd: 1,
          colStart: 0,
          colEnd: 1,
          dividers: { rows: [1], cols: [1] },
        },

        createElement(Diagram.Box, { id: 'a', row: 0, col: 0 }, 'A'),
        createElement(Diagram.Box, { id: 'b', row: 1, col: 1 }, 'B'),
      ),
    }),
  );

  assert.match(markup, /Matrix/);
  assert.match(
    markup,
    /<rect[^>]*width="528"[^>]*height="304"[^>]*fill="none"[^>]*stroke-dasharray="6 6"/,
    'dashed transparent group frame should render as a real SVG rect',
  );
  assert.match(
    markup,
    /data-diagram-group-divider="matrix:row:1"/,
    'row divider should be rendered as a first-class SVG line',
  );
  assert.match(
    markup,
    /data-diagram-group-divider="matrix:col:1"/,
    'column divider should be rendered as a first-class SVG line',
  );
});

test('group padding accepts per-side values from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-padding-side-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Group,
        {
          id: 'cluster',
          label: 'Cluster',
          rowStart: 0,
          rowEnd: 0,
          colStart: 0,
          colEnd: 0,
          padding: { top: 40, right: 12, bottom: 8, left: 20 },
        },

        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 0 },
          'Service',
        ),
      ),
    }),
  );

  assert.match(
    markup,
    /<rect data-diagram-group="cluster"[^>]*\bx="40"[^>]*\by="24"[^>]*\bwidth="272"[^>]*\bheight="176"/,
    'group frames should resolve top/right/bottom/left padding independently',
  );
});

test('group title bands reserve a label gutter above child nodes from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-title-band-test',
      defaultMode: 'static',
      graph: {
        columns: [160],
        rows: [96],
        padX: 20,
        padY: 60,
        titleTopPad: 0,
      },
      children: createElement(
        Diagram.Group,
        {
          id: 'cluster',
          label: 'Cluster',
          titleBand: true,
          titleGap: 12,
          padding: 8,
          rowStart: 0,
          rowEnd: 0,
          colStart: 0,
          colEnd: 0,
        },

        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 0, width: 84, height: 48 },
          'Service',
        ),
      ),
    }),
  );

  const group = renderedRect(markup, 'data-diagram-group', 'cluster');
  const band = renderedRect(markup, 'data-diagram-group-title-band', 'cluster');
  const service = renderedRect(markup, 'data-diagram-node', 'service');
  const label = renderedTextPoint(
    markup,
    'data-diagram-group-label',
    'cluster',
  );

  assert.equal(band.x, group.x);
  assert.equal(band.y, group.y);
  assert.equal(band.w, group.w);
  assert.equal(
    band.h,
    40,
    'title band height should equal group label height plus titleGap',
  );
  assert.ok(
    label.y > band.y && label.y < band.y + band.h,
    `group label should render inside the title band, got label=${JSON.stringify(
      label,
    )} band=${JSON.stringify(band)}`,
  );
  assert.ok(
    service.y > band.y + band.h,
    `child node should sit below the reserved title gutter, got service=${JSON.stringify(
      service,
    )} band=${JSON.stringify(band)}`,
  );
  assert.match(
    markup,
    new RegExp(
      `<line data-diagram-group-title-separator="cluster"[^>]*y1="${band.y + band.h}"[^>]*y2="${band.y + band.h}"`,
    ),
    'title band should render a separator line below the reserved gutter',
  );
});

test('tight parent groups include child group frames from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'tight-child-group-test',
      defaultMode: 'static',
      children: createElement(
        Diagram.Group,
        { id: 'parent', label: 'Parent', tight: true },
        createElement(
          Diagram.Group,
          { id: 'child', label: 'Child', padding: 12 },
          createElement(
            Diagram.Box,
            { id: 'service', row: 0, col: 0 },
            'Service',
          ),
        ),
      ),
    }),
  );

  const parent = renderedRect(markup, 'data-diagram-group', 'parent');
  const child = renderedRect(markup, 'data-diagram-group', 'child');
  assert.ok(
    parent.y <= child.y && parent.y + parent.h >= child.y + child.h,
    `tight parent group should contain child group frame, got parent=${JSON.stringify(
      parent,
    )} child=${JSON.stringify(child)}`,
  );
});

test('rejects negative group title gaps', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'negative-group-title-gap',
          defaultMode: 'static',
          children: createElement(Diagram.Group, {
            id: 'cluster',
            label: 'Cluster',
            titleBand: true,
            titleGap: -1,
            rowStart: 0,
            rowEnd: 0,
            colStart: 0,
            colEnd: 0,
          }),
        }),
      ),
    /Diagram\.Group "cluster" titleGap must be non-negative\./,
  );
});

test('rejects group dividers outside the group bounds', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'invalid-group-divider',
          defaultMode: 'static',
          children: createElement(Diagram.Group, {
            id: 'matrix',
            rowStart: 0,
            rowEnd: 1,
            colStart: 0,
            colEnd: 1,
            dividers: { rows: [2] },
          }),
        }),
      ),
    /Diagram.Group "matrix" row divider 2 is outside group bounds/,
  );
});

test('renders annotations anchored to nodes and groups without caller-owned x/y math', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'anchored-note-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Group, {
          id: 'cluster',
          label: 'Cluster',
          rowStart: 0,
          rowEnd: 0,
          colStart: 0,
          colEnd: 0,
        }),
        createElement(
          Diagram.Box,
          { id: 'db', row: 0, col: 0, group: 'cluster' },
          'DB',
        ),
        createElement(
          Diagram.Note,
          { target: 'db', anchor: 'right', dx: 8, leader: true },
          'Owned by data',
        ),
        createElement(
          Diagram.Note,
          { target: 'cluster', anchor: 'bottom' },
          'Storage boundary',
        ),
      ],
    }),
  );

  assert.match(markup, /Owned by data/);
  assert.match(markup, /Storage boundary/);
  assert.match(
    markup,
    /data-diagram-annotation="db:right"[^>]*data-diagram-annotation-target="db"[^>]*data-diagram-annotation-anchor="right"/,
    'node note should expose its target and anchor for black-box SVG tests',
  );
  assert.match(
    markup,
    /<line data-diagram-annotation-leader="db:right"[^>]*x1="268" y1="128" x2="286" y2="128"[^>]*stroke-width="1"/,
    'right-anchored node note should render a leader line from the node edge toward the note',
  );
  assert.match(
    markup,
    /data-diagram-annotation="cluster:bottom"[^>]*data-diagram-annotation-target="cluster"[^>]*data-diagram-annotation-anchor="bottom"/,
    'group note should expose its target and anchor for black-box SVG tests',
  );
  assert.match(
    markup,
    /<text data-diagram-annotation="db:right"[^>]*x="292" y="128" text-anchor="start"[^>]*>.*Owned by data/s,
    'right-anchored node note should resolve from the target box and default to start alignment',
  );
  assert.match(
    markup,
    /<text data-diagram-annotation="cluster:bottom"[^>]*x="180" y="232" text-anchor="middle"[^>]*>.*Storage boundary/s,
    'bottom-anchored group note should resolve from the group box and default to middle alignment',
  );
});

test('rejects annotations whose target id is not a node or group', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'bad-note-target',
          defaultMode: 'static',
          children: [
            createElement(Diagram.Box, { id: 'db', row: 0, col: 0 }, 'DB'),
            createElement(
              Diagram.Note,
              { target: 'missing', anchor: 'top' },
              'Missing target',
            ),
          ],
        }),
      ),
    /Diagram.Text target "missing" does not match a node or group/,
  );
});

test('routes edges to named node ports without phantom anchor nodes', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'node-port-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'client', row: 0, col: 0 }, 'Client'),
        createElement(
          Diagram.Card,
          {
            id: 'service',
            row: 0,
            col: 1,
            width: 220,
            height: 96,
            ports: [
              { id: 'http', side: 'left', offset: -22, label: 'HTTP' },
              {
                id: 'events',
                side: 'right',
                offset: 0,
                label: 'EVT',
                accent: true,
              },
              { id: 'sql', side: 'bottom', offset: 34, label: 'SQL' },
            ],
          },

          'Service',
        ),
        createElement(Diagram.Box, { id: 'bus', row: 0, col: 2 }, 'Bus'),
        createElement(Diagram.Box, { id: 'db', row: 1, col: 1 }, 'DB'),

        createElement(Diagram.Arrow, { from: 'client', to: 'service:http' }),
        createElement(Diagram.Arrow, { from: 'service:events', to: 'bus' }),
        createElement(Diagram.Arrow, { from: 'db', to: 'service:sql' }),
      ],
    }),
  );

  assert.match(markup, /data-diagram-port="service:http"/);
  assert.match(markup, /data-diagram-port="service:events"/);
  assert.match(markup, /data-diagram-port="service:sql"/);
  assert.match(markup, />HTTP</);
  assert.match(markup, />EVT</);
  assert.match(markup, />SQL</);

  const paths = [
    ...markup.matchAll(/<path [^>]*d="([^"]+)"[^>]*stroke-width="1\.5"[^>]*>/g),
  ].map(firstCapture);
  assert.equal(paths.length, 3);
  assert.ok(
    paths.some((path) => /L 300 108/.test(path)),
    `client->service:http should land on the HTTP port corridor, got ${paths.join(' | ')}`,
  );
  assert.ok(
    paths.some((path) => /^M 530 128 /.test(path)),
    `service:events->bus should start at the events port, got ${paths.join(' | ')}`,
  );
  assert.ok(
    paths.some((path) => /L 456 186/.test(path)),
    `db->service:sql should land below the SQL port, got ${paths.join(' | ')}`,
  );
});

test('junction nodes create first-class merge points for bundled edge flows', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'junction-test',
      defaultMode: 'static',
      graph: {
        columns: [120, 120, 120],
        rows: [80, 80, 80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'logs', row: 0, col: 0, width: 72, height: 40 },
          'Logs',
        ),
        createElement(
          Diagram.Box,
          { id: 'metrics', row: 2, col: 0, width: 72, height: 40 },
          'Metrics',
        ),
        createElement(Diagram.Junction, {
          id: 'obs-bus',
          row: 1,
          col: 1,
          tone: 'blue',
        }),
        createElement(
          Diagram.Box,
          { id: 'mesh', row: 1, col: 2, width: 92, height: 48 },
          'Mesh',
        ),

        createElement(Diagram.Arrow, {
          from: 'logs',
          to: 'obs-bus',
          headless: true,
        }),
        createElement(Diagram.Arrow, {
          from: 'metrics',
          to: 'obs-bus',
          headless: true,
        }),
        createElement(Diagram.Arrow, { from: 'obs-bus', to: 'mesh' }),
      ],
    }),
  );

  assert.match(
    markup,
    /<circle data-diagram-junction="obs-bus" cx="180" cy="120" r="8"[^>]*stroke="var\(--dgm-tone-blue-stroke/,
    'junction should render as a first-class semantic merge marker',
  );
  assert.match(
    markup,
    /data-diagram-edge="logs-&gt;obs-bus"[^>]*\sd="[^"]*L 162 116"/,
    'upper branch should terminate at the junction approach point',
  );
  assert.match(
    markup,
    /data-diagram-edge="metrics-&gt;obs-bus"[^>]*\sd="[^"]*L 162 124"/,
    'lower branch should terminate at a separate junction approach point',
  );
  assert.match(
    markup,
    /data-diagram-edge="obs-bus-&gt;mesh"[^>]*\sd="M 188 120 L 244 120"/,
    'single trunk should exit the junction toward the target',
  );
});

test('hidden junctions remain routable without rendering a visible marker', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'hidden-junction-test',
      defaultMode: 'static',
      graph: {
        columns: [120, 120, 120],
        rows: [80, 80, 80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'source', row: 1, col: 0, width: 72, height: 40 },
          'Source',
        ),
        createElement(Diagram.Junction, {
          id: 'bus',
          row: 1,
          col: 1,
          hidden: true,
          tone: 'blue',
        }),
        createElement(
          Diagram.Box,
          { id: 'target', row: 1, col: 2, width: 92, height: 48 },
          'Target',
        ),

        createElement(Diagram.Arrow, {
          from: 'source',
          to: 'bus',
          headless: true,
        }),
        createElement(Diagram.Arrow, { from: 'bus', to: 'target' }),
      ],
    }),
  );

  assert.doesNotMatch(
    markup,
    /data-diagram-junction="bus"/,
    'hidden junction should not render a visible junction circle',
  );
  assert.match(
    markup,
    /data-diagram-edge="source-&gt;bus"[^>]*\sd="[^"]*L 162 120"/,
    'source branch should still terminate at the hidden junction approach point',
  );
  assert.match(
    markup,
    /data-diagram-edge="bus-&gt;target"[^>]*\sd="M 188 120 L 244 120"/,
    'trunk should still exit the hidden junction toward the target',
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

test('routes edges to group boundaries and named group ports without hidden nodes', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'group-endpoint-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'client', row: 0, col: 0 }, 'Client'),
        createElement(
          Diagram.Group,
          {
            id: 'services',
            label: 'Services',
            rowStart: 0,
            rowEnd: 1,
            colStart: 1,
            colEnd: 2,
            ports: [
              { id: 'egress', side: 'right', label: 'OUT', accent: true },
            ],
          },

          createElement(Diagram.Box, { id: 'api', row: 0, col: 1 }, 'API'),
          createElement(Diagram.Box, { id: 'db', row: 1, col: 2 }, 'DB'),
        ),
        createElement(Diagram.Box, { id: 'sink', row: 0, col: 4 }, 'Sink'),

        createElement(Diagram.Arrow, { from: 'client', to: 'services' }),
        createElement(Diagram.Arrow, { from: 'services:egress', to: 'sink' }),
      ],
    }),
  );

  assert.match(markup, /Services/);
  assert.match(markup, /data-diagram-port="services:egress"/);
  assert.match(markup, />OUT</);

  const paths = [
    ...markup.matchAll(/<path [^>]*d="([^"]+)"[^>]*stroke-width="1\.5"[^>]*>/g),
  ].map(firstCapture);
  assert.equal(paths.length, 2);
  assert.ok(
    paths.some((path) => /L 266 192/.test(path)),
    `client->services should land outside the group left boundary, got ${paths.join(' | ')}`,
  );
  assert.ok(
    paths.some((path) => /^M 804 192 /.test(path)),
    `services:egress->sink should start on the group egress port, got ${paths.join(' | ')}`,
  );
});

test('auto-routed dense crossing edges reserve separate route corridors', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'route-reservation-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          { id: 'top-left', row: 0, col: 0 },
          'Top left',
        ),
        createElement(
          Diagram.Box,
          { id: 'bottom-left', row: 2, col: 0 },
          'Bottom left',
        ),
        createElement(
          Diagram.Box,
          { id: 'top-right', row: 0, col: 2 },
          'Top right',
        ),
        createElement(
          Diagram.Box,
          { id: 'bottom-right', row: 2, col: 2 },
          'Bottom right',
        ),
        createElement(Diagram.Box, { id: 'center', row: 1, col: 1 }, 'Center'),

        createElement(Diagram.Arrow, { from: 'top-left', to: 'bottom-right' }),
        createElement(Diagram.Arrow, { from: 'bottom-left', to: 'top-right' }),
      ],
    }),
  );

  const edgePaths = [
    ...markup.matchAll(/<path [^>]*d="([^"]+)"[^>]*stroke-width="1\.5"[^>]*>/g),
  ].map(firstCapture);
  assert.equal(edgePaths.length, 2);

  const verticalsByPath = edgePaths.map((path) => verticalSegments(path));
  assert.ok(
    verticalsByPath.every((segments) => segments.length > 0),
    `each dense crossing route should stay orthogonal with a vertical corridor, got ${edgePaths.join(' | ')}`,
  );

  const longVerticals = verticalsByPath.map((segments) =>
    segments.reduce((longest, segment) => {
      const segmentLength = segment.y2 - segment.y1;
      const longestLength = longest.y2 - longest.y1;
      return segmentLength > longestLength ? segment : longest;
    }),
  );

  assert.notEqual(
    itemAt(longVerticals, 0).x,
    itemAt(longVerticals, 1).x,
    `dense crossing routes should not reuse the same vertical corridor, got ${JSON.stringify(longVerticals)}`,
  );
  assert.ok(
    !verticalSegmentsOverlap(
      itemAt(longVerticals, 0),
      itemAt(longVerticals, 1),
    ),
    `dense crossing routes should not overlap on a vertical segment, got ${JSON.stringify(longVerticals)}`,
  );
});

test('staggered edge labels avoid overlapping on a shared route corridor', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'label-deconflict-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          { id: 'source-a', row: 0, col: 0 },
          'Source A',
        ),
        createElement(
          Diagram.Box,
          { id: 'source-b', row: 1, col: 0 },
          'Source B',
        ),
        createElement(
          Diagram.Box,
          { id: 'source-c', row: 2, col: 0 },
          'Source C',
        ),
        createElement(
          Diagram.Box,
          { id: 'target-a', row: 0, col: 3 },
          'Target A',
        ),
        createElement(
          Diagram.Box,
          { id: 'target-b', row: 1, col: 3 },
          'Target B',
        ),
        createElement(
          Diagram.Box,
          { id: 'target-c', row: 2, col: 3 },
          'Target C',
        ),

        createElement(
          Diagram.Arrow,
          { from: 'source-a', to: 'target-a' },
          createElement(Diagram.Waypoint, { x: 260, y: 256 }),
          createElement(Diagram.Waypoint, { x: 760, y: 256 }),
          'Shared corridor A',
        ),
        createElement(
          Diagram.Arrow,
          { from: 'source-b', to: 'target-b' },
          createElement(Diagram.Waypoint, { x: 260, y: 256 }),
          createElement(Diagram.Waypoint, { x: 760, y: 256 }),
          'Shared corridor B',
        ),
        createElement(
          Diagram.Arrow,
          { from: 'source-c', to: 'target-c' },
          createElement(Diagram.Waypoint, { x: 260, y: 256 }),
          createElement(Diagram.Waypoint, { x: 760, y: 256 }),
          'Shared corridor C',
        ),
      ],
    }),
  );

  assert.match(markup, /data-diagram-edge-label="source-a-&gt;target-a"/);
  assert.match(markup, /data-diagram-edge-label="source-b-&gt;target-b"/);
  assert.match(markup, /data-diagram-edge-label="source-c-&gt;target-c"/);

  const labels = [
    {
      label: 'Shared corridor A',
      ...edgeLabelPoint(markup, 'Shared corridor A'),
    },
    {
      label: 'Shared corridor B',
      ...edgeLabelPoint(markup, 'Shared corridor B'),
    },
    {
      label: 'Shared corridor C',
      ...edgeLabelPoint(markup, 'Shared corridor C'),
    },
  ];

  assert.equal(
    new Set(labels.map((point) => `${point.x},${point.y}`)).size,
    3,
    `labels should be placed in distinct positions, got ${JSON.stringify(labels)}`,
  );
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      assert.ok(
        !labelBoxesOverlap(itemAt(labels, i), itemAt(labels, j)),
        `label boxes should not overlap, got ${JSON.stringify(labels)}`,
      );
    }
  }
});

test('edge label side hints place dense topology labels around their route segments', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-label-side-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          { id: 'router', row: 0, col: 0 },
          'Fritzbox Router',
        ),
        createElement(
          Diagram.Box,
          { id: 'dns', row: 0, col: 2 },
          'AdGuard Home',
        ),
        createElement(Diagram.Box, { id: 'git', row: 0, col: 3 }, 'Git Repo'),
        createElement(Diagram.Box, { id: 'argo', row: 2, col: 3 }, 'ArgoCD'),

        createElement(
          Diagram.Arrow,
          {
            from: 'router',
            to: 'dns',
            labelSide: 'below',
            labelOffset: 22,
            labelFrame: true,
          },
          'DNS Forwarder',
        ),
        createElement(
          Diagram.Arrow,
          { from: 'git', to: 'argo', labelSide: 'left', labelOffset: 26 },
          'Continuous deployment requests',
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /<text data-diagram-edge-label="router-&gt;dns"[^>]*\bx="415"[^>]*\by="150"[^>]*\btext-anchor="middle"[^>]*>[\s\S]*DNS Forwarder/,
    'horizontal edge label should honor labelSide="below" and labelOffset',
  );
  assert.match(
    markup,
    /<rect data-diagram-edge-label-frame="router-&gt;dns"[^>]*\bx="372"[^>]*\by="136.58"[^>]*\bwidth="86"[^>]*\bheight="19.85"[^>]*\brx="9.925"/,
    'framed edge labels should render a measured background rect behind the label',
  );
  assert.match(
    markup,
    /<text data-diagram-edge-label="git-&gt;argo"[^>]*\bx="874"[^>]*\by="251"[^>]*\btext-anchor="end"[^>]*>[\s\S]*Continuous deployment requests/,
    'vertical edge label should honor labelSide="left" with end alignment',
  );
});

test('edge labelLineGap controls dense multiline edge labels from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-label-line-gap-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'cert', row: 0, col: 0 }, 'Cert'),
        createElement(
          Diagram.Box,
          { id: 'gateway', row: 0, col: 1 },
          'Gateway',
        ),

        createElement(
          Diagram.Arrow,
          { from: 'cert', to: 'gateway', labelFrame: true, labelLineGap: 1 },
          createElement(Diagram.Line, null, 'Rotate keys'),
          createElement(Diagram.Line, null, 'every hour'),
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /data-diagram-edge-label-frame="cert-&gt;gateway"[^>]*data-diagram-edge-label-line-gap="1"[^>]*height="30.85"/,
    'framed multiline edge label should use font size plus labelLineGap for measured height',
  );
  assert.match(
    markup,
    /data-diagram-edge-label="cert-&gt;gateway"[^>]*data-diagram-edge-label-line-gap="1"[^>]*font-size="10"/,
    'edge label text should expose the requested compact line gap for black-box tests',
  );
  assert.match(
    markup,
    /<tspan[^>]*dy="11">every hour<\/tspan>/,
    'second label line should use compact 10px font plus 1px line gap spacing',
  );
});

test('edge labelSegment anchors labels to an explicit routed segment', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-label-segment-test',
      defaultMode: 'static',
      graph: {
        columns: [100, 100, 100],
        rows: [80, 80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'git', row: 0, col: 0, width: 40, height: 40 },
          'Git',
        ),
        createElement(
          Diagram.Box,
          { id: 'argo', row: 1, col: 2, width: 40, height: 40 },
          'Argo',
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'git',
            to: 'argo',
            labelSide: 'below',
            labelOffset: 18,
            labelSegment: 2,
          },

          createElement(Diagram.Waypoint, { x: 100, y: 120 }),
          createElement(Diagram.Waypoint, { x: 220, y: 120 }),
          'Continuous deployment requests',
        ),
      ],
    }),
  );

  const label = renderedEdgeLabelPoint(markup, 'git->argo');
  assert.match(
    markup,
    /data-diagram-edge-label="git-&gt;argo" data-diagram-edge-label-segment="2"/,
    'edge labels should expose the selected route segment for black-box tests',
  );
  assert.equal(
    label.x,
    160,
    'labelSegment should place the label at the selected segment midpoint x',
  );
  assert.equal(
    label.y,
    138,
    'labelSegment should apply side offset from the selected segment midpoint y',
  );
});

test('rejects negative edge labelLineGap values', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: REJECT_TITLE,
          defaultMode: 'static',
          children: [
            createElement(Diagram.Box, { id: 'cert', row: 0, col: 0 }, 'Cert'),
            createElement(
              Diagram.Box,
              { id: 'gateway', row: 0, col: 1 },
              'Gateway',
            ),
            createElement(
              Diagram.Arrow,
              { from: 'cert', to: 'gateway', labelLineGap: -1 },
              'Bad label spacing',
            ),
          ],
        }),
      ),
    /Diagram edge labelLineGap must be a non-negative finite number, got -1\./,
  );
});

test('rejects edge labelSegment outside the routed path', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'bad-edge-label-segment-test',
          defaultMode: 'static',
          children: [
            createElement(Diagram.Box, { id: 'git', row: 0, col: 0 }, 'Git'),
            createElement(Diagram.Box, { id: 'argo', row: 0, col: 1 }, 'Argo'),
            createElement(
              Diagram.Arrow,
              { from: 'git', to: 'argo', labelSegment: 2 },
              'Bad segment',
            ),
          ],
        }),
      ),
    /Diagram edge labelSegment 2 is outside routed path segments 0-0\./,
  );
});

test('edge labelT anchors labels to a routed path fraction from the public Diagram API', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-label-t-test',
      defaultMode: 'static',
      graph: {
        columns: [100, 100, 100],
        rows: [80],
        padX: 0,
        padY: 0,
        titleTopPad: 0,
      },
      children: [
        createElement(
          Diagram.Box,
          { id: 'source', row: 0, col: 0, width: 40, height: 40 },
          'Source',
        ),
        createElement(
          Diagram.Box,
          { id: 'target', row: 0, col: 2, width: 40, height: 40 },
          'Target',
        ),

        createElement(
          Diagram.Arrow,
          {
            from: 'source',
            to: 'target',
            labelT: 0.25,
            labelSide: 'below',
            labelOffset: 16,
          },
          'Quarter label',
        ),
      ],
    }),
  );

  assert.match(
    markup,
    /<path data-diagram-edge="source-&gt;target"[^>]*\sd="M 70 40 L 220 40"/,
    'fixture should expose a simple public routed path for labelT placement',
  );
  assert.match(
    markup,
    /<text data-diagram-edge-label="source-&gt;target" x="107\.5" y="56" text-anchor="middle"[^>]*>[\s\S]*Quarter label/,
    'labelT should place the label at 25% of the rendered edge path before side offset',
  );
});

test('background edge layer renders strokes below nodes and overlays above nodes', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-layer-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'source', row: 0, col: 0 }, 'Source'),
        createElement(Diagram.Box, { id: 'target', row: 0, col: 2 }, 'Target'),

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

test('edge badges attach icons and multi-line text to routed edge geometry', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'edge-badge-test',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          { id: 'public-internet', row: 0, col: 0, icon: 'internet' },
          'Public Internet',
        ),
        createElement(
          Diagram.Box,
          { id: 'cluster', row: 2, col: 0, icon: 'kubernetes' },
          'K3s Cluster',
        ),

        createElement(Diagram.Arrow, {
          from: 'public-internet',
          to: 'cluster',
          badgeIcon: 'tunnel',
          badgeLabel: ['Cloudflare Tunnel', '(Zero Trust)'],
          badgeSide: 'right',
          badgeOffset: 30,
        }),
      ],
    }),
  );

  assert.match(
    markup,
    /<g data-diagram-edge-badge="public-internet-&gt;cluster" transform="translate\(210 251\)"/,
    'badge should be placed from the routed edge midpoint plus badgeSide/badgeOffset',
  );
  assert.match(
    markup,
    /data-diagram-node-icon="tunnel"/,
    'edge badge should render the requested icon using the diagram icon vocabulary',
  );
  assert.match(markup, /Cloudflare Tunnel/);
  assert.match(markup, /\(Zero Trust\)/);
});

test('content viewBox reserves the drawn frame of an edge label below the graph', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'label-frame-viewbox-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'orders', row: 0, col: 0 }, 'Orders'),
        createElement(
          Diagram.Box,
          { id: 'billing', row: 0, col: 2 },
          'Billing',
        ),
        createElement(
          Diagram.Arrow,
          {
            from: 'orders',
            to: 'billing',
            labelSide: 'below',
            labelOffset: 60,
            labelFrame: true,
          },
          'invoices',
        ),
      ],
    }),
  );

  const viewBox = svgViewBox(markup);
  const node = markup.match(
    /<rect data-diagram-node="orders"[^>]*\by="(?<y>[\d.]+)"/,
  );
  const frame = markup.match(
    /<rect data-diagram-edge-label-frame="orders-&gt;billing"[^>]*\by="(?<y>[\d.]+)"[^>]*\bheight="(?<h>[\d.]+)"/,
  );
  assert.ok(
    node?.groups && frame?.groups,
    'node and label frame should render',
  );
  const pad = Number(node.groups.y) - viewBox.y;
  const frameBottom = Number(frame.groups.y) + Number(frame.groups.h);

  assert.equal(
    viewBox.y + viewBox.h,
    Math.ceil(frameBottom) + pad,
    'the viewBox bottom should sit one content pad below the drawn label frame',
  );
});

test('content viewBox reserves the drawn width of an edge badge with a lowercase label', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'badge-viewbox-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'edge', row: 0, col: 0 }, 'Edge'),
        createElement(
          Diagram.Box,
          { id: 'cluster', row: 2, col: 0 },
          'Cluster',
        ),
        createElement(Diagram.Arrow, {
          from: 'edge',
          to: 'cluster',
          badgeIcon: 'tunnel',
          badgeLabel: ['encrypted tunnel to the private cluster'],
          badgeSide: 'right',
          badgeOffset: 260,
        }),
      ],
    }),
  );

  const viewBox = svgViewBox(markup);
  const node = markup.match(
    /<rect data-diagram-node="edge"[^>]*\bx="(?<x>[\d.]+)"/,
  );
  const badge = markup.match(
    /<g data-diagram-edge-badge="edge-&gt;cluster" transform="translate\((?<tx>[\d.]+) [\d.]+\)"[^>]*><rect x="(?<x>-?[\d.]+)"[^>]* width="(?<w>[\d.]+)"/,
  );
  assert.ok(node?.groups && badge?.groups, 'node and badge should render');
  const pad = Number(node.groups.x) - viewBox.x;
  const badgeRight =
    Number(badge.groups.tx) + Number(badge.groups.x) + Number(badge.groups.w);

  assert.equal(
    viewBox.x + viewBox.w,
    Math.ceil(badgeRight) + pad,
    'the viewBox right edge should sit one content pad beyond the drawn badge',
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
          strokeWidth: 3,
          badgeIcon: 'tunnel',
          badgeLabel: ['Cloudflare Tunnel'],
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
    /data-diagram-edge-badge="dns-&gt;gateway"[\s\S]*Cloudflare Tunnel/,
    'tunnel channel should keep the routed edge badge attached',
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
              rowStart: 0,
              rowEnd: 0,
              colStart: 1,
              colEnd: 1,
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

test('automatically lays out an acyclic graph when nodes omit row and col', () => {
  const markup = render(
    createElement(SvgGraphDiagram, {
      title: 'auto-layout-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Box, { id: 'ingest' }, 'Ingest'),
        createElement(Diagram.Box, { id: 'parse' }, 'Parse'),
        createElement(Diagram.Box, { id: 'enrich' }, 'Enrich'),
        createElement(Diagram.Box, { id: 'validate' }, 'Validate'),
        createElement(Diagram.Box, { id: 'store' }, 'Store'),
        createElement(Diagram.Box, { id: 'dashboard' }, 'Dashboard'),

        createElement(Diagram.Arrow, { from: 'ingest', to: 'parse' }),
        createElement(Diagram.Arrow, { from: 'ingest', to: 'enrich' }),
        createElement(Diagram.Arrow, { from: 'parse', to: 'validate' }),
        createElement(Diagram.Arrow, { from: 'enrich', to: 'validate' }),
        createElement(Diagram.Arrow, { from: 'validate', to: 'store' }),
        createElement(Diagram.Arrow, { from: 'validate', to: 'dashboard' }),
      ],
    }),
  );

  const nodeRects = [
    ...markup.matchAll(
      /<rect data-diagram-node="[^"]+"[^>]* x="(\d+(?:\.\d+)?)" y="(\d+(?:\.\d+)?)" width="176" height="64" rx="16"[^>]*stroke-width="1\.5"/g,
    ),
  ].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));

  assert.deepEqual(
    nodeRects,
    [
      { x: 92, y: 96 },
      { x: 332, y: 96 },
      { x: 332, y: 224 },
      { x: 572, y: 96 },
      { x: 812, y: 96 },
      { x: 812, y: 224 },
    ],

    'automatic layout should rank DAG nodes left-to-right and stack siblings vertically',
  );
  assert.match(markup, /Ingest/);
  assert.match(markup, /Dashboard/);
});

test('rejects automatic layout for cyclic graphs', () => {
  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, {
          title: 'auto-cycle-test',
          defaultMode: 'static',
          children: [
            createElement(Diagram.Box, { id: 'a' }, 'A'),
            createElement(Diagram.Box, { id: 'b' }, 'B'),
            createElement(Diagram.Arrow, { from: 'a', to: 'b' }),
            createElement(Diagram.Arrow, { from: 'b', to: 'a' }),
          ],
        }),
      ),
    /automatic graph layout requires an acyclic graph/,
  );
});

test('svg outputs draw text in Geist with kerning on and ligatures off, the shaping their text is measured with', () => {
  // Arrange
  const outputs = [
    createElement(SvgGraphDiagram, {
      title: 'font-graph-test',
      defaultMode: 'static',
      children: [
        createElement(Diagram.Group, {
          id: 'backend',
          label: 'Backend',
          rowStart: 0,
          rowEnd: 0,
          colStart: 1,
          colEnd: 2,
        }),
        createElement(Diagram.Junction, { id: 'bus', row: 1, col: 1 }, 'Bus'),
        createElement(Diagram.Box, { id: 'router', row: 0, col: 0 }, 'Router'),
        createElement(
          Diagram.Box,
          { id: 'service', row: 0, col: 1 },
          'Service',
        ),
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
