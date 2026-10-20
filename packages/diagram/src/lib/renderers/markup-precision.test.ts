import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';

import { Diagram, HtmlGraphDiagram, SvgGraphDiagram } from '@zukhruf/diagram';

/**
 * Every number with more than two decimals, or with an exponent, in an
 * attribute value of the diagram's own markup: the `<svg role="img">` of the
 * svg output, or the `data-diagram-html` root of the html output. The frame
 * around them carries theme colors, which are not coordinates.
 */
function noisyNumbers(markup: string): string[] {
  const start = markup.search(
    /<svg [^>]*role="img"|<div [^>]*data-diagram-html=/,
  );
  assert.notEqual(start, -1, 'the markup should hold the diagram');
  return [...markup.slice(start).matchAll(/="([^"]*)"/g)].flatMap(
    ([, value = '']) => value.match(/\d\.\d{3,}|\d(?:\.\d+)?e[-+]?\d+/g) ?? [],
  );
}

test('r1 a card with a description and bulleted items draws every coordinate with at most two decimals', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Card,
      {
        key: 'vm',
        id: 'vm',
        row: 0,
        col: 0,
        description: 'Runs jobs',
        items: ['32GB RAM', '4 cores', '2 TB disk'],
      },
      'VM',
    ),
  ];

  // Act
  const svg = render(
    createElement(SvgGraphDiagram, {
      title: 'card',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.deepEqual(noisyNumbers(svg), []);
});

test('r2 an edge with a framed label, and an edge with an icon badge of two lines, draw every coordinate with at most two decimals', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Box,
      { key: 'api', id: 'api', row: 0, col: 0 },
      'API',
    ),
    createElement(Diagram.Box, { key: 'db', id: 'db', row: 0, col: 1 }, 'DB'),
    createElement(
      Diagram.Box,
      { key: 'cache', id: 'cache', row: 1, col: 0 },
      'Cache',
    ),
    createElement(
      Diagram.Arrow,
      { key: 'api-db', from: 'api', to: 'db', labelFrame: true },
      'reads rows',
    ),
    createElement(Diagram.Arrow, {
      key: 'api-cache',
      from: 'api',
      to: 'cache',
      badgeIcon: 'tunnel',
      badgeLabel: ['Cloudflare', 'Tunnel'],
    }),
  ];

  // Act
  const svg = render(
    createElement(SvgGraphDiagram, {
      title: 'edges',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.deepEqual(noisyNumbers(svg), []);
});

test('r3 every node kind, with captions, stacks, ports, a note and its leader, and nested groups with title bands and dividers, draws every coordinate with at most two decimals', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Group,
      {
        key: 'edge',
        id: 'edge',
        label: ['Edge network', 'eu-west'],
        titleBand: true,
        dividers: true,
        row: 0,
        col: 0,
        rowSpan: 2,
        colSpan: 2,
        ports: [{ id: 'in', side: 'top', label: 'IN' }],
      },
      createElement(
        Diagram.Box,
        {
          key: 'api',
          id: 'api',
          row: 0,
          col: 0,
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
          icon: 'server',
          stack: 3,
          stackDirection: 'up-right',
          description: ['Runs jobs', 'nightly'],
          items: ['32GB RAM', '4 cores'],
        },
        'VM',
      ),
      createElement(
        Diagram.Group,
        {
          key: 'inner',
          id: 'inner',
          label: 'Inner',
          titleBand: true,
          row: 1,
          col: 0,
          colSpan: 2,
        },
        createElement(
          Diagram.Box,
          { key: 'worker', id: 'worker', row: 1, col: 0, caption: 'Queue' },
          'Worker',
        ),
      ),
    ),
    createElement(Diagram.Appliance, {
      key: 'router',
      id: 'router',
      row: 2,
      col: 0,
      caption: 'Router',
    }),
    createElement(
      Diagram.Connector,
      { key: 'tunnel', id: 'tunnel', row: 2, col: 1, icon: 'tunnel' },
      'Tunnel',
    ),
    createElement(
      Diagram.Marker,
      { key: 'repo', id: 'repo', row: 0, col: 2, icon: 'git' },
      'Git Repo',
    ),
    createElement(Diagram.Junction, { key: 'bus', id: 'bus', row: 2, col: 2 }),
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
      { key: 'note', id: 'note', row: 0, col: 3, target: 'repo' },
      ['Owned by data', 'since 2024'],
    ),
  ];

  // Act
  const svg = render(
    createElement(SvgGraphDiagram, {
      title: 'every kind',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.deepEqual(noisyNumbers(svg), []);
});

test('r4 the html output places every node frame, icon, text run, bullet and content box with at most two decimals', () => {
  // Arrange
  const children = [
    createElement(
      Diagram.Group,
      {
        key: 'edge',
        id: 'edge',
        label: 'Edge network',
        titleBand: true,
        row: 0,
        col: 0,
        colSpan: 2,
      },
      createElement(
        Diagram.Card,
        {
          key: 'vm',
          id: 'vm',
          row: 0,
          col: 0,
          icon: 'server',
          stack: 2,
          description: ['Runs jobs', 'nightly'],
          items: ['32GB RAM', '4 cores', '2 TB disk'],
          caption: 'Proxmox',
        },
        'VM',
      ),
      createElement(
        Diagram.Box,
        { key: 'db', id: 'db', row: 0, col: 1 },
        'Database',
        createElement(Diagram.Content, {
          size: { w: 64.5, h: 28 },
          children: createElement('button', { type: 'button' }, 'Open'),
        }),
      ),
    ),
    createElement(
      Diagram.Arrow,
      { key: 'vm-db', from: 'vm', to: 'db', labelFrame: true },
      'writes',
    ),
  ];

  // Act
  const html = render(
    createElement(HtmlGraphDiagram, {
      title: 'html',
      defaultMode: 'static',
      children,
    }),
  );

  // Assert
  assert.deepEqual(noisyNumbers(html), []);
});
