import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  EdgeLayout,
  GraphLayout,
  GroupLayout,
  NodeLayout,
  TextRun,
} from '../lib/layouts/graph/graph-layout-result.ts';
import type {
  Box,
  DiagramNode,
  DiagramSide,
  Point,
} from '../lib/model/diagram-ir.ts';
import {
  type InvariantCode,
  assertSoundLayout,
  layoutViolations,
} from './sound-layout.ts';

function run(text: string, bounds: Box): TextRun {
  return {
    text,
    x: bounds.x,
    y: bounds.y + bounds.h,
    anchor: 'start',
    font: { face: 'sans', size: 12, weight: 500 },
    bounds,
  };
}

function nodeLayout(
  node: Omit<DiagramNode, 'label'>,
  box: Box,
  rest: Partial<NodeLayout> = {},
): NodeLayout {
  return {
    node: { label: node.id, ...node },
    box,
    visual: box,
    frames: [],
    radius: 8,
    text: [],
    bullets: [],
    ports: [],
    ...rest,
  };
}

function edgeLayout(
  from: string,
  to: string,
  [exitSide, entrySide]: [DiagramSide, DiagramSide],
  points: Point[],
  rest: Partial<EdgeLayout> = {},
): EdgeLayout {
  return {
    edge: { from, to },
    exitSide,
    entrySide,
    points,
    d: points
      .map(({ x, y }, index) => `${index ? 'L' : 'M'}${x} ${y}`)
      .join(' '),
    ...rest,
  };
}

/**
 * A group "cloud" with a title band holds a group "vpc" with the nodes "api"
 * and "db". Outside it sit "web" with a caption, a note that points at "web"
 * and has an edge to the group "cloud", and a junction "hub". The edge
 * from "web" to "hub" runs through the caption of "web", its own endpoint.
 * Every invariant holds.
 */
function soundLayout(): GraphLayout {
  return {
    viewBox: { x: 0, y: 0, w: 600, h: 400 },
    groups: [
      {
        group: { id: 'cloud', label: 'Cloud' },
        depth: 0,
        rect: { x: 20, y: 20, w: 260, h: 200 },
        band: { x: 20, y: 20, w: 260, h: 24 },
        label: [run('Cloud', { x: 30, y: 24, w: 60, h: 14 })],
        dividers: [],
        ports: [],
      },
      {
        group: { id: 'vpc', label: 'VPC', parent: 'cloud' },
        depth: 1,
        rect: { x: 40, y: 60, w: 220, h: 140 },
        label: [run('VPC', { x: 44, y: 64, w: 40, h: 12 })],
        dividers: [],
        ports: [],
      },
    ],
    nodes: [
      nodeLayout(
        { id: 'api', group: 'vpc' },
        { x: 60, y: 100, w: 80, h: 40 },
        {
          text: [run('API', { x: 70, y: 112, w: 40, h: 14 })],
          ports: [{ id: 'out', side: 'right', point: { x: 140, y: 120 } }],
        },
      ),
      nodeLayout({ id: 'db', group: 'vpc' }, { x: 180, y: 100, w: 60, h: 40 }),
      nodeLayout(
        { id: 'web' },
        { x: 380, y: 100, w: 80, h: 40 },
        {
          visual: { x: 380, y: 100, w: 80, h: 70 },
          caption: {
            box: { x: 380, y: 150, w: 80, h: 20 },
            framed: false,
            text: [run('public', { x: 390, y: 154, w: 50, h: 12 })],
          },
        },
      ),
      nodeLayout(
        { id: 'hub', kind: 'junction' },
        { x: 416, y: 296, w: 8, h: 8 },
      ),
      nodeLayout({ id: 'note' }, { x: 380, y: 20, w: 100, h: 30 }),
    ],
    edges: [
      edgeLayout(
        'api:out',
        'db',
        ['right', 'left'],
        [
          { x: 140, y: 120 },
          { x: 180, y: 120 },
        ],
        { label: { box: { x: 150, y: 104, w: 20, h: 10 }, text: [] } },
      ),
      edgeLayout(
        'web',
        'db',
        ['left', 'right'],
        [
          { x: 380, y: 120 },
          { x: 252, y: 120 },
        ],
        {
          label: { box: { x: 300, y: 104, w: 30, h: 10 }, text: [] },
          badge: { box: { x: 300, y: 124, w: 20, h: 12 }, text: [] },
        },
      ),
      edgeLayout(
        'db',
        'hub',
        ['bottom', 'left'],
        [
          { x: 210, y: 140 },
          { x: 210, y: 300 },
          { x: 420, y: 300 },
        ],
      ),
      edgeLayout(
        'note',
        'cloud',
        ['left', 'right'],
        [
          { x: 380, y: 35 },
          { x: 280, y: 35 },
        ],
      ),
      edgeLayout(
        'web',
        'hub',
        ['bottom', 'top'],
        [
          { x: 420, y: 140 },
          { x: 420, y: 300 },
        ],
      ),
    ],
    leaders: [
      {
        note: 'note',
        target: 'web',
        points: [
          { x: 430, y: 50 },
          { x: 430, y: 100 },
        ],
        d: 'M430 50 L430 100',
      },
    ],
  };
}

function nodeIn(layout: GraphLayout, id: string): NodeLayout {
  const found = layout.nodes.find(({ node }) => node.id === id);
  assert.ok(found, `the layout has a node "${id}"`);
  return found;
}

function groupIn(layout: GraphLayout, id: string): GroupLayout {
  const found = layout.groups.find(({ group }) => group.id === id);
  assert.ok(found, `the layout has a group "${id}"`);
  return found;
}

function edgeIn(layout: GraphLayout, from: string, to: string): EdgeLayout {
  const found = layout.edges.find(
    ({ edge }) => edge.from === from && edge.to === to,
  );
  assert.ok(found, `the layout has an edge ${from}->${to}`);
  return found;
}

type Expected = { invariant: InvariantCode; ids: string[] };

function assertViolations(
  layout: GraphLayout,
  expected: Expected[],
  message: RegExp,
) {
  const violations = layoutViolations(layout);
  assert.deepEqual(
    violations.map(({ invariant, ids }) => ({ invariant, ids })),
    expected,
  );
  assert.throws(() => assertSoundLayout(layout), message);
}

function assertOnlyViolation(
  layout: GraphLayout,
  expected: Expected,
  message: RegExp,
) {
  assertViolations(layout, [expected], message);
}

describe('assertSoundLayout', () => {
  test('a sound layout has no violations', () => {
    // Arrange
    const layout = soundLayout();

    // Act
    const violations = layoutViolations(layout);

    // Assert
    assert.deepEqual(violations, []);
    assert.doesNotThrow(() => assertSoundLayout(layout));
  });

  test('N1: a node that overlaps only the caption part of another node visual', () => {
    // Arrange
    const layout = soundLayout();
    layout.nodes.push(
      nodeLayout({ id: 'cache' }, { x: 440, y: 155, w: 40, h: 20 }),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'N1', ids: ['web', 'cache'] },
      /N1 nodes "web" and "cache" overlap by 300px²/,
    );
  });

  test('N2: node text that reaches into the inset of its box', () => {
    // Arrange
    const layout = soundLayout();
    nodeIn(layout, 'api').text = [run('API', { x: 62, y: 112, w: 40, h: 14 })];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'N2', ids: ['api'] },
      /N2 node "api" text "API" lies outside its box/,
    );
  });

  test('N2: caption text outside the caption box', () => {
    // Arrange
    const layout = soundLayout();
    nodeIn(layout, 'web').caption!.text = [
      run('public', { x: 390, y: 160, w: 50, h: 12 }),
    ];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'N2', ids: ['web'] },
      /N2 node "web" text "public" lies outside its caption box/,
    );
  });

  test('G1: a member node that sticks out of its group', () => {
    // Arrange
    const layout = soundLayout();
    nodeIn(layout, 'api').visual = { x: 60, y: 100, w: 80, h: 110 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G1', ids: ['vpc', 'api'] },
      /G1 group "vpc" does not contain its node "api"/,
    );
  });

  test('G1: a member node that covers the title band of its group', () => {
    // Arrange
    const layout = soundLayout();
    layout.nodes.push(
      nodeLayout(
        { id: 'gateway', group: 'cloud' },
        { x: 150, y: 30, w: 40, h: 20 },
      ),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G1', ids: ['cloud', 'gateway'] },
      /G1 node "gateway" covers the title band of group "cloud"/,
    );
  });

  test('G1: a group label outside its title band', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'cloud').label = [
      run('Cloud', { x: 30, y: 46, w: 60, h: 14 }),
    ];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G1', ids: ['cloud'] },
      /G1 group "cloud" label "Cloud" lies outside its band/,
    );
  });

  test('G2: a child group that covers the title band of its parent', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'vpc').rect = { x: 40, y: 30, w: 220, h: 170 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G2', ids: ['cloud', 'vpc'] },
      /G2 group "vpc" covers the title band of its parent "cloud"/,
    );
  });

  test('G2: a child group that sticks out of its parent', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'vpc').rect = { x: 40, y: 60, w: 250, h: 140 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G2', ids: ['cloud', 'vpc'] },
      /G2 group "vpc" lies outside its parent "cloud"/,
    );
  });

  test('G2: two top-level groups that overlap', () => {
    // Arrange
    const layout = soundLayout();
    layout.groups.push({
      group: { id: 'edge', label: 'Edge' },
      depth: 0,
      rect: { x: 260, y: 200, w: 100, h: 50 },
      label: [],
      dividers: [],
      ports: [],
    });

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G2', ids: ['cloud', 'edge'] },
      /G2 sibling groups "cloud" and "edge" overlap/,
    );
  });

  test('G3: a node outside a group that intersects the group', () => {
    // Arrange
    const layout = soundLayout();
    layout.nodes.push(
      nodeLayout({ id: 'cdn' }, { x: 270, y: 200, w: 40, h: 40 }),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G3', ids: ['cloud', 'cdn'] },
      /G3 node "cdn" is not in group "cloud" but intersects it/,
    );
  });

  test('E1: an edge with a diagonal segment', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'db', 'hub').points = [
      { x: 210, y: 140 },
      { x: 210, y: 280 },
      { x: 230, y: 300 },
      { x: 420, y: 300 },
    ];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E1', ids: ['db->hub#2'] },
      /E1 edge "db->hub#2" has a diagonal segment \(210,280\)→\(230,300\)/,
    );
  });

  test('E1: a leader with one point', () => {
    // Arrange
    const layout = soundLayout();
    layout.leaders[0]!.points = [{ x: 430, y: 50 }];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E1', ids: ['note->web'] },
      /E1 leader "note->web" has 1 points, fewer than 2/,
    );
  });

  test('E2: an edge that passes through a node that is not its endpoint', () => {
    // Arrange
    const layout = soundLayout();
    layout.nodes.push(
      nodeLayout({ id: 'cache' }, { x: 300, y: 280, w: 40, h: 40 }),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E2', ids: ['db->hub#2', 'cache'] },
      /E2 edge "db->hub#2" passes through node "cache"/,
    );
  });

  test('E2: a leader that passes through a node that is not its note or target', () => {
    // Arrange
    const layout = soundLayout();
    layout.nodes.push(
      nodeLayout({ id: 'cache' }, { x: 410, y: 60, w: 40, h: 20 }),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E2', ids: ['note->web', 'cache'] },
      /E2 leader "note->web" passes through node "cache"/,
    );
  });

  test('E3: an edge that passes through the title band of a group', () => {
    // Arrange
    const layout = soundLayout();
    const edge = edgeIn(layout, 'db', 'hub');
    edge.exitSide = 'top';
    edge.points = [
      { x: 210, y: 100 },
      { x: 210, y: 10 },
      { x: 300, y: 10 },
      { x: 300, y: 300 },
      { x: 420, y: 300 },
    ];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E3', ids: ['db->hub#2', 'cloud'] },
      /E3 edge "db->hub#2" passes through the title band of group "cloud"/,
    );
  });

  test('E4: an edge that starts off its exit side', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'web', 'db').points[0] = { x: 382, y: 120 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['web->db#1', 'web'] },
      /E4 edge "web->db#1" starts off the left side of "web"/,
    );
  });

  test('E4: an edge that stops further from its entry side than an arrow tip', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'web', 'db').points[1] = { x: 256, y: 120 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['web->db#1', 'db'] },
      /E4 edge "web->db#1" ends off the right side of "db"/,
    );
  });

  test('E4: an edge that leaves its port along the exit side, not out of it', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'api:out', 'db').exitSide = 'top';

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['api:out->db#0', 'api'] },
      /E4 edge "api:out->db#0" starts at an angle to the top side of "api"/,
    );
  });

  test('E5: an edge that ends off the centre of its junction', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'db', 'hub').points[2] = { x: 421, y: 300 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E5', ids: ['db->hub#2', 'hub'] },
      /E5 edge "db->hub#2" ends off the centre of junction "hub"/,
    );
  });

  test('L1: an edge label that covers a node', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'api:out', 'db').label!.box = {
      x: 170,
      y: 104,
      w: 20,
      h: 10,
    };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'L1', ids: ['api:out->db#0', 'db'] },
      /L1 the label of edge "api:out->db#0" covers node "db"/,
    );
  });

  test('L1: an edge label that covers the badge of an edge', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'web', 'db').label!.box = { x: 300, y: 112, w: 30, h: 16 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'L1', ids: ['web->db#1', 'web->db#1'] },
      /L1 the label of edge "web->db#1" covers the badge of edge "web->db#1"/,
    );
  });

  test('L2: an edge label far from its edge', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'web', 'db').label!.box = { x: 300, y: 60, w: 30, h: 10 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'L2', ids: ['web->db#1'] },
      /L2 the label of edge "web->db#1" sits 50px from its edge/,
    );
  });

  test('V1: a node outside the viewBox', () => {
    // Arrange
    const layout = soundLayout();
    layout.nodes.push(
      nodeLayout({ id: 'cache' }, { x: 560, y: 250, w: 60, h: 30 }),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'V1', ids: ['cache'] },
      /V1 node "cache" lies outside the viewBox/,
    );
  });
  test('E3: an edge may cross the title band of the group it connects to', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'note', 'cloud').points = [
      { x: 380, y: 35 },
      { x: 8, y: 35 },
      { x: 8, y: 30 },
      { x: 20, y: 30 },
    ];
    edgeIn(layout, 'note', 'cloud').entrySide = 'left';

    // Act
    const violations = layoutViolations(layout);

    // Assert
    assert.deepEqual(violations, []);
  });

  test('N2: a port label outside its node box', () => {
    // Arrange
    const layout = soundLayout();
    nodeIn(layout, 'api').ports[0]!.label = run('out', {
      x: 130,
      y: 142,
      w: 30,
      h: 10,
    });

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'N2', ids: ['api'] },
      /N2 node "api" text "out" lies outside its box/,
    );
  });

  test('G1: a title band that sticks out of its group', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'cloud').band = { x: 20, y: 14, w: 260, h: 30 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G1', ids: ['cloud'] },
      /G1 the title band of group "cloud" lies outside its rect/,
    );
  });

  test('G1: the label of a group with no title band outside its rect', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'vpc').label = [run('VPC', { x: 44, y: 50, w: 40, h: 12 })];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'G1', ids: ['vpc'] },
      /G1 group "vpc" label "VPC" lies outside its rect/,
    );
  });

  test('E4: an edge that starts on the line of its exit side but past the corner', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'db', 'hub').points = [
      { x: 250, y: 140 },
      { x: 250, y: 300 },
      { x: 420, y: 300 },
    ];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['db->hub#2', 'db'] },
      /E4 edge "db->hub#2" starts off the bottom side of "db"/,
    );
  });

  test('E4: an edge that starts outside its exit side, where only an arrow tip may stop', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'web', 'db').points[0] = { x: 376, y: 120 };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['web->db#1', 'web'] },
      /E4 edge "web->db#1" starts off the left side of "web"/,
    );
  });

  test('E4: an edge from a port the node does not have', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'api:out', 'db').edge.from = 'api:in';

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['api:in->db#0', 'api'] },
      /E4 edge "api:in->db#0" starts at "api:in", which the layout does not hold/,
    );
  });

  test('E4: an edge to a node the layout does not hold', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'web', 'db').edge.to = 'ghost';

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['web->ghost#1', 'ghost'] },
      /E4 edge "web->ghost#1" ends at "ghost", which the layout does not hold/,
    );
  });

  test('E5: an edge that starts off the centre of its junction', () => {
    // Arrange
    const layout = soundLayout();
    layout.edges.push(
      edgeLayout(
        'hub',
        'web',
        ['right', 'bottom'],
        [
          { x: 421, y: 300 },
          { x: 440, y: 300 },
          { x: 440, y: 140 },
        ],
      ),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E5', ids: ['hub->web#5', 'hub'] },
      /E5 edge "hub->web#5" starts off the centre of junction "hub"/,
    );
  });

  test('L1: an edge label that covers a caption the node visual leaves out', () => {
    // Arrange
    const layout = soundLayout();
    const web = nodeIn(layout, 'web');
    web.visual = web.box;
    edgeIn(layout, 'web', 'hub').label = {
      box: { x: 410, y: 152, w: 20, h: 10 },
      text: [],
    };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'L1', ids: ['web->hub#4', 'web'] },
      /L1 the label of edge "web->hub#4" covers the caption of node "web"/,
    );
  });

  test('L1: an edge label that covers the title band of a group', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'note', 'cloud').label = {
      box: { x: 250, y: 26, w: 20, h: 8 },
      text: [],
    };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'L1', ids: ['note->cloud#3', 'cloud'] },
      /L1 the label of edge "note->cloud#3" covers the title band of group "cloud"/,
    );
  });

  test('L1: an edge label that covers the label of a group', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'vpc').label = [
      run('VPC', { x: 150, y: 104, w: 20, h: 10 }),
    ];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'L1', ids: ['api:out->db#0', 'vpc'] },
      /L1 the label of edge "api:out->db#0" covers the label of group "vpc"/,
    );
  });

  test('V1: a group outside the viewBox', () => {
    // Arrange
    const layout = soundLayout();
    layout.groups.push({
      group: { id: 'zone', label: 'Zone' },
      depth: 0,
      rect: { x: 500, y: 300, w: 120, h: 50 },
      label: [],
      dividers: [],
      ports: [],
    });

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'V1', ids: ['zone'] },
      /V1 group "zone" lies outside the viewBox/,
    );
  });

  test('V1: an edge that bends outside the viewBox', () => {
    // Arrange
    const layout = soundLayout();
    edgeIn(layout, 'db', 'hub').points = [
      { x: 210, y: 140 },
      { x: 210, y: 410 },
      { x: 300, y: 410 },
      { x: 300, y: 300 },
      { x: 420, y: 300 },
    ];

    // Assert
    assertViolations(
      layout,
      [
        { invariant: 'V1', ids: ['db->hub#2'] },
        { invariant: 'V1', ids: ['db->hub#2'] },
      ],
      /V1 a point of edge "db->hub#2" lies outside the viewBox/,
    );
  });

  test('V1: a leader that bends outside the viewBox', () => {
    // Arrange
    const layout = soundLayout();
    layout.leaders[0]!.points = [
      { x: 480, y: 35 },
      { x: 610, y: 35 },
      { x: 610, y: 120 },
      { x: 460, y: 120 },
    ];

    // Assert
    assertViolations(
      layout,
      [
        { invariant: 'V1', ids: ['note->web'] },
        { invariant: 'V1', ids: ['note->web'] },
      ],
      /V1 a point of leader "note->web" lies outside the viewBox/,
    );
  });

  test('V1: an edge label and badge outside the viewBox', () => {
    // Arrange
    const layout = soundLayout();
    layout.viewBox = { x: 0, y: 0, w: 600, h: 310 };
    edgeIn(layout, 'db', 'hub').label = {
      box: { x: 300, y: 302, w: 30, h: 10 },
      text: [],
    };
    edgeIn(layout, 'db', 'hub').badge = {
      box: { x: 340, y: 302, w: 20, h: 10 },
      text: [],
    };

    // Assert
    assertViolations(
      layout,
      [
        { invariant: 'V1', ids: ['db->hub#2'] },
        { invariant: 'V1', ids: ['db->hub#2'] },
      ],
      /V1 the label of edge "db->hub#2" lies outside the viewBox\n.*V1 the badge of edge "db->hub#2" lies outside the viewBox/,
    );
  });

  test('V1: a caption the node visual leaves out, outside the viewBox', () => {
    // Arrange
    const layout = soundLayout();
    const web = nodeIn(layout, 'web');
    web.visual = web.box;
    web.caption = {
      box: { x: 380, y: 395, w: 80, h: 20 },
      framed: false,
      text: [run('public', { x: 390, y: 398, w: 50, h: 12 })],
    };

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'V1', ids: ['web'] },
      /V1 the caption of node "web" lies outside the viewBox/,
    );
  });

  test('E4: an edge to a group port may end at that port', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'cloud').ports = [
      { id: 'in', side: 'right', point: { x: 280, y: 100 } },
    ];
    const edge = edgeIn(layout, 'note', 'cloud');
    edge.edge.to = 'cloud:in';
    edge.points = [
      { x: 380, y: 35 },
      { x: 330, y: 35 },
      { x: 330, y: 100 },
      { x: 280, y: 100 },
    ];

    // Act
    const violations = layoutViolations(layout);

    // Assert
    assert.deepEqual(violations, []);
  });

  test('E4: an edge that ends beside the group port it names', () => {
    // Arrange
    const layout = soundLayout();
    groupIn(layout, 'cloud').ports = [
      { id: 'in', side: 'right', point: { x: 280, y: 140 } },
    ];
    const edge = edgeIn(layout, 'note', 'cloud');
    edge.edge.to = 'cloud:in';
    edge.points = [
      { x: 380, y: 35 },
      { x: 330, y: 35 },
      { x: 330, y: 100 },
      { x: 280, y: 100 },
    ];

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E4', ids: ['note->cloud:in#3', 'cloud'] },
      /E4 edge "note->cloud:in#3" ends off the right side of "cloud"/,
    );
  });

  test('E1: of two edges with the same ends, only the broken one is named, by its index', () => {
    // Arrange
    const layout = soundLayout();
    layout.edges.push(
      edgeLayout(
        'web',
        'db',
        ['left', 'right'],
        [
          { x: 380, y: 130 },
          { x: 300, y: 130 },
          { x: 260, y: 124 },
          { x: 240, y: 124 },
        ],
      ),
    );

    // Assert
    assertOnlyViolation(
      layout,
      { invariant: 'E1', ids: ['web->db#5'] },
      /E1 edge "web->db#5" has a diagonal segment/,
    );
  });
});
