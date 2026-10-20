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
import type { GraphLayout, GroupLayout } from './graph-layout-result.ts';
import { layoutGraph } from './layout.ts';
import { measureEdgeBadge, measureEdgeLabel, measureNode } from './measure.ts';
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
  };
}

function box(layout: GraphLayout, id: string): Box {
  const found = layout.nodes.find((nodeLayout) => nodeLayout.node.id === id);
  assert.ok(found, `node "${id}" is in the layout`);
  return found.box;
}

function groupOf(layout: GraphLayout, id: string): GroupLayout {
  const found = layout.groups.find(
    (groupLayout) => groupLayout.group.id === id,
  );
  assert.ok(found, `group "${id}" is in the layout`);
  return found;
}

function rect(layout: GraphLayout, id: string): Box {
  return groupOf(layout, id).rect;
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
      groups: [{ id: 'monitoring', label: 'Monitoring', dividers: true }],
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
    const { frame } = measureNode(alone);
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
    const { frame } = measureNode(gateway);
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
        measureNode(node).frame.w,
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
      measureNode(nodes.find((node) => node.id === id)!).frame;

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
    close(box(layout, 'wide').w, measureNode(wide).frame.w, 'spanning width');
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
    close(laptop.h, measureNode(card).frame.h, 'card height');
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
          dividers: true,
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
    close(placed.w, measureNode(note).frame.w, 'note width');
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
          dividers: true,
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
          dividers: true,
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
      measureEdgeLabel(edge).w + 2 * LAYOUT_TOKENS.STUB,
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
      measureEdgeLabel(edge).h + 2 * LAYOUT_TOKENS.STUB,
      'gutter',
    );
  });
});

describe('layoutGraph keeps room for the badges of edges between neighbouring cells', () => {
  test('g1 a badge between stacked cells sits on its edge, in a gutter as tall as the badge plus two stubs', () => {
    // Arrange
    const edge: DiagramEdge = {
      from: 'a',
      to: 'b',
      badgeIcon: 'tunnel',
      badgeLabel: ['Badge'],
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
    assertSoundLayout(layout);
    const a = box(layout, 'a');
    close(
      box(layout, 'b').y - (a.y + a.h),
      measureEdgeBadge(edge).h + 2 * LAYOUT_TOKENS.STUB,
      'gutter',
    );
    assert.ok(edgeOf(layout, 'a', 'b').badge, 'the edge carries its badge');
  });

  test('g1b a badge between cells with an empty row between them shares the two gutters it crosses', () => {
    // Arrange
    const edge: DiagramEdge = {
      from: 'a',
      to: 'b',
      badgeIcon: 'tunnel',
      badgeLabel: ['Cloudflare Tunnel', '(Zero Trust)'],
    };
    const ir = graph({
      nodes: [
        { id: 'a', label: 'A', row: 0, col: 0 },
        { id: 'b', label: 'B', row: 2, col: 0 },
      ],
      edges: [edge],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const a = box(layout, 'a');
    close(
      box(layout, 'b').y - (a.y + a.h),
      measureEdgeBadge(edge).h + 2 * LAYOUT_TOKENS.STUB,
      'the two gutters and the empty row',
    );
    assert.ok(edgeOf(layout, 'a', 'b').badge, 'the edge carries its badge');
  });

  test('g2 a label and a badge on one edge between side-by-side cells sit in a row, in a gutter as wide as both plus LABEL_GAP and two stubs', () => {
    // Arrange
    const edge: DiagramEdge = {
      from: 'a',
      to: 'b',
      label: ['calls'],
      badgeIcon: 'tunnel',
      badgeLabel: ['Badge'],
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
    assertSoundLayout(layout);
    const a = box(layout, 'a');
    close(
      box(layout, 'b').x - (a.x + a.w),
      measureEdgeLabel(edge).w +
        LAYOUT_TOKENS.LABEL_GAP +
        measureEdgeBadge(edge).w +
        2 * LAYOUT_TOKENS.STUB,
      'gutter',
    );
    const { label, badge } = edgeOf(layout, 'a', 'b');
    assert.ok(label && badge, 'the edge carries its label and its badge');
  });

  test('g3 a badge on an edge with a bend sits on one of its segments', () => {
    // Arrange
    const ir = graph({
      nodes: [
        { id: 'a', label: 'A', row: 0, col: 0 },
        { id: 'b', label: 'B', row: 1, col: 1 },
      ],
      edges: [
        {
          from: 'a',
          to: 'b',
          exitSide: 'right',
          entrySide: 'top',
          badgeIcon: 'tunnel',
          badgeLabel: ['Badge'],
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points, badge } = edgeOf(layout, 'a', 'b');
    assert.equal(points.length, 3);
    assert.ok(badge, 'the edge carries its badge');
    const centre = {
      x: badge.box.x + badge.box.w / 2,
      y: badge.box.y + badge.box.h / 2,
    };
    assert.ok(
      points
        .slice(1)
        .some(
          (to, index) =>
            (to.x === points[index]!.x && Math.abs(centre.x - to.x) < 0.01) ||
            (to.y === points[index]!.y && Math.abs(centre.y - to.y) < 0.01),
        ),
      'the badge is centred on a segment of its edge',
    );
  });
});

function edgeOf(layout: GraphLayout, from: string, to: string) {
  const found = layout.edges.find(
    ({ edge }) => edge.from === from && edge.to === to,
  );
  assert.ok(found, `edge ${from}->${to} is in the layout`);
  return found;
}

/**
 * The homelab example remapped onto an 8×8 grid, with its 24 edges and three
 * note leaders. Only the router's edges carry side hints.
 */
function homelab(): DiagramGraphIR {
  return graph({
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
      cell('proxmox-vm', 3, 2, {
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
      cell('laptop', 7, 0, {
        colSpan: 2,
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
      cell('external-ssd', 7, 2, {
        icon: 'storage',
        label: ['4TB', 'External SSD'],
      }),
      cell('gpu-workflow', 7, 6, {
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
        dividers: true,
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
    edges: [
      { from: 'cloudflare-dns', to: 'public-internet' },
      { from: 'public-internet', to: 'cloudflare-tunnel' },
      { from: 'cloudflare-tunnel', to: 'gateway' },
      { from: 'isp', to: 'router' },
      // The router's caption hangs under it, so its edges leave by the sides.
      { from: 'router', to: 'adguard', exitSide: 'right', entrySide: 'left' },
      { from: 'router', to: 'laptop', exitSide: 'left' },
      { from: 'router', to: 'proxmox' },
      { from: 'laptop', to: 'external-ssd' },
      {
        from: 'external-ssd',
        to: 'longhorn',
        lineStyle: 'dashed',
        label: ['Distributed Storage & Backups'],
      },
      { from: 'proxmox', to: 'k3s-master' },
      {
        from: 'metallb',
        to: 'gateway',
        label: ['External IPs'],
        labelFrame: true,
      },
      { from: 'gateway', to: 'istio', direction: 'both' },
      { from: 'k3s-master', to: 'istio' },
      {
        from: 'cert-manager',
        to: 'gateway',
        lineStyle: 'dashed',
        label: ['certificates'],
        labelFrame: true,
      },
      { from: 'authentik', to: 'istio', label: ['SSO'], labelFrame: true },
      { from: 'argocd', to: 'istio', label: ['Deploys'], labelFrame: true },
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
    ],
  });
}

/** The homelab cut down to the named nodes, the groups that hold them, and the edges between them. */
function homelabPart(ids: string[]): DiagramGraphIR {
  const whole = homelab();
  const nodes = whole.nodes.filter((node) => ids.includes(node.id));
  const parents = new Map(
    whole.groups.map((group) => [group.id, group.parent]),
  );
  const groups = new Set<string>();
  for (const node of nodes) {
    for (let id = node.group; id !== undefined; id = parents.get(id))
      groups.add(id);
  }
  const kept = new Set([...ids, ...groups]);
  return graph({
    nodes,
    groups: whole.groups.filter((group) => groups.has(group.id)),
    edges: whole.edges.filter(
      (edge) => kept.has(edge.from) && kept.has(edge.to),
    ),
  });
}

describe('layoutGraph routes edges, one rung at a time from one edge to the homelab', () => {
  test('e1 an edge between two boxes in a row runs straight between their facing sides', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('a', 0, 0, { label: 'API' }),
        cell('b', 0, 1, { label: 'Database' }),
      ],
      edges: [{ from: 'a', to: 'b' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const a = box(layout, 'a');
    const b = box(layout, 'b');
    const { points, exitSide, entrySide } = edgeOf(layout, 'a', 'b');
    assert.deepEqual([exitSide, entrySide], ['right', 'left']);
    assert.equal(points.length, 2);
    close(points[0]!.x, a.x + a.w, 'start on the right side');
    close(points[1]!.x, b.x, 'end on the left side');
    assert.equal(points[0]!.y, points[1]!.y);
  });

  test('e2 an edge between two boxes in a column runs straight between their facing sides', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('a', 0, 0, { label: 'Gateway' }),
        cell('b', 1, 0, { label: 'Mesh' }),
      ],
      edges: [{ from: 'a', to: 'b' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const a = box(layout, 'a');
    const b = box(layout, 'b');
    const { points, exitSide, entrySide } = edgeOf(layout, 'a', 'b');
    assert.deepEqual([exitSide, entrySide], ['bottom', 'top']);
    assert.equal(points.length, 2);
    close(points[0]!.y, a.y + a.h, 'start on the bottom side');
    close(points[1]!.y, b.y, 'end on the top side');
    assert.equal(points[0]!.x, points[1]!.x);
  });

  test('e3 an edge between diagonal cells bends once', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('a', 0, 0, { label: 'Laptop' }),
        cell('b', 1, 2, { label: 'SSD' }),
      ],
      edges: [{ from: 'a', to: 'b', exitSide: 'right', entrySide: 'top' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(edgeOf(layout, 'a', 'b').points.length, 3);
  });

  test('e4 three edges out of one side leave it at evenly spaced slots, in the order of their targets', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('hub', 1, 0, { label: 'Load balancer' }),
        cell('low', 2, 2, { label: 'C' }),
        cell('top', 0, 2, { label: 'A' }),
        cell('mid', 1, 2, { label: 'B' }),
      ],
      edges: [
        { from: 'hub', to: 'low' },
        { from: 'hub', to: 'top' },
        { from: 'hub', to: 'mid' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const starts = ['top', 'mid', 'low'].map((to) => {
      const { points, exitSide } = edgeOf(layout, 'hub', to);
      assert.equal(exitSide, 'right');
      return points[0]!.y;
    });
    const [first, second, third] = starts;
    assert.ok(first! < second! && second! < third!, `slots ${starts}`);
    close(second! - first!, third! - second!, 'the gaps between the slots');
  });

  test('e4b an edge from a shared side to a facing side it has alone runs straight from its slot', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('router', 1, 0, { label: 'Router' }),
        cell('adguard', 0, 1, { label: 'AdGuard' }),
        cell('vm', 1, 1, { icon: 'server', label: 'VM', rowSpan: 2 }),
      ],
      edges: [
        {
          from: 'router',
          to: 'adguard',
          exitSide: 'right',
          entrySide: 'left',
        },
        { from: 'router', to: 'vm' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points } = edgeOf(layout, 'router', 'vm');
    assert.equal(
      points.length,
      2,
      'no jog between the slot and the facing side',
    );
    assert.equal(points[0]!.y, points[1]!.y);
  });

  test('e5 the label of an edge between adjacent cells sits beside it in the gutter', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('metallb', 0, 0, { icon: 'router', label: 'MetalLB' }),
        cell('gateway', 0, 1, { icon: 'shield', label: 'Gateway' }),
      ],
      edges: [
        {
          from: 'metallb',
          to: 'gateway',
          label: ['External IPs'],
          labelFrame: true,
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { label, points } = edgeOf(layout, 'metallb', 'gateway');
    assert.ok(label, 'the edge has a label');
    assert.equal(points.length, 2);
    assert.ok(
      label.box.x >= points[0]!.x && label.box.x + label.box.w <= points[1]!.x,
    );
    assert.equal(label.text[0]!.text, 'External IPs');
  });

  test('e6 the label of an edge that bends sits beside one of its segments', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('ssd', 1, 0, { label: 'External SSD' }),
        cell('longhorn', 0, 2, { label: 'Longhorn' }),
      ],
      edges: [
        {
          from: 'ssd',
          to: 'longhorn',
          exitSide: 'right',
          entrySide: 'bottom',
          label: ['Distributed Storage & Backups'],
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { label, points } = edgeOf(layout, 'ssd', 'longhorn');
    assert.ok(points.length >= 3, 'the edge bends');
    assert.ok(label, 'the edge has a label');
    const gap = LAYOUT_TOKENS.LABEL_GAP;
    const { x, y, w, h } = label.box;
    const beside = points.slice(1).some((to, index) => {
      const from = points[index]!;
      if (from.y === to.y) {
        const centre = x + w / 2;
        return (
          centre >= Math.min(from.x, to.x) &&
          centre <= Math.max(from.x, to.x) &&
          (Math.abs(y + h + gap - from.y) < 0.01 ||
            Math.abs(y - gap - from.y) < 0.01)
        );
      }
      const centre = y + h / 2;
      return (
        centre >= Math.min(from.y, to.y) &&
        centre <= Math.max(from.y, to.y) &&
        (Math.abs(x - gap - from.x) < 0.01 ||
          Math.abs(x + w + gap - from.x) < 0.01)
      );
    });
    assert.ok(beside, 'the label sits LABEL_GAP beside one of the segments');
  });

  test('e6b a label skips the positions where it would straddle a group border', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('roof', 0, 0, { label: 'Roof over the whole row', colSpan: 4 }),
        cell('a', 1, 0, { label: 'A' }),
        cell('b', 1, 3, { label: 'B' }),
        cell('member', 2, 1, { label: 'Member box wide', group: 'zone' }),
        cell('neighbour', 2, 2, { label: 'Neighbour' }),
      ],
      groups: [{ id: 'zone', label: 'Zone', labelAlign: 'start' }],
      edges: [{ from: 'a', to: 'b', label: ['one', 'two', 'three', 'four'] }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const label = edgeOf(layout, 'a', 'b').label!.box;
    const zone = rect(layout, 'zone');
    const outside =
      label.x >= zone.x + zone.w ||
      label.x + label.w <= zone.x ||
      label.y >= zone.y + zone.h ||
      label.y + label.h <= zone.y;
    assert.ok(
      outside,
      `the label ${JSON.stringify(label)} stays out of the zone`,
    );
  });

  test('e7 an edge goes around a box in its way', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('a', 0, 0, { label: 'Router' }),
        cell('wall', 0, 1, { label: 'Firewall' }),
        cell('b', 0, 2, { label: 'Server' }),
      ],
      edges: [{ from: 'a', to: 'b' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.ok(
      edgeOf(layout, 'a', 'b').points.length > 2,
      'the edge bends around the firewall',
    );
  });

  test('e8 edges into and out of a group cross its border', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('client', 1, 0, { label: 'Client' }),
        cell('api', 1, 1, { label: 'API', group: 'cloud' }),
        cell('db', 0, 1, { label: 'DB', group: 'cloud' }),
        cell('backup', 0, 2, { label: 'Backup' }),
      ],
      groups: [{ id: 'cloud', label: 'Cloud', titleBand: true }],
      edges: [
        { from: 'client', to: 'api' },
        { from: 'db', to: 'backup' },
        { from: 'client', to: 'db', exitSide: 'top', entrySide: 'left' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
  });

  test('e9b an edge from a junction runs straight up into a side it shares with another edge', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('istio', 0, 0, { label: 'Istio', colSpan: 3 }),
        cell('longhorn', 1, 0, { label: 'Longhorn' }),
        cell('bus', 1, 1, { kind: 'junction', hidden: true, colSpan: 2 }),
        cell('grafana', 2, 1, { label: 'Grafana' }),
      ],
      edges: [
        { from: 'longhorn', to: 'istio' },
        { from: 'grafana', to: 'bus', headless: true },
        { from: 'bus', to: 'istio' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points } = edgeOf(layout, 'bus', 'istio');
    assert.equal(points.length, 2, 'no jog between the junction and its slot');
    assert.equal(points[0]!.x, points[1]!.x);
  });

  test('e9c an edge from a box with a caption on top runs straight into a junction beside it', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('identify', 0, 0, {
          label: 'Identify type',
          caption: 'LLM Call',
          captionSide: 'top',
          captionFrame: true,
        }),
        cell('trunk', 0, 1, { kind: 'junction', hidden: true }),
      ],
      edges: [{ from: 'identify', to: 'trunk', headless: true }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points } = edgeOf(layout, 'identify', 'trunk');
    assert.equal(
      points.length,
      2,
      'the frame and the junction share a centre line',
    );
  });

  test('e9 four edges merge into a junction at its centre, and one edge leaves it from there', () => {
    // Arrange
    const sources = ['grafana', 'metrics', 'logs', 'traces'];
    const ir = graph({
      nodes: [
        ...sources.map((id, row) => cell(id, row, 0, { label: id })),
        cell('bus', 1, 1, { kind: 'junction', rowSpan: 2, hidden: true }),
        cell('mesh', 1, 2, { label: 'Istio', rowSpan: 2 }),
      ],
      edges: [
        ...sources.map((id) => ({
          from: id,
          to: 'bus',
          exitSide: 'right' as const,
          entrySide: 'left' as const,
          headless: true,
        })),
        { from: 'bus', to: 'mesh' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const bus = box(layout, 'bus');
    const centre = { x: bus.x + bus.w / 2, y: bus.y + bus.h / 2 };
    for (const id of sources) {
      assert.deepEqual(edgeOf(layout, id, 'bus').points.at(-1), centre);
    }
    const out = edgeOf(layout, 'bus', 'mesh').points;
    assert.deepEqual(out[0], centre);
    assert.equal(out.length, 2, 'the edge out runs straight to the mesh');
  });

  test('e10 a U-turn edge leaves and enters by the same side', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('implement', 0, 0, { label: 'Implement' }),
        cell('review', 0, 1, { label: 'Review' }),
      ],
      edges: [
        { from: 'implement', to: 'review' },
        {
          from: 'review',
          to: 'implement',
          exitSide: 'bottom',
          entrySide: 'bottom',
          label: ['Revise'],
          labelFrame: true,
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points, label } = edgeOf(layout, 'review', 'implement');
    assert.equal(points.length, 4, 'down, across, up');
    assert.ok(label, 'the U-turn has its label');
  });

  test('e11 a note with a target gets a leader to it', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('cert-manager', 0, 0, {
          icon: 'certificate',
          label: 'Cert-Manager',
        }),
        cell('note', 0, 1, {
          kind: 'note',
          target: 'cert-manager',
          label: ['Manages', "Let's Encrypt", 'certificates'],
        }),
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(layout.leaders.length, 1);
    const [leader] = layout.leaders;
    assert.deepEqual([leader!.note, leader!.target], ['note', 'cert-manager']);
    const target = box(layout, 'cert-manager');
    close(
      leader!.points.at(-1)!.x,
      target.x + target.w,
      'the leader ends on the right side',
    );
  });

  test('e12 edges that name ports start and end at those ports, on a node and on a group', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('router', 0, 0, {
          label: 'Router',
          ports: [
            { id: 'lan1', side: 'right', label: 'LAN 1' },
            { id: 'lan2', side: 'right', label: 'LAN 2' },
          ],
        }),
        cell('nas', 0, 1, { label: 'NAS', group: 'rack' }),
        cell('tv', 1, 1, { label: 'TV' }),
      ],
      groups: [
        {
          id: 'rack',
          label: 'Rack',
          titleBand: true,
          ports: [{ id: 'uplink', side: 'left' }],
        },
      ],
      edges: [
        { from: 'router:lan1', to: 'rack:uplink' },
        { from: 'router:lan2', to: 'tv' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const router = layout.nodes.find(({ node }) => node.id === 'router')!;
    const rack = layout.groups.find(({ group }) => group.id === 'rack')!;
    const port = (ports: typeof router.ports, id: string) =>
      ports.find((candidate) => candidate.id === id)!.point;
    const toRack = edgeOf(layout, 'router:lan1', 'rack:uplink').points;
    assert.deepEqual(toRack[0], port(router.ports, 'lan1'));
    assert.deepEqual(toRack.at(-1), port(rack.ports, 'uplink'));
    assert.deepEqual(
      edgeOf(layout, 'router:lan2', 'tv').points[0],
      port(router.ports, 'lan2'),
    );
  });

  test('e5b the label of an edge between sibling groups sits between their borders', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('gateway', 0, 0, {
          icon: 'shield',
          label: 'Gateway',
          group: 'ingress',
        }),
        cell('cert-manager', 0, 1, {
          icon: 'certificate',
          label: 'Cert-Manager',
          group: 'certificates',
        }),
      ],
      groups: [
        { id: 'ingress', label: 'Ingress', titleBand: true },
        { id: 'certificates', label: 'Certificates', titleBand: true },
      ],
      edges: [
        {
          from: 'cert-manager',
          to: 'gateway',
          label: ["Let's Encrypt", 'certificates'],
          labelFrame: true,
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { label } = edgeOf(layout, 'cert-manager', 'gateway');
    const ingress = rect(layout, 'ingress');
    assert.ok(
      label!.box.x >= ingress.x + ingress.w,
      'the label lies outside ingress',
    );
    assert.ok(
      label!.box.x + label!.box.w <= rect(layout, 'certificates').x,
      'the label lies outside certificates',
    );
  });

  test('e5c an edge reaches a box whose caption is wider than its frame, and enters a captioned side beside the caption', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('analyze', 0, 0, {
          label: 'Analyze',
          caption: 'Agent',
          captionSide: 'top',
        }),
        cell('implement', 0, 1, {
          label: 'Do',
          caption: 'Workspace agent',
          captionSide: 'top',
          captionFrame: true,
        }),
        cell('merge', 1, 1, {
          label: 'Merge',
          caption: 'Human',
          captionSide: 'top',
          captionFrame: true,
        }),
      ],
      edges: [
        { from: 'analyze', to: 'implement' },
        { from: 'implement', to: 'merge' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const merge = layout.nodes.find(({ node }) => node.id === 'merge')!;
    const entry = edgeOf(layout, 'implement', 'merge').points.at(-1)!;
    const caption = merge.caption!.box;
    assert.ok(
      entry.x < caption.x || entry.x > caption.x + caption.w,
      `the edge enters at x ${entry.x}, beside the caption ${caption.x}–${caption.x + caption.w}`,
    );
  });

  test('e13a the homelab ingress down to the mesh, with the certificate note', () => {
    // Arrange
    const ir = homelabPart([
      'cloudflare-dns',
      'public-internet',
      'cloudflare-tunnel',
      'metallb',
      'gateway',
      'cert-manager',
      'cert-note',
      'istio',
      'k3s-master',
    ]);

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(layout.edges.length, 7);
    assert.equal(layout.leaders.length, 1);
  });

  test('e13b the homelab monitoring merges into the bus, and the bus runs straight up into istio', () => {
    // Arrange
    const ir = homelabPart([
      'grafana',
      'victoria-metrics',
      'victoria-logs',
      'jaeger',
      'observability-bus',
      'istio',
    ]);

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(layout.edges.length, 5);
    assert.equal(edgeOf(layout, 'observability-bus', 'istio').points.length, 2);
  });

  test('e13c the homelab hardware and storage', () => {
    // Arrange
    const ir = homelabPart([
      'isp',
      'router',
      'adguard',
      'laptop',
      'external-ssd',
      'longhorn',
      'istio',
      'proxmox-vm',
      'k3s-master',
    ]);

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(layout.edges.length, 9);
  });

  test('e13d the homelab GitOps and SSO, with their notes', () => {
    // Arrange
    const ir = homelabPart([
      'argocd',
      'git-repo',
      'argocd-note',
      'authentik',
      'authentik-note',
      'istio',
      'gpu-workflow',
    ]);

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(layout.edges.length, 4);
    assert.equal(layout.leaders.length, 2);
  });

  test('e14 the full homelab routes all 24 edges and 3 leaders soundly', () => {
    // Arrange
    const ir = homelab();

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(layout.edges.length, 24);
    assert.equal(layout.leaders.length, 3);
    for (const { edge, label } of layout.edges) {
      assert.equal(
        Boolean(label),
        Boolean(edge.label?.length),
        `${edge.from}->${edge.to} label`,
      );
    }
  });

  test('b1 an edge drops straight through the title band of a group beside its start-aligned label', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('client', 0, 0, { label: 'Client' }),
        cell('api', 1, 0, { label: 'Payments API service', group: 'cloud' }),
      ],
      groups: [
        { id: 'cloud', label: 'Cloud', titleBand: true, labelAlign: 'start' },
      ],
      edges: [{ from: 'client', to: 'api' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { band } = groupOf(layout, 'cloud');
    const { points } = edgeOf(layout, 'client', 'api');
    assert.equal(points.length, 2);
    assert.equal(points[0]!.x, points[1]!.x);
    assert.ok(points[0]!.y < band!.y && points[1]!.y > band!.y + band!.h);
  });

  test('b2 an edge drops straight through the title band beside a centred label right above its target', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('client', 0, 0, { label: 'Client' }),
        cell('api', 1, 0, { label: 'Payments API service', group: 'cloud' }),
      ],
      groups: [
        { id: 'cloud', label: 'Cloud', titleBand: true, labelAlign: 'center' },
      ],
      edges: [{ from: 'client', to: 'api' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { band, label } = groupOf(layout, 'cloud');
    const api = box(layout, 'api');
    assert.ok(
      label[0]!.bounds.x < api.x + api.w / 2 &&
        label[0]!.bounds.x + label[0]!.bounds.w > api.x + api.w / 2,
      'the label lies right above the centre of the target',
    );
    const { points } = edgeOf(layout, 'client', 'api');
    assert.equal(points.length, 2);
    assert.equal(points[0]!.x, points[1]!.x);
    assert.ok(points[0]!.y < band!.y && points[1]!.y > band!.y + band!.h);
  });

  test('b2b a centred label wider than the source leaves no straight line, so the edge jogs around it LABEL_GAP clear', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('client', 0, 0, { label: 'DB' }),
        cell('api', 1, 0, { label: 'Payments API service', group: 'cloud' }),
      ],
      groups: [
        {
          id: 'cloud',
          label: 'Cloud platform services',
          titleBand: true,
          labelAlign: 'center',
        },
      ],
      edges: [{ from: 'client', to: 'api' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points } = edgeOf(layout, 'client', 'api');
    assert.ok(points.length <= 6, `${points.length} points`);
  });

  test('b3 an edge leaves a group downward straight through the title band of the group below', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('api', 0, 0, { label: 'Payments API service', group: 'cloud' }),
        cell('db', 1, 0, { label: 'Ledger database', group: 'store' }),
      ],
      groups: [
        { id: 'cloud', label: 'Cloud', titleBand: true },
        { id: 'store', label: 'Storage', titleBand: true },
      ],
      edges: [{ from: 'api', to: 'db' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { band } = groupOf(layout, 'store');
    const { points } = edgeOf(layout, 'api', 'db');
    assert.equal(points.length, 2);
    assert.equal(points[0]!.x, points[1]!.x);
    assert.ok(points[0]!.y < band!.y && points[1]!.y > band!.y + band!.h);
  });

  test('b4 the homelab tunnel drops straight into the gateway, and the gateway reaches istio with at most one jog inside the cluster', () => {
    // Arrange
    const ir = homelab();

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    assert.equal(
      edgeOf(layout, 'cloudflare-tunnel', 'gateway').points.length,
      2,
    );
    const { points } = edgeOf(layout, 'gateway', 'istio');
    assert.ok(points.length <= 4, `${points.length} points`);
    const cluster = rect(layout, 'cluster');
    for (const { x, y } of points) {
      assert.ok(
        x > cluster.x && x < cluster.x + cluster.w && y > cluster.y,
        `(${x}, ${y}) lies inside the cluster`,
      );
    }
  });
});

describe('layoutGraph routes the shapes of the shipped diagrams', () => {
  test('the agent workflow: lanes as group areas, a fan-out junction, and two Revise U-turns', () => {
    // Arrange
    const step = (
      id: string,
      row: number,
      col: number,
      label: string[],
      caption: string,
      rest: Partial<DiagramNode> = {},
    ): DiagramNode =>
      cell(id, row, col, {
        label,
        caption,
        captionSide: 'top',
        captionFrame: true,
        ...rest,
      });
    const lane = (
      id: string,
      label: string,
      row: number,
      rest: Partial<DiagramGroup> = {},
    ): DiagramGroup => ({
      id,
      label,
      labelAlign: 'start',
      texture: 'hatch',
      row,
      col: 3,
      rowSpan: 1,
      colSpan: 5,
      ...rest,
    });
    const ir = graph({
      nodes: [
        step('reproduce', 0, 3, ['Reproduce'], 'Workspace agent', {
          group: 'bug',
        }),
        step('create-fix', 0, 4, ['Create fix'], 'Workspace agent', {
          group: 'bug',
          colSpan: 2,
        }),
        step('review-fix', 0, 6, ['Review fix'], 'Workspace agent', {
          group: 'bug',
        }),
        step('analyze', 1, 3, ['Analyze', 'feature'], 'Agent', {
          group: 'feature',
        }),
        step('implement', 1, 4, ['Implement', 'feature'], 'Workspace agent', {
          group: 'feature',
        }),
        step('review-feature', 1, 5, ['Review', 'feature'], 'Workspace agent', {
          group: 'feature',
        }),
        step('merge', 1, 6, ['Merge'], 'Human', {
          group: 'feature',
          frame: 'filled',
        }),
        step('backports', 1, 7, ['Backports'], 'Workspace agent', {
          group: 'feature',
        }),
        step(
          'docs-change',
          2,
          4,
          ['Implement', 'docs change'],
          'Workspace agent',
          {
            group: 'documentation',
          },
        ),
        step('issue', 1, 0, ['Issue'], 'Human', { frame: 'filled' }),
        step('identify', 1, 1, ['Identify type'], 'LLM Call'),
        cell('triage-trunk', 1, 2, { kind: 'junction', hidden: true }),
      ],
      groups: [
        lane('bug', 'BUG', 0),
        lane('feature', 'FEATURE', 1),
        lane('documentation', 'DOCUMENTATION', 2, { labelSide: 'bottom' }),
      ],
      edges: [
        { from: 'issue', to: 'identify', lineStyle: 'dotted' },
        { from: 'identify', to: 'triage-trunk', headless: true },
        {
          from: 'triage-trunk',
          to: 'reproduce',
          exitSide: 'top',
          entrySide: 'left',
        },
        { from: 'triage-trunk', to: 'analyze' },
        {
          from: 'triage-trunk',
          to: 'docs-change',
          exitSide: 'bottom',
          entrySide: 'left',
        },
        {
          from: 'reproduce',
          to: 'create-fix',
          label: ['Reproduced'],
          labelFrame: true,
        },
        { from: 'create-fix', to: 'review-fix' },
        {
          from: 'review-fix',
          to: 'create-fix',
          lineStyle: 'dotted',
          exitSide: 'bottom',
          entrySide: 'bottom',
          label: ['Revise'],
          labelFrame: true,
        },
        { from: 'analyze', to: 'implement' },
        { from: 'implement', to: 'review-feature' },
        {
          from: 'review-feature',
          to: 'implement',
          lineStyle: 'dotted',
          exitSide: 'bottom',
          entrySide: 'bottom',
          label: ['Revise'],
          labelFrame: true,
        },
        { from: 'review-feature', to: 'merge', lineStyle: 'dotted' },
        { from: 'merge', to: 'backports', lineStyle: 'dotted' },
        { from: 'review-fix', to: 'merge' },
        {
          from: 'docs-change',
          to: 'merge',
          lineStyle: 'dotted',
          exitSide: 'right',
          entrySide: 'bottom',
        },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    for (const [from, to] of [
      ['review-fix', 'create-fix'],
      ['review-feature', 'implement'],
    ] as const) {
      const { points, label } = edgeOf(layout, from, to);
      assert.equal(points.length, 4, `${from}->${to} goes down, across and up`);
      assert.ok(label, `${from}->${to} has its Revise label`);
    }
  });

  test('a blog diagram: five boxes in a row, two of the four edges labelled', () => {
    // Arrange
    const steps = ['Client', 'Agent', 'Tool call', 'Stream', 'UI'];
    const ir = graph({
      nodes: steps.map((label, col) => cell(`s${col}`, 0, col, { label })),
      edges: [
        { from: 's0', to: 's1', label: ['prompt'] },
        { from: 's1', to: 's2' },
        { from: 's2', to: 's3', label: ['tool result', 'as SSE'] },
        { from: 's3', to: 's4' },
      ],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    for (const { points } of layout.edges) assert.equal(points.length, 2);
  });
});

describe('layoutGraph routes edges to a stack as one visual unit', () => {
  function stackLayout(layout: GraphLayout, id: string) {
    const found = layout.nodes.find((nodeLayout) => nodeLayout.node.id === id);
    assert.ok(found, `node "${id}" is in the layout`);
    return found;
  }

  test('s1 an edge into the left side of an up-left stack ends on the left side of its farthest back frame', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('laptop', 0, 0, { label: 'Laptop' }),
        cell('vm', 0, 1, { icon: 'server', label: 'VM', stack: 4 }),
      ],
      edges: [{ from: 'laptop', to: 'vm' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points, entrySide } = edgeOf(layout, 'laptop', 'vm');
    const farthest = stackLayout(layout, 'vm').frames[0]!;
    assert.equal(entrySide, 'left');
    close(points.at(-1)!.x, farthest.x, 'end on the farthest frame');
    const endY = points.at(-1)!.y;
    assert.ok(
      endY > farthest.y && endY < farthest.y + farthest.h,
      `end y ${endY} lies along the farthest frame`,
    );
  });

  test('s2 an edge into the top side of an up-left stack ends on the top side of its farthest back frame', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('git', 0, 0, { label: 'Git' }),
        cell('vm', 1, 0, { icon: 'server', label: 'VM', stack: 4 }),
      ],
      edges: [{ from: 'git', to: 'vm' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points, entrySide } = edgeOf(layout, 'git', 'vm');
    const farthest = stackLayout(layout, 'vm').frames[0]!;
    assert.equal(entrySide, 'top');
    close(points.at(-1)!.y, farthest.y, 'end on the farthest frame');
  });

  test('s3 an edge out of the right side of an up-left stack leaves its front frame', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('vm', 0, 0, { icon: 'server', label: 'VM', stack: 4 }),
        cell('k3s', 0, 1, { label: 'K3s' }),
      ],
      edges: [{ from: 'vm', to: 'k3s' }],
    });

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const { points, exitSide } = edgeOf(layout, 'vm', 'k3s');
    const front = box(layout, 'vm');
    assert.equal(exitSide, 'right');
    close(points[0]!.x, front.x + front.w, 'start on the front frame');
  });
});

function crossing(hints: Partial<DiagramEdge>): DiagramGraphIR {
  return graph({
    nodes: [
      cell('top-left', 0, 0, { label: 'Top left' }),
      cell('top-right', 0, 2, { label: 'Top right' }),
      cell('centre', 1, 1, { label: 'Centre' }),
      cell('bottom-left', 2, 0, { label: 'Bottom left' }),
      cell('bottom-right', 2, 2, { label: 'Bottom right' }),
    ],
    edges: [
      { from: 'top-left', to: 'bottom-right' },
      { from: 'bottom-left', to: 'top-right', ...hints },
    ],
  });
}

describe('layoutGraph tries other sides for an edge without side hints', () => {
  test('h1 two edges that cross around a centre node both route, though the sides the cells pick for the second have no route', () => {
    // Arrange
    const ir = crossing({});

    // Act
    const layout = layoutGraph(ir);

    // Assert
    assertSoundLayout(layout);
    const first = edgeOf(layout, 'top-left', 'bottom-right');
    assert.deepEqual([first.exitSide, first.entrySide], ['bottom', 'top']);
    const second = edgeOf(layout, 'bottom-left', 'top-right');
    assert.notDeepEqual([second.exitSide, second.entrySide], ['top', 'bottom']);
  });

  test('h2 an edge whose hinted sides have no route still throws, naming the hinted sides', () => {
    // Arrange
    const ir = crossing({ exitSide: 'top', entrySide: 'bottom' });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram edge bottom-left→top-right: no orthogonal route from top of "bottom-left" to bottom of "top-right" avoids the nodes and labels. Change exitSide/entrySide or move a node.',
    });
  });
});

describe('layoutGraph throws when an edge has no room', () => {
  test('a node ringed by four U-turn edges has no route out, and the error names the edge, its ends and the fix', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('island', 1, 1, { label: 'Island' }),
        cell('n', 0, 1, { label: 'N' }),
        cell('s', 2, 1, { label: 'S' }),
        cell('w', 1, 0, { label: 'W' }),
        cell('e', 1, 2, { label: 'E' }),
        cell('far', 3, 3, { label: 'Far' }),
      ],
      edges: [
        { from: 'n', to: 's', exitSide: 'left', entrySide: 'left' },
        { from: 'w', to: 'e', exitSide: 'top', entrySide: 'top' },
        { from: 's', to: 'n', exitSide: 'right', entrySide: 'right' },
        { from: 'e', to: 'w', exitSide: 'bottom', entrySide: 'bottom' },
        { from: 'island', to: 'far' },
      ],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram edge island→far: no orthogonal route from bottom of "island" to top of "far" avoids the nodes and labels. Change exitSide/entrySide or move a node.',
    });
  });

  test('a label taller than the room beside its route names the edge, the label and its size', () => {
    // Arrange
    const edge: DiagramEdge = {
      from: 'a',
      to: 'b',
      label: Array.from({ length: 12 }, (_, line) => `line ${line}`),
    };
    const ir = graph({
      nodes: [
        cell('roof', 0, 0, { label: 'Roof', colSpan: 2 }),
        cell('a', 1, 0, { label: 'A' }),
        cell('b', 1, 1, { label: 'B' }),
        cell('floor', 2, 0, { label: 'Floor', colSpan: 2 }),
      ],
      edges: [edge],
    });
    const { w, h } = measureEdgeLabel(edge);

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message: `Diagram edge a→b: label "${edge.label!.join(' / ')}" (${Math.ceil(w)}×${Math.ceil(h)}) has no free position beside its route.`,
    });
  });

  test('an edge on a side that declares ports, without naming one, names the node, the side and the edge', () => {
    // Arrange
    const ir = graph({
      nodes: [
        cell('router', 0, 0, {
          label: 'Router',
          ports: [{ id: 'lan1', side: 'right' }],
        }),
        cell('adguard', 0, 1, { label: 'AdGuard' }),
      ],
      edges: [{ from: 'router', to: 'adguard' }],
    });

    // Act + Assert
    assert.throws(() => layoutGraph(ir), {
      message:
        'Diagram node "router" side right declares ports; edge router→adguard must use "router:<port>".',
    });
  });
});
