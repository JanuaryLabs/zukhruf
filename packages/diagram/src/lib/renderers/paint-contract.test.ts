import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';

import { Diagram, HtmlGraphDiagram, SvgGraphDiagram } from '@zukhruf/diagram';

import { compileGraph } from '../compiler/diagram-compile.ts';
import type {
  GraphLayout,
  NodeLayout,
  TextRun,
} from '../layouts/graph/graph-layout-result.ts';
import { legacyGraphLayout } from '../layouts/graph/legacy-graph-layout.ts';

function scene() {
  return [
    createElement(Diagram.Group, {
      key: 'edge',
      id: 'edge',
      label: 'Edge network',
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 1,
      ports: [{ id: 'in', side: 'top', label: 'IN' }],
    }),
    createElement(
      Diagram.Box,
      {
        key: 'api',
        id: 'api',
        row: 0,
        col: 0,
        group: 'edge',
        caption: 'Public API',
        captionFrame: true,
        ports: [{ id: 'http', side: 'left', label: 'HTTP' }],
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
        group: 'edge',
        width: 232,
        height: 176,
        icon: 'server',
        stack: 3,
        description: 'Runs jobs',
        items: ['32GB RAM', '4 cores'],
      },
      'VM',
    ),
    createElement(Diagram.Appliance, {
      key: 'router',
      id: 'router',
      row: 1,
      col: 0,
      width: 116,
      height: 72,
      caption: 'Router',
    }),
    createElement(
      Diagram.Connector,
      {
        key: 'tunnel',
        id: 'tunnel',
        row: 1,
        col: 1,
        width: 152,
        height: 40,
        icon: 'tunnel',
      },
      'Tunnel',
    ),
    createElement(
      Diagram.Marker,
      {
        key: 'repo',
        id: 'repo',
        row: 0,
        col: 2,
        icon: 'git',
        width: 72,
        height: 76,
      },
      'Git Repo',
    ),
    createElement(Diagram.Junction, { key: 'bus', id: 'bus', row: 1, col: 2 }),
    createElement(
      Diagram.Arrow,
      { key: 'api-vm', from: 'api', to: 'vm', labelFrame: true },
      'calls',
    ),
    createElement(Diagram.Arrow, {
      key: 'router-tunnel',
      from: 'router',
      to: 'tunnel',
      badgeIcon: 'tunnel',
      badgeLabel: 'Badge',
    }),
    createElement(Diagram.Arrow, {
      key: 'tunnel-bus',
      from: 'tunnel',
      to: 'bus',
    }),
    createElement(
      Diagram.Note,
      { key: 'note', target: 'repo', anchor: 'right', leader: true },
      'Owned by data',
    ),
  ];
}

function attributes(tag: string): Map<string, string> {
  return new Map(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(
      ([, name = '', value = '']) => [name, value],
    ),
  );
}

function openingTag(markup: string, element: string, attr: string, id: string) {
  const tag = markup.match(
    new RegExp(
      `<${element} [^>]*\\b${attr}="${id.replaceAll('>', '&gt;')}"[^>]*>`,
    ),
  );
  assert.ok(tag, `${element}[${attr}="${id}"] should render`);
  return attributes(tag[0]);
}

function numberAttr(tag: Map<string, string>, name: string) {
  const value = tag.get(name);
  assert.ok(value !== undefined, `the tag should set ${name}`);
  return Number(value);
}

function nodeLayout(layout: GraphLayout, id: string): NodeLayout {
  const node = layout.nodes.find((candidate) => candidate.node.id === id);
  assert.ok(node, `the layout should hold node ${id}`);
  return node;
}

function firstRun(runs: TextRun[] | undefined, what: string): TextRun {
  const [run] = runs ?? [];
  assert.ok(run, `the layout should hold text for ${what}`);
  return run;
}

function px(source: string, property: string): number {
  const value = source.match(new RegExp(`[;"]${property}:(-?[\\d.]+)px`));
  assert.ok(value?.[1], `${source} should set ${property}`);
  return Number(value[1]);
}

function htmlRunPosition(markup: string, text: string) {
  const span = markup.match(
    new RegExp(`<span [^>]*style="([^"]*)"[^>]*>${text}</span>`),
  );
  assert.ok(span?.[1], `the html output should draw "${text}"`);
  const style = `;${span[1]}`;
  return { x: px(style, 'left'), y: px(style, 'top') };
}

function textPoint(tag: Map<string, string>) {
  return { x: numberAttr(tag, 'x'), y: numberAttr(tag, 'y') };
}

test('the svg output paints every box, text run and edge path at the position its GraphLayout holds', () => {
  // Arrange
  const children = scene();
  const layout = legacyGraphLayout(compileGraph(children, undefined));

  // Act
  const svg = render(
    createElement(SvgGraphDiagram, {
      title: 'paint contract',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const { viewBox } = layout;
  assert.equal(
    attributes(svg.match(/<svg [^>]*>/)?.[0] ?? '').get('viewBox'),
    `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`,
  );
  for (const id of ['api', 'vm', 'tunnel', 'repo']) {
    const rect = openingTag(svg, 'rect', 'data-diagram-node', id);
    const { box } = nodeLayout(layout, id);
    assert.deepEqual(
      {
        x: numberAttr(rect, 'x'),
        y: numberAttr(rect, 'y'),
        w: numberAttr(rect, 'width'),
        h: numberAttr(rect, 'height'),
      },
      box,
      id,
    );
  }
  const vm = nodeLayout(layout, 'vm');
  vm.frames.forEach((frame, i) => {
    const rect = openingTag(
      svg,
      'rect',
      'data-diagram-node-stack',
      `vm:${i + 1}`,
    );
    assert.deepEqual(
      {
        x: numberAttr(rect, 'x'),
        y: numberAttr(rect, 'y'),
        w: numberAttr(rect, 'width'),
        h: numberAttr(rect, 'height'),
      },
      frame,
    );
  });
  const description = vm.text.find((run) => run.text === 'Runs jobs');
  assert.ok(description);
  assert.deepEqual(
    textPoint(openingTag(svg, 'text', 'data-diagram-node-description', 'vm')),
    { x: description.x, y: description.y },
  );
  const api = nodeLayout(layout, 'api');
  const caption = firstRun(api.caption?.text, 'the api caption');
  assert.deepEqual(
    textPoint(openingTag(svg, 'text', 'data-diagram-node-caption', 'api')),
    { x: caption.x, y: caption.y },
  );
  const port = api.ports.find(({ id }) => id === 'http');
  assert.ok(port);
  const portGroup = svg.match(
    /<g data-diagram-port="api:http"[^>]*><circle ([^>]*)>/,
  );
  assert.ok(portGroup?.[1], 'the api port should render');
  const circle = attributes(portGroup[1]);
  assert.deepEqual(
    { x: numberAttr(circle, 'cx'), y: numberAttr(circle, 'cy') },
    port.point,
  );
  const repo = nodeLayout(layout, 'repo');
  assert.deepEqual(
    textPoint(openingTag(svg, 'text', 'data-diagram-marker-label', 'repo')),
    { x: firstRun(repo.text, 'repo').x, y: firstRun(repo.text, 'repo').y },
  );
  const tunnel = nodeLayout(layout, 'tunnel');
  assert.deepEqual(
    textPoint(
      openingTag(svg, 'text', 'data-diagram-connector-label', 'tunnel'),
    ),
    {
      x: firstRun(tunnel.text, 'tunnel').x,
      y: firstRun(tunnel.text, 'tunnel').y,
    },
  );
  const routerBody = nodeLayout(layout, 'router').appliance?.body ?? [];
  assert.equal(
    openingTag(svg, 'path', 'data-diagram-appliance-body', 'router').get('d'),
    `${routerBody.map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')} Z`,
  );
  const group = layout.groups.find(({ group: { id } }) => id === 'edge');
  assert.ok(group);
  assert.deepEqual(
    textPoint(openingTag(svg, 'text', 'data-diagram-group-label', 'edge')),
    {
      x: firstRun(group.label, 'the group').x,
      y: firstRun(group.label, 'the group').y,
    },
  );
  for (const { edge, d, label } of layout.edges) {
    const id = `${edge.from}->${edge.to}`;
    assert.equal(
      openingTag(svg, 'path', 'data-diagram-edge', id).get('d'),
      d,
      id,
    );
    if (label) {
      const run = firstRun(label.text, id);
      assert.deepEqual(
        textPoint(openingTag(svg, 'text', 'data-diagram-edge-label', id)),
        { x: run.x, y: run.y },
      );
    }
  }
  const [leader] = layout.leaders;
  assert.ok(leader, 'the note should have a leader');
  const line = openingTag(
    svg,
    'line',
    'data-diagram-annotation-leader',
    'repo:right',
  );
  assert.deepEqual(
    [
      { x: numberAttr(line, 'x1'), y: numberAttr(line, 'y1') },
      { x: numberAttr(line, 'x2'), y: numberAttr(line, 'y2') },
    ],
    leader.points,
  );
  const note = firstRun(nodeLayout(layout, leader.note).text, 'the note');
  assert.deepEqual(
    textPoint(openingTag(svg, 'text', 'data-diagram-annotation', 'repo:right')),
    { x: note.x, y: note.y },
  );
});

test('the html output places each node box and text run at the position its GraphLayout holds, as the svg output does', () => {
  // Arrange
  const children = scene();
  const layout = legacyGraphLayout(compileGraph(children, undefined));

  // Act
  const html = render(
    createElement(HtmlGraphDiagram, {
      title: 'paint contract',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  const { viewBox } = layout;
  for (const id of ['api', 'vm']) {
    const { box, text } = nodeLayout(layout, id);
    const div = html.match(
      new RegExp(
        `<div data-diagram-node="${id}"[^>]*>([\\s\\S]*?)</div>(?=<div data-diagram-node=|<svg)`,
      ),
    );
    assert.ok(div, `html node ${id} should render`);
    const style = div[0].slice(0, div[0].indexOf('>'));
    assert.deepEqual(
      {
        x: px(style, 'left'),
        y: px(style, 'top'),
        w: px(style, 'width'),
        h: px(style, 'height'),
      },
      { x: box.x - viewBox.x, y: box.y - viewBox.y, w: box.w, h: box.h },
      id,
    );
    for (const run of text) {
      assert.deepEqual(
        htmlRunPosition(div[0], run.text),
        { x: run.bounds.x - box.x, y: run.bounds.y - box.y },
        `${id} "${run.text}"`,
      );
    }
  }
  for (const { edge, d } of layout.edges) {
    const id = `${edge.from}->${edge.to}`;
    assert.equal(
      openingTag(html, 'path', 'data-diagram-edge', id).get('d'),
      d,
      id,
    );
  }
});
