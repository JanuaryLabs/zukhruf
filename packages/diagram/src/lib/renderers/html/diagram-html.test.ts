import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';

import {
  CanvasGraphDiagram,
  Diagram,
  HtmlGraphDiagram,
  SvgGraphDiagram,
} from '@zukhruf/diagram';

function firstCapture(match: RegExpMatchArray): string {
  const [whole, value] = match;
  assert.ok(value !== undefined, `expected ${whole} to capture a value`);
  return value;
}

function htmlNodeBox(markup: string, id: string) {
  const tag = markup.match(new RegExp(`<div data-diagram-node="${id}"[^>]*>`));
  assert.ok(tag, `html node ${id} should render`);
  const px = (property: string) => {
    const value = tag[0].match(
      new RegExp(`[;"]${property}:(-?[\\d.]+)(?:px)?`),
    );
    assert.ok(value, `html node ${id} should set ${property}`);
    return Number(value[1]);
  };
  return { x: px('left'), y: px('top'), w: px('width'), h: px('height') };
}

function svgNodeBox(markup: string, id: string) {
  const rect = markup.match(
    new RegExp(
      `<rect data-diagram-node="${id}"[^>]*\\bx="([\\d.-]+)"[^>]*\\by="([\\d.-]+)"[^>]*\\bwidth="([\\d.]+)"[^>]*\\bheight="([\\d.]+)"`,
    ),
  );
  assert.ok(rect, `svg node ${id} should render`);
  return {
    x: Number(rect[1]),
    y: Number(rect[2]),
    w: Number(rect[3]),
    h: Number(rect[4]),
  };
}

function edgePaths(markup: string) {
  return [
    ...markup.matchAll(/<path data-diagram-edge="[^"]+"[^>]*\sd="([^"]+)"/g),
  ].map(firstCapture);
}

test('html node boxes sit where the svg output draws them', () => {
  const shapes = [
    createElement(
      Diagram.Box,
      { key: 'question', id: 'question', row: 0, col: 0 },
      'Question',
    ),
    createElement(
      Diagram.Card,
      {
        key: 'agent',
        id: 'agent',
        row: 1,
        col: 1,
        description: 'Plans the query',
      },
      'Agent',
    ),
    createElement(
      Diagram.Box,
      { key: 'answer', id: 'answer', row: 0, col: 2 },
      'Answer',
    ),
    createElement(Diagram.Arrow, { key: 'q-a', from: 'question', to: 'agent' }),
    createElement(
      Diagram.Arrow,
      { key: 'a-a', from: 'agent', to: 'answer' },
      'rows',
    ),
  ];

  const svg = render(
    createElement(SvgGraphDiagram, {
      title: 'parity',
      defaultMode: 'static',
      children: shapes,
    }),
  );
  const html = render(
    createElement(HtmlGraphDiagram, {
      title: 'parity',
      defaultMode: 'static',
      children: shapes,
    }),
  );

  for (const id of ['question', 'agent', 'answer']) {
    assert.deepEqual(htmlNodeBox(html, id), svgNodeBox(svg, id), id);
  }
  assert.deepEqual(edgePaths(html), edgePaths(svg));
  assert.equal(edgePaths(html).length, 2);
});

test('Diagram.Content renders inside its node box', () => {
  const markup = render(
    createElement(HtmlGraphDiagram, {
      title: 'rich content',
      defaultMode: 'static',
      children: [
        createElement(
          Diagram.Box,
          { id: 'db', row: 0, col: 0 },
          'Database',

          createElement(Diagram.Content, {
            size: { w: 64, h: 28 },
            children: createElement('button', { type: 'button' }, 'Open'),
          }),
        ),
        createElement(Diagram.Box, { id: 'api', row: 0, col: 1 }, 'API'),
        createElement(Diagram.Arrow, { from: 'db', to: 'api' }),
      ],
    }),
  );

  const node = markup.match(
    /<div data-diagram-node="db"[\s\S]*?<div data-diagram-node-content="db"[^>]*><button type="button">Open<\/button><\/div>/,
  );
  assert.ok(node, 'content should render inside the db node');
  assert.doesNotMatch(
    markup.slice(markup.indexOf('data-diagram-node="api"')),
    /data-diagram-node-content/,
  );
});

test('svg and canvas outputs reject Diagram.Content', () => {
  const shapes = createElement(
    Diagram.Box,
    { id: 'db', row: 0, col: 0 },
    'Database',

    createElement(Diagram.Content, {
      size: { w: 64, h: 28 },
      children: createElement('button', { type: 'button' }, 'Open'),
    }),
  );

  assert.throws(
    () =>
      render(
        createElement(SvgGraphDiagram, { title: 'svg', children: shapes }),
      ),
    /Diagram\.Content needs HtmlGraphDiagram; SvgGraphDiagram draws text only/,
  );
  assert.throws(
    () =>
      render(
        createElement(CanvasGraphDiagram, {
          title: 'canvas',
          children: shapes,
        }),
      ),
    /Diagram\.Content needs HtmlGraphDiagram; CanvasGraphDiagram draws text only/,
  );
});

test('Diagram.Content goes only inside a box, once', () => {
  assert.throws(
    () =>
      render(
        createElement(HtmlGraphDiagram, {
          title: 'label host',
          children: createElement(
            Diagram.Label,
            { id: 'note', row: 0, col: 0 },
            'Note',

            createElement(Diagram.Content, {
              size: { w: 64, h: 28 },
              children: createElement('span', null, 'extra'),
            }),
          ),
        }),
      ),
    /Diagram\.Content goes inside Diagram\.Box, Diagram\.Card or Diagram\.Node, not Diagram\.label/,
  );
  assert.throws(
    () =>
      render(
        createElement(HtmlGraphDiagram, {
          title: 'two contents',
          children: createElement(
            Diagram.Box,
            { id: 'db', row: 0, col: 0 },
            'Database',

            createElement(Diagram.Content, {
              size: { w: 64, h: 28 },
              children: createElement('span', null, 'one'),
            }),
            createElement(Diagram.Content, {
              size: { w: 64, h: 28 },
              children: createElement('span', null, 'two'),
            }),
          ),
        }),
      ),
    /Diagram\.box accepts one Diagram\.Content/,
  );
});

function elementsWith(markup: string, attribute: string) {
  const elements: string[] = [];
  const opening = new RegExp(
    `<([a-z]+)\\s[^>]*\\b${attribute}="[^"]*"[^>]*>`,
    'g',
  );
  for (const open of markup.matchAll(opening)) {
    const [tag, name] = open;
    if (tag.endsWith('/>')) {
      elements.push(tag);
      continue;
    }
    const nested = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'g');
    nested.lastIndex = open.index;
    let depth = 0;
    for (let match = nested.exec(markup); match; match = nested.exec(markup)) {
      if (match[2]) continue;
      depth += match[1] ? -1 : 1;
      if (depth === 0) {
        elements.push(markup.slice(open.index, nested.lastIndex));
        break;
      }
    }
  }
  return elements;
}

test('html output draws ports, captions, stacks, special nodes and notes as the svg output does', () => {
  const shapes = [
    createElement(
      Diagram.Box,
      {
        key: 'api',
        id: 'api',
        row: 0,
        col: 0,
        caption: 'Public API',
        ports: [
          { id: 'http', side: 'left', label: 'HTTP' },
          { id: 'events', side: 'right', label: 'EVT', accent: true },
        ],
      },

      'API',
    ),
    createElement(
      Diagram.Card,
      {
        key: 'vm',
        id: 'vm',
        row: 0,
        col: 1,
        stack: 3,
        description: 'Runs jobs',
      },
      'VM',
    ),
    createElement(
      Diagram.Group,
      {
        key: 'services',
        id: 'services',
        label: 'Services',
        row: 2,
        col: 0,
        rowSpan: 1,
        colSpan: 2,
        ports: [{ id: 'ingress', side: 'top', label: 'Ingress' }],
      },
      createElement(
        Diagram.Box,
        { key: 'gateway', id: 'gateway', row: 2, col: 0 },
        'Gateway',
      ),
    ),
    createElement(Diagram.Appliance, {
      key: 'router',
      id: 'router',
      row: 1,
      col: 0,
      tone: 'slate',
      texture: 'none',
      appliancePorts: 5,
      antenna: true,
      caption: 'Fritzbox Router',
      captionSide: 'bottom',
      ports: [{ id: 'wan', side: 'right', label: 'WAN' }],
    }),
    createElement(
      Diagram.Connector,
      {
        key: 'tunnel',
        id: 'tunnel',
        row: 1,
        col: 1,
        icon: 'tunnel',
        tone: 'blue',
        texture: 'none',
      },

      createElement(Diagram.Line, null, 'Cloudflare Tunnel'),
      createElement(Diagram.Line, { textColor: 'dim' }, '(Zero Trust)'),
    ),
    createElement(
      Diagram.Marker,
      { key: 'repo', id: 'repo', row: 0, col: 2, icon: 'git' },
      'Git Repo',
    ),
    createElement(Diagram.Junction, {
      key: 'bus',
      id: 'bus',
      row: 1,
      col: 2,
      tone: 'blue',
    }),
    createElement(Diagram.Arrow, {
      key: 'api-router',
      from: 'api',
      to: 'router',
    }),
    createElement(Diagram.Arrow, {
      key: 'router-tunnel',
      from: 'router:wan',
      to: 'tunnel',
    }),
    createElement(Diagram.Arrow, {
      key: 'tunnel-bus',
      from: 'tunnel',
      to: 'bus',
      headless: true,
    }),
    createElement(Diagram.Arrow, {
      key: 'bus-ingress',
      from: 'bus',
      to: 'services:ingress',
    }),
    createElement(
      Diagram.Note,
      { key: 'note', id: 'note', row: 0, col: 3, target: 'vm' },
      'Owned by data',
    ),
  ];

  const svg = render(
    createElement(SvgGraphDiagram, {
      title: 'features',
      defaultMode: 'static',
      children: shapes,
    }),
  );
  const html = render(
    createElement(HtmlGraphDiagram, {
      title: 'features',
      defaultMode: 'static',
      children: shapes,
    }),
  );

  for (const attribute of [
    'data-diagram-port',
    'data-diagram-node-caption',
    'data-diagram-node-stack',
    'data-diagram-appliance',
    'data-diagram-connector',
    'data-diagram-marker',
    'data-diagram-junction',

    'data-diagram-note',
    'data-diagram-note-leader',
  ]) {
    const drawn = elementsWith(svg, attribute).sort();
    assert.notEqual(drawn.length, 0, `svg should draw ${attribute}`);
    assert.deepEqual(elementsWith(html, attribute).sort(), drawn, attribute);
  }
});

test('html output keeps natural size and applies viewport zoom', () => {
  const markup = render(
    createElement(HtmlGraphDiagram, {
      title: 'zoomed',
      defaultMode: 'static',
      viewport: { zoom: 1.5 },
      children: createElement(Diagram.Box, { id: 'a', row: 0, col: 0 }, 'A'),
    }),
  );

  assert.match(markup, /data-diagram-viewport-zoom="1.5"/);
  assert.match(
    markup,
    /<div class="relative mx-auto" style="width:[\d.]+px;height:[\d.]+px;zoom:1.5" data-diagram-html="graph">/,
  );
  assert.match(markup, /class="w-full overflow-x-auto"/);
});

test('the html output draws text in Geist with kerning on and ligatures off, the shaping its text is measured with', () => {
  // Act
  const markup = render(
    createElement(HtmlGraphDiagram, {
      title: 'font-html-test',
      defaultMode: 'static',
      children: [
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
  ).replaceAll('&#x27;', "'");

  // Assert
  assert.match(
    markup,
    /<div role="group"[^>]*style="font-kerning:normal;font-variant-ligatures:none"/,
  );
  const families = [...markup.matchAll(/font-family(?:="|:)([^";]*)/g)].map(
    ([, family]) => family,
  );
  assert.ok(families.length > 0, 'the diagram draws text');
  for (const family of families) {
    assert.match(family ?? '', /^'Geist (Sans|Mono)',/);
  }
});

test('html output draws edge badges as the svg output does', () => {
  const shapes = [
    createElement(
      Diagram.Box,
      { key: 'edge', id: 'edge', row: 0, col: 0 },
      'Edge',
    ),
    createElement(
      Diagram.Box,
      { key: 'cluster', id: 'cluster', row: 1, col: 0 },
      'Cluster',
    ),
    createElement(Diagram.Arrow, {
      key: 'tunnel',
      from: 'edge',
      to: 'cluster',
      badgeIcon: 'tunnel',
      badgeLabel: 'Badge',
    }),
  ];

  const svg = render(
    createElement(SvgGraphDiagram, {
      title: 'badges',
      defaultMode: 'static',
      children: shapes,
    }),
  );
  const html = render(
    createElement(HtmlGraphDiagram, {
      title: 'badges',
      defaultMode: 'static',
      children: shapes,
    }),
  );

  const drawn = elementsWith(svg, 'data-diagram-edge-badge');
  assert.notEqual(drawn.length, 0, 'svg should draw the badge');
  assert.deepEqual(elementsWith(html, 'data-diagram-edge-badge'), drawn);
});
