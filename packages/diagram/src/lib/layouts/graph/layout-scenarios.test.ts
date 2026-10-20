import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertSoundLayout } from '../../../testing/sound-layout.ts';
import type {
  Box,
  DiagramEdge,
  DiagramGraphIR,
  DiagramGroup,
  DiagramNode,
} from '../../model/diagram-ir.ts';
import type { GraphLayout } from './graph-layout-result.ts';
import { layoutGraph } from './layout.ts';
import { measureEdgeLabel, measureNode } from './measure.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

function graph(spec: {
  nodes: DiagramNode[];
  groups?: DiagramGroup[];
  edges?: DiagramEdge[];
}): DiagramGraphIR {
  return {
    nodes: spec.nodes,
    edges: spec.edges ?? [],
    groups: spec.groups ?? [],
    annotations: [],
    guides: [],
  };
}

function box(layout: GraphLayout, id: string): Box {
  const found = layout.nodes.find((nodeLayout) => nodeLayout.node.id === id);
  assert.ok(found, `node "${id}" is in the layout`);
  return found.box;
}

function rect(layout: GraphLayout, id: string): Box {
  const found = layout.groups.find(
    (groupLayout) => groupLayout.group.id === id,
  );
  assert.ok(found, `group "${id}" is in the layout`);
  return found.rect;
}

function close(actual: number, expected: number, what: string) {
  assert.ok(
    Math.abs(actual - expected) < 0.01,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

function cell(
  id: string,
  row: number,
  col: number,
  rest: Partial<DiagramNode>,
): DiagramNode {
  return { id, label: '', row, col, ...rest };
}

describe('layoutGraph rejects a grid it cannot draw', () => {
  test('a fractional row names the node and the value', () => {
    // Arrange
    const ir = graph({
      nodes: [{ id: 'laptop', label: 'Laptop', row: 0.7, col: 0 }],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message: 'Diagram node "laptop" row 0.7 must be a non-negative integer.',
    });
  });

  test('a negative column names the node and the value', () => {
    // Arrange
    const ir = graph({ nodes: [{ id: 'isp', label: 'ISP', row: 0, col: -1 }] });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message: 'Diagram node "isp" col -1 must be a non-negative integer.',
    });
  });

  test('a span below 1 names the node and the value', () => {
    // Arrange
    const ir = graph({
      nodes: [{ id: 'istio', label: 'Istio', row: 0, col: 0, colSpan: 0 }],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram node "istio" colSpan 0 must be an integer of at least 1.',
    });
  });

  test('a group with a span but no cell names the group', () => {
    // Arrange
    const ir = graph({
      nodes: [{ id: 'plan', label: 'Plan', row: 0, col: 3, group: 'lane' }],
      groups: [{ id: 'lane', label: 'Lane', colSpan: 5 }],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram group "lane" row undefined must be a non-negative integer.',
    });
  });

  test('two nodes in one cell name both nodes and the cell', () => {
    // Arrange
    const ir = graph({
      nodes: [
        { id: 'metallb', label: 'MetalLB', row: 2, col: 2, colSpan: 2 },
        { id: 'gateway', label: 'Gateway', row: 2, col: 3 },
      ],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram nodes "metallb" and "gateway" both occupy cell (row 2, col 3).',
    });
  });

  test('a node inside a group area that is not its member names both and the area', () => {
    // Arrange
    const ir = graph({
      nodes: [
        { id: 'master', label: 'Master', row: 2, col: 3, group: 'cluster' },
        { id: 'gpu', label: 'GPU', row: 6, col: 6, group: 'cluster' },
        { id: 'argocd', label: 'ArgoCD', row: 4, col: 5 },
      ],
      groups: [{ id: 'cluster', label: 'Cluster' }],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram node "argocd" lies inside the area of group "cluster" (rows 2–6, cols 3–6) but is not its member. Move it into the group or out of the area.',
    });
  });

  test('sibling groups that share a cell name both groups and the cell', () => {
    // Arrange
    const ir = graph({
      nodes: [
        {
          id: 'metallb',
          label: 'MetalLB',
          row: 2,
          col: 3,
          colSpan: 2,
          group: 'ingress',
        },
        { id: 'cert', label: 'Cert', row: 3, col: 4, group: 'certificates' },
      ],
      groups: [
        { id: 'ingress', label: 'Ingress' },
        {
          id: 'certificates',
          label: 'Certificates',
          row: 2,
          col: 4,
          rowSpan: 2,
        },
      ],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram groups "ingress" and "certificates" overlap at cell (row 2, col 4). Sibling groups need disjoint areas.',
    });
  });

  test('a child group outside its parent area names both areas', () => {
    // Arrange
    const ir = graph({
      nodes: [
        {
          id: 'grafana',
          label: 'Grafana',
          row: 1,
          col: 4,
          group: 'monitoring',
        },
      ],
      groups: [
        {
          id: 'cluster',
          label: 'Cluster',
          row: 0,
          col: 0,
          rowSpan: 2,
          colSpan: 4,
        },
        { id: 'monitoring', label: 'Monitoring', parent: 'cluster' },
      ],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram group "cluster" area (rows 0–1, cols 0–3) misses its member group "monitoring" at (row 1, col 4).',
    });
  });

  test('an explicit group area that misses a member node names the node and both areas', () => {
    // Arrange
    const ir = graph({
      nodes: [
        { id: 'plan', label: 'Plan', row: 0, col: 3, group: 'lane' },
        { id: 'ship', label: 'Ship', row: 1, col: 3, group: 'lane' },
      ],
      groups: [{ id: 'lane', label: 'Lane', row: 0, col: 3, colSpan: 5 }],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram group "lane" area (row 0, cols 3–7) misses its member node "ship" at (row 1, col 3).',
    });
  });

  test('dividers on a one-cell group name the group and the cell', () => {
    // Arrange
    const ir = graph({
      nodes: [
        {
          id: 'grafana',
          label: 'Grafana',
          row: 4,
          col: 4,
          group: 'monitoring',
        },
      ],
      groups: [{ id: 'monitoring', label: 'Monitoring', dividers: {} }],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram group "monitoring" has dividers, but its area is the one cell (row 4, col 4). Dividers need two rows or two columns.',
    });
  });
});

describe('layoutGraph, one rung at a time from one box to the homelab', () => {
  test('r1 one box alone is as large as its measured frame', () => {
    // Arrange
    const alone: DiagramNode = { id: 'dns', label: 'DNS', row: 0, col: 0 };

    // Act
    const layout = layoutGraph(graph({ nodes: [alone] }));

    // Assert
    assertSoundLayout(layout);
    const { frame } = measureNode(alone, LAYOUT_TOKENS);
    assert.deepEqual(box(layout, 'dns'), { x: 0, y: 0, ...frame });
  });

  test('r2 one box with an icon and a long two-line label holds its text', () => {
    // Arrange
    const gateway: DiagramNode = {
      id: 'gateway',
      icon: 'shield',
      label: ['Istio Ingress Gateway', '(North-South Gateway)'],
      row: 0,
      col: 0,
    };

    // Act
    const layout = layoutGraph(graph({ nodes: [gateway] }));

    // Assert
    assertSoundLayout(layout);
    const { frame } = measureNode(gateway, LAYOUT_TOKENS);
    assert.deepEqual(box(layout, 'gateway'), { x: 0, y: 0, ...frame });
  });

  test('r3 in a row of boxes each column is as wide as its box, and the gutters are GAP wide', () => {
    // Arrange
    const nodes: DiagramNode[] = [
      { id: 'a', label: 'DNS', row: 0, col: 0 },
      {
        id: 'b',
        icon: 'shield',
        label: ['Istio Ingress Gateway', '(North-South Gateway)'],
        row: 0,
        col: 1,
      },
      { id: 'c', label: 'Longhorn', row: 0, col: 2 },
    ];

    // Act
    const layout = layoutGraph(graph({ nodes }));

    // Assert
    assertSoundLayout(layout);
    for (const node of nodes) {
      close(
        box(layout, node.id).w,
        measureNode(node, LAYOUT_TOKENS).frame.w,
        `${node.id} width`,
      );
    }
    const [a, b, c] = ['a', 'b', 'c'].map((id) => box(layout, id));
    assert.deepEqual(
      [b!.x - (a!.x + a!.w), c!.x - (b!.x + b!.w)],
      [LAYOUT_TOKENS.GAP, LAYOUT_TOKENS.GAP],
    );
  });

  test('r4 in a 3×3 grid every column is as wide as its widest box and every row as tall as its tallest', () => {
    // Arrange
    const labels = [
      ['DNS', 'Istio Ingress Gateway (North-South)', 'A'],
      ['Longhorn', 'B', 'VictoriaMetrics'],
      ['C', 'Jaeger', 'Grafana'],
    ];
    const nodes: DiagramNode[] = labels.flatMap((row, r) =>
      row.map((label, c) => ({ id: `n${r}${c}`, label, row: r, col: c })),
    );
    nodes[4] = { ...nodes[4]!, label: ['B', 'second line', 'third line'] };
    const frame = (id: string) =>
      measureNode(
        nodes.find((node) => node.id === id)!,
        LAYOUT_TOKENS,
      ).frame;

    // Act
    const layout = layoutGraph(graph({ nodes }));

    // Assert
    assertSoundLayout(layout);
    for (let c = 0; c < 3; c++) {
      const widest = Math.max(...[0, 1, 2].map((r) => frame(`n${r}${c}`).w));
      for (let r = 0; r < 3; r++)
        close(box(layout, `n${r}${c}`).w, widest, `n${r}${c} width`);
    }
    for (let r = 0; r < 3; r++) {
      const tallest = Math.max(...[0, 1, 2].map((c) => frame(`n${r}${c}`).h));
      for (let c = 0; c < 3; c++)
        close(box(layout, `n${r}${c}`).h, tallest, `n${r}${c} height`);
    }
    const first = box(layout, 'n00');
    const last = box(layout, 'n22');
    assert.deepEqual(layout.viewBox, {
      x: first.x - LAYOUT_TOKENS.CONTENT_PAD,
      y: first.y - LAYOUT_TOKENS.CONTENT_PAD,
      w: last.x + last.w - first.x + 2 * LAYOUT_TOKENS.CONTENT_PAD,
      h: last.y + last.h - first.y + 2 * LAYOUT_TOKENS.CONTENT_PAD,
    });
  });

  test('r5 a wide box spanning two narrow columns widens both columns equally', () => {
    // Arrange
    const wide: DiagramNode = {
      id: 'wide',
      label: 'Istio Service Mesh with mTLS enabled everywhere',
      row: 0,
      col: 0,
      colSpan: 2,
    };
    const nodes: DiagramNode[] = [
      wide,
      { id: 'left', label: 'A', row: 1, col: 0 },
      { id: 'right', label: 'B', row: 1, col: 1 },
    ];

    // Act
    const layout = layoutGraph(graph({ nodes }));

    // Assert
    assertSoundLayout(layout);
    const left = box(layout, 'left');
    const right = box(layout, 'right');
    close(
      box(layout, 'wide').w,
      measureNode(wide, LAYOUT_TOKENS).frame.w,
      'spanning width',
    );
    close(left.w, right.w, 'the spanned columns share the deficit');
    close(left.x, box(layout, 'wide').x, 'left edge');
    close(
      right.x + right.w,
      box(layout, 'wide').x + box(layout, 'wide').w,
      'right edge',
    );
  });

  test('r5 a rowSpan 2 card spans two rows, and a tall card grows both rows', () => {
    // Arrange
    const card: DiagramNode = {
      id: 'laptop',
      label: 'Dell Laptop',
      icon: 'server',
      textAlign: 'start',
      items: [
        '32GB RAM',
        '500GB SSD (Internal)',
        'NVIDIA RTX 3050 4GB GPU',
        'CPU 24 Logical Cores',
      ],
      row: 0,
      col: 0,
      rowSpan: 2,
    };
    const nodes: DiagramNode[] = [
      card,
      { id: 'top', label: 'A', row: 0, col: 1 },
      { id: 'bottom', label: 'B', row: 1, col: 1 },
    ];

    // Act
    const layout = layoutGraph(graph({ nodes }));

    // Assert
    assertSoundLayout(layout);
    const top = box(layout, 'top');
    const bottom = box(layout, 'bottom');
    const laptop = box(layout, 'laptop');
    close(laptop.h, measureNode(card, LAYOUT_TOKENS).frame.h, 'card height');
    close(laptop.y, top.y, 'top edge');
    close(laptop.y + laptop.h, bottom.y + bottom.h, 'bottom edge');
    close(top.h, bottom.h, 'the spanned rows share the deficit');
  });

  test('r6 one group around one box holds the box below its title band', () => {
    // Arrange
    const ir = graph({
      nodes: [
        { id: 'longhorn', label: 'Longhorn', row: 0, col: 0, group: 'storage' },
      ],
      groups: [{ id: 'storage', label: 'Storage', titleBand: true }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const storage = layout.groups[0]!;
    const longhorn = box(layout, 'longhorn');
    assert.ok(
      longhorn.y >= storage.band!.y + storage.band!.h + LAYOUT_TOKENS.GROUP_PAD,
    );
    assert.ok(longhorn.x >= storage.rect.x + LAYOUT_TOKENS.GROUP_PAD);
  });

  test('r7 one group around a row of boxes holds every box', () => {
    // Arrange
    const ir = graph({
      nodes: [
        {
          id: 'grafana',
          label: ['Grafana', '(Dashboards)'],
          icon: 'dashboard',
          row: 0,
          col: 0,
          group: 'monitoring',
        },
        {
          id: 'metrics',
          label: ['VictoriaMetrics', '(Metrics)'],
          icon: 'metrics',
          row: 0,
          col: 1,
          group: 'monitoring',
        },
        { id: 'jaeger', label: 'Jaeger', row: 0, col: 2, group: 'monitoring' },
      ],
      groups: [{ id: 'monitoring', label: 'Monitoring', titleBand: true }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const monitoring = rect(layout, 'monitoring');
    const jaeger = box(layout, 'jaeger');
    assert.ok(
      monitoring.x + monitoring.w >=
        jaeger.x + jaeger.w + LAYOUT_TOKENS.GROUP_PAD,
    );
  });

  test('r8 sibling groups in adjacent cells keep a gap between their borders', () => {
    // Arrange
    const ir = graph({
      nodes: [
        { id: 'metallb', label: 'MetalLB', row: 0, col: 0, group: 'ingress' },
        {
          id: 'cert',
          label: 'Cert-Manager',
          row: 0,
          col: 1,
          group: 'certificates',
        },
        { id: 'master', label: 'K3s master', row: 1, col: 0, group: 'k3s' },
      ],
      groups: [
        {
          id: 'ingress',
          label: ['Networking', '& Ingress', 'Gateways'],
          titleBand: true,
        },
        { id: 'certificates', label: 'Certificates', titleBand: true },
        { id: 'k3s', label: 'K3s', titleBand: true },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const ingress = rect(layout, 'ingress');
    const k3s = rect(layout, 'k3s');
    assert.ok(
      rect(layout, 'certificates').x - (ingress.x + ingress.w) >=
        LAYOUT_TOKENS.GAP,
    );
    assert.ok(k3s.y - (ingress.y + ingress.h) >= LAYOUT_TOKENS.GAP);
  });

  test('r9 three levels of nested groups with title bands nest without covering a band', () => {
    // Arrange
    const ir = graph({
      nodes: [
        {
          id: 'grafana',
          label: 'Grafana',
          row: 1,
          col: 1,
          group: 'monitoring',
        },
        { id: 'jaeger', label: 'Jaeger', row: 1, col: 2, group: 'monitoring' },
        {
          id: 'authentik',
          label: 'Authentik',
          row: 0,
          col: 1,
          group: 'cluster',
        },
        { id: 'isp', label: 'ISP', row: 0, col: 0, group: 'home' },
      ],
      groups: [
        { id: 'home', label: 'Home Lab', titleBand: true },
        {
          id: 'cluster',
          label: ['K3s Kubernetes', 'Cluster'],
          parent: 'home',
          titleBand: true,
        },
        {
          id: 'monitoring',
          label: 'Monitoring',
          parent: 'cluster',
          titleBand: true,
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const depths = Object.fromEntries(
      layout.groups.map((groupLayout) => [
        groupLayout.group.id,
        groupLayout.depth,
      ]),
    );
    assert.deepEqual(depths, { home: 0, cluster: 1, monitoring: 2 });
  });

  test('r10 an explicit group area covers its empty cells, and its dividers run through every inner gutter', () => {
    // Arrange
    const ir = graph({
      nodes: [
        { id: 'plan', label: 'Plan', row: 0, col: 0, group: 'lane' },
        { id: 'fix', label: 'Create fix', row: 0, col: 2, group: 'lane' },
        { id: 'below', label: 'Reviewer', row: 1, col: 3 },
      ],
      groups: [
        {
          id: 'lane',
          label: 'Agent',
          row: 0,
          col: 0,
          colSpan: 4,
          titleBand: true,
          dividers: {},
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const lane = layout.groups[0]!;
    const below = box(layout, 'below');
    assert.ok(
      lane.rect.x < below.x && below.x + below.w < lane.rect.x + lane.rect.w,
    );
    assert.equal(lane.dividers.length, 3);
    for (const [from, to] of lane.dividers) {
      assert.equal(from.x, to.x);
      assert.ok(from.y >= lane.band!.y + lane.band!.h);
      close(
        to.y,
        lane.rect.y + lane.rect.h,
        'divider reaches the bottom border',
      );
    }
    const plan = box(layout, 'plan');
    const fix = box(layout, 'fix');
    assert.ok(
      lane.dividers[0]![0].x > plan.x + plan.w &&
        lane.dividers[2]![0].x > fix.x + fix.w &&
        lane.dividers[2]![0].x < below.x,
    );
  });

  test('r11 a note in a cell keeps its measured size, centred in a wider column', () => {
    // Arrange
    const note: DiagramNode = {
      id: 'why',
      kind: 'note',
      target: 'wide',
      label: ['Manages', 'certificates'],
      row: 1,
      col: 0,
    };
    const ir = graph({
      nodes: [
        { id: 'wide', label: 'Cert-Manager with ACME issuer', row: 0, col: 0 },
        note,
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const wide = box(layout, 'wide');
    const placed = box(layout, 'why');
    close(placed.w, measureNode(note, LAYOUT_TOKENS).frame.w, 'note width');
    close(placed.x + placed.w / 2, wide.x + wide.w / 2, 'note centre');
  });

  test('r12 the homelab cluster interior nests its seven groups soundly', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('metallb', 2, 3, {
          icon: 'router',
          label: ['MetalLB', '(Load Balancer)'],
          group: 'ingress',
        }),
        cell('gateway', 2, 4, {
          icon: 'shield',
          label: ['Istio Ingress Gateway', '(North-South Gateway)'],
          group: 'ingress',
        }),
        cell('cert-manager', 2, 5, {
          icon: 'certificate',
          label: 'Cert-Manager',
          group: 'certificates',
        }),
        cell('k3s-master', 3, 3, {
          icon: 'kubernetes',
          textAlign: 'start',
          label: ['K3s master', 'Pods'],
          group: 'k3s-vms',
        }),
        cell('istio', 3, 4, {
          colSpan: 2,
          icon: 'istio',
          textAlign: 'start',
          label: [
            'Istio Service Mesh',
            { text: 'mTLS Enabled', textColor: 'dim' },
          ],
          group: 'mesh',
        }),
        cell('longhorn', 5, 3, {
          icon: 'storage',
          label: ['Longhorn', '(Storage Class)'],
          group: 'storage',
        }),
        cell('grafana', 5, 4, {
          icon: 'dashboard',
          label: ['Grafana', '(Dashboards)'],
          group: 'monitoring',
        }),
        cell('victoria-metrics', 5, 5, {
          icon: 'metrics',
          label: ['VictoriaMetrics', '(Metrics)'],
          group: 'monitoring',
        }),
        cell('victoria-logs', 6, 4, {
          icon: 'logs',
          label: ['VictoriaLogs', '(Logs)'],
          group: 'monitoring',
        }),
        cell('jaeger', 6, 5, {
          icon: 'trace',
          label: ['Jaeger', '(Traces)'],
          group: 'monitoring',
        }),
        cell('gpu-workflow', 6, 6, {
          icon: 'gpu',
          textAlign: 'start',
          label: 'GPU Workflow',
          description: 'NVIDIA RTX 3050',
          items: ['K3s Node Affinity', 'Automatic GPU Scheduling'],
          group: 'gpu-scheduling',
        }),
      ],
      groups: [
        {
          id: 'ingress',
          label: 'Networking & Ingress',
          labelAlign: 'start',
          titleBand: true,
        },
        { id: 'k3s-vms', label: 'K3s', titleBand: true },
        { id: 'mesh', label: 'Service Mesh', titleBand: true },
        { id: 'certificates', label: 'Certificates', titleBand: true },
        {
          id: 'storage',
          label: 'Storage',
          labelAlign: 'start',
          titleBand: true,
        },
        {
          id: 'monitoring',
          label: 'Monitoring',
          titleBand: true,
          dividers: { rows: [6], cols: [5] },
        },
        {
          id: 'gpu-scheduling',
          label: 'GPU Scheduling',
          labelAlign: 'start',
          titleBand: true,
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const mesh = rect(layout, 'mesh');
    const certificates = rect(layout, 'certificates');
    assert.ok(mesh.y >= certificates.y + certificates.h + LAYOUT_TOKENS.GAP);
  });

  test('r13 the full homelab remapped onto a 7×8 grid is sound', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('cloudflare-dns', 0, 3, {
          icon: 'cloudflare',
          label: ['Cloudflare', 'DNS & Domain', 'Management'],
        }),
        cell('public-internet', 0, 4, {
          icon: 'internet',
          label: 'Public Internet',
        }),
        cell('cloudflare-tunnel', 1, 4, {
          kind: 'connector',
          icon: 'tunnel',
          label: [
            'Cloudflare Tunnel',
            { text: '(Zero Trust)', textColor: 'dim' },
          ],
        }),
        cell('adguard', 2, 2, {
          icon: 'shield',
          label: 'AdGuard Home',
          caption: 'DNS Forwarder',
        }),
        cell('metallb', 2, 3, {
          icon: 'router',
          label: ['MetalLB', '(Load Balancer)'],
          group: 'ingress',
        }),
        cell('gateway', 2, 4, {
          icon: 'shield',
          label: ['Istio Ingress Gateway', '(North-South Gateway)'],
          group: 'ingress',
        }),
        cell('cert-manager', 2, 5, {
          icon: 'certificate',
          label: 'Cert-Manager',
          group: 'certificates',
        }),
        cell('cert-note', 2, 7, {
          kind: 'note',
          target: 'cert-manager',
          label: ['Manages', "Let's Encrypt", 'certificates'],
        }),
        cell('isp', 3, 0, {
          icon: 'internet',
          label: ['ISP Connection', '(1 Gbps)'],
        }),
        cell('router', 3, 1, {
          kind: 'appliance',
          appliancePorts: 5,
          antenna: true,
          label: '',
          caption: 'Fritzbox Router',
        }),
        cell('k3s-master', 3, 3, {
          icon: 'kubernetes',
          textAlign: 'start',
          label: ['K3s master', 'Pods'],
          group: 'k3s-vms',
        }),
        cell('istio', 3, 4, {
          colSpan: 2,
          icon: 'istio',
          textAlign: 'start',
          label: [
            'Istio Service Mesh',
            { text: 'mTLS Enabled', textColor: 'dim' },
          ],
          group: 'mesh',
        }),
        cell('authentik', 3, 6, {
          icon: 'shield',
          label: ['Authentik', '(SSO)'],
          group: 'cluster',
        }),
        cell('authentik-note', 3, 7, {
          kind: 'note',
          target: 'authentik',
          label: ['Authentication', 'for services', 'in mesh'],
        }),
        cell('proxmox-vm', 4, 2, {
          rowSpan: 2,
          icon: 'server',
          textAlign: 'start',
          stack: 4,
          label: 'VM',
          group: 'proxmox',
        }),
        cell('observability-bus', 4, 4, {
          colSpan: 2,
          kind: 'junction',
          hidden: true,
          group: 'cluster',
        }),
        cell('argocd', 4, 6, {
          icon: 'git',
          label: ['ArgoCD', '(GitOps Deployment)'],
          group: 'cluster',
        }),
        cell('git-repo', 4, 7, {
          kind: 'marker',
          icon: 'git',
          label: 'Git Repo',
        }),
        cell('laptop', 5, 0, {
          colSpan: 2,
          rowSpan: 2,
          icon: 'server',
          textAlign: 'start',
          label: 'Dell Laptop',
          items: [
            '32GB RAM',
            '500GB SSD (Internal)',
            'NVIDIA RTX 3050 4GB GPU',
            'CPU 24 Logical Cores',
          ],
        }),
        cell('longhorn', 5, 3, {
          icon: 'storage',
          label: ['Longhorn', '(Storage Class)'],
          group: 'storage',
        }),
        cell('grafana', 5, 4, {
          icon: 'dashboard',
          label: ['Grafana', '(Dashboards)'],
          group: 'monitoring',
        }),
        cell('victoria-metrics', 5, 5, {
          icon: 'metrics',
          label: ['VictoriaMetrics', '(Metrics)'],
          group: 'monitoring',
        }),
        cell('argocd-note', 5, 6, {
          kind: 'note',
          target: 'argocd',
          label: ['Deploys applications', 'into k3s'],
          group: 'cluster',
        }),
        cell('external-ssd', 6, 2, {
          icon: 'storage',
          label: ['4TB', 'External SSD'],
        }),
        cell('victoria-logs', 6, 4, {
          icon: 'logs',
          label: ['VictoriaLogs', '(Logs)'],
          group: 'monitoring',
        }),
        cell('jaeger', 6, 5, {
          icon: 'trace',
          label: ['Jaeger', '(Traces)'],
          group: 'monitoring',
        }),
        cell('gpu-workflow', 6, 6, {
          icon: 'gpu',
          textAlign: 'start',
          label: 'GPU Workflow',
          description: 'NVIDIA RTX 3050',
          items: ['K3s Node Affinity', 'Automatic GPU Scheduling'],
          group: 'gpu-scheduling',
        }),
      ],
      groups: [
        {
          id: 'proxmox',
          label: ['Proxmox VE', '(Hypervisor)'],
          titleBand: true,
        },
        {
          id: 'cluster',
          label: 'K3s Kubernetes Cluster',
          labelAlign: 'start',
          titleBand: true,
        },
        {
          id: 'ingress',
          label: 'Networking & Ingress',
          labelAlign: 'start',
          titleBand: true,
          parent: 'cluster',
        },
        { id: 'k3s-vms', label: 'K3s', titleBand: true, parent: 'cluster' },
        {
          id: 'mesh',
          label: 'Service Mesh',
          titleBand: true,
          parent: 'cluster',
        },
        {
          id: 'certificates',
          label: 'Certificates',
          titleBand: true,
          parent: 'cluster',
        },
        {
          id: 'storage',
          label: 'Storage',
          labelAlign: 'start',
          titleBand: true,
          parent: 'cluster',
        },
        {
          id: 'monitoring',
          label: 'Monitoring',
          titleBand: true,
          dividers: { rows: [6], cols: [5] },
          parent: 'cluster',
        },
        {
          id: 'gpu-scheduling',
          label: 'GPU Scheduling',
          labelAlign: 'start',
          titleBand: true,
          parent: 'cluster',
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const cluster = rect(layout, 'cluster');
    const bus = box(layout, 'observability-bus');
    const istio = box(layout, 'istio');
    close(
      bus.x + bus.w / 2,
      istio.x + istio.w / 2,
      'the bus sits under the centre of istio',
    );
    for (const id of [
      'ingress',
      'k3s-vms',
      'mesh',
      'certificates',
      'storage',
      'monitoring',
      'gpu-scheduling',
    ]) {
      const child = rect(layout, id);
      assert.ok(
        child.x > cluster.x && child.x + child.w < cluster.x + cluster.w,
        `${id} inside cluster`,
      );
    }
    assert.equal(
      layout.groups.find(
        (groupLayout) => groupLayout.group.id === 'monitoring',
      )!.dividers.length,
      2,
    );
  });
});

describe('layoutGraph keeps room for the labels of edges between neighbouring cells', () => {
  test('a labelled edge between side-by-side cells widens their gutter to the label plus two stubs', () => {
    // Arrange
    const edge: DiagramEdge = {
      from: 'a',
      to: 'b',
      label: ['HTTPS 443 / mTLS'],
    };
    const ir = graph({
      nodes: [
        { id: 'a', label: 'A', row: 0, col: 0 },
        { id: 'b', label: 'B', row: 0, col: 1 },
      ],
      edges: [edge],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    const a = box(layout, 'a');
    close(
      box(layout, 'b').x - (a.x + a.w),
      measureEdgeLabel(edge, LAYOUT_TOKENS).w + 2 * LAYOUT_TOKENS.STUB,
      'gutter',
    );
  });

  test('a labelled edge between stacked cells heightens their gutter to the label plus two stubs', () => {
    // Arrange
    const edge: DiagramEdge = {
      from: 'b',
      to: 'a',
      label: ['sync', 'every 5 min', 'over SSH'],
    };
    const ir = graph({
      nodes: [
        { id: 'a', label: 'A', row: 0, col: 0 },
        { id: 'b', label: 'B', row: 1, col: 0 },
      ],
      edges: [edge],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    const a = box(layout, 'a');
    close(
      box(layout, 'b').y - (a.y + a.h),
      measureEdgeLabel(edge, LAYOUT_TOKENS).h + 2 * LAYOUT_TOKENS.STUB,
      'gutter',
    );
  });

  void test.todo(
    '#step3 edges route orthogonally around nodes and bands, and their labels sit beside them',
  );
  void test.todo('#step3 notes with a target get a leader to it');
});
