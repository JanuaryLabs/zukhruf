import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type InvariantCode,
  layoutViolations,
} from '../../../testing/sound-layout.ts';
import type { Box, DiagramGroup, DiagramNode } from '../../model/diagram-ir.ts';
import type { GraphLayout } from './graph-layout-result.ts';
import {
  type MeasuredNode,
  measureEdgeBadge,
  measureEdgeLabel,
  measureGroupTitle,
  measureNode,
} from './measure.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

/** One node placed at `box`, in a viewBox that is the box grown by the node's measured overhang. */
function placedAlone(measured: MeasuredNode, box: Box): GraphLayout {
  const { top, right, bottom, left } = measured.overhang;
  const node = { id: 'n', label: '' } satisfies DiagramNode;
  return {
    nodes: [{ node, ...measured.place(box) }],
    groups: [],
    edges: [],
    leaders: [],
    viewBox: {
      x: box.x - left,
      y: box.y - top,
      w: box.w + left + right,
      h: box.h + top + bottom,
    },
  };
}

function contentViolations(
  layout: GraphLayout,
  codes: InvariantCode[],
  textInset?: number,
) {
  return layoutViolations(layout, textInset === undefined ? {} : { textInset })
    .filter((violation) => codes.includes(violation.invariant))
    .map((violation) => `${violation.invariant} ${violation.message}`);
}

function intrinsicBox(measured: MeasuredNode): Box {
  return { x: 40, y: 40, ...measured.frame };
}

function stretchedBox(measured: MeasuredNode): Box {
  return {
    x: 40,
    y: 40,
    w: measured.frame.w + 120,
    h: measured.frame.h + 80,
  };
}

function inside(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 0.01 &&
    inner.y >= outer.y - 0.01 &&
    inner.x + inner.w <= outer.x + outer.w + 0.01 &&
    inner.y + inner.h <= outer.y + outer.h + 0.01
  );
}

/** `inset` is the padding the variant keeps between its frame and its text. */
const variants: { name: string; inset: number; node: DiagramNode }[] = [
  {
    name: 'a Box without an icon',
    inset: 12,
    node: {
      id: 'n',
      label: ['Istio Ingress Gateway', '(North-South Gateway)'],
    },
  },
  {
    name: 'a Box with an icon',
    inset: 12,
    node: {
      id: 'n',
      icon: 'shield',
      label: ['Istio Ingress Gateway', '(North-South Gateway)'],
    },
  },
  {
    name: 'a Card with a description and items',
    inset: 12,
    node: {
      id: 'n',
      icon: 'gpu',
      textAlign: 'start',
      label: 'GPU Workflow',
      description: ['GPU Workflow', 'NVIDIA RTX 3050'],
      items: ['K3s Node Affinity', 'Automatic GPU Scheduling'],
    },
  },
  {
    name: 'a Card whose icon and title are its widest line',
    inset: 12,
    node: {
      id: 'n',
      icon: 'kubernetes',
      textAlign: 'start',
      label: 'Kubernetes Control Plane',
      description: 'k3s',
      items: ['etcd'],
    },
  },
  {
    name: 'a start-aligned Card with only a title',
    inset: 12,
    node: {
      id: 'n',
      textAlign: 'start',
      label: ['K3s Master', 'Control plane'],
    },
  },
  {
    name: 'a Port',
    inset: 12,
    node: { id: 'n', frame: 'transparent', label: 'eth0 uplink' },
  },
  {
    name: 'a Label',
    inset: 4,
    node: { id: 'n', frame: 'none', label: 'Home network' },
  },
  {
    name: 'a Float',
    inset: 12,
    node: { id: 'n', frame: 'flat', label: 'Proxmox VE' },
  },
  {
    name: 'a marker',
    inset: 4,
    node: { id: 'n', kind: 'marker', icon: 'user', label: ['Laptop', 'Admin'] },
  },
  {
    name: 'an appliance',
    inset: 4,
    node: {
      id: 'n',
      kind: 'appliance',
      label: 'Fritzbox Router 7590 AX',
      appliancePorts: 4,
    },
  },
  {
    name: 'a connector with an icon',
    inset: 4,
    node: {
      id: 'n',
      kind: 'connector',
      icon: 'tunnel',
      label: ['Cloudflare Tunnel', 'cloudflared'],
    },
  },
  {
    name: 'a connector without an icon',
    inset: 4,
    node: { id: 'n', kind: 'connector', label: 'Service Mesh' },
  },
  {
    name: 'a junction',
    inset: 4,
    node: { id: 'n', kind: 'junction', label: '' },
  },
  {
    name: 'a note',
    inset: 4,
    node: {
      id: 'n',
      kind: 'note',
      target: 'cert-manager',
      label: ["Let's Encrypt", 'DNS-01 challenge'],
    },
  },
  {
    name: 'a stacked Box with a caption above',
    inset: 12,
    node: {
      id: 'n',
      icon: 'server',
      label: 'Virtual Machines',
      stack: 4,
      caption: 'VM',
      captionSide: 'top',
    },
  },
  {
    name: 'a Box with a framed caption on the left',
    inset: 12,
    node: {
      id: 'n',
      label: 'AdGuard Home',
      caption: ['DNS Forwarder', 'port 53'],
      captionSide: 'left',
      captionFrame: true,
    },
  },
  {
    name: 'a Box with labelled ports on every side',
    inset: 12,
    node: {
      id: 'n',
      label: 'Switch',
      ports: [
        { id: 'a', side: 'left', label: 'eth0' },
        { id: 'b', side: 'left', label: 'eth1' },
        { id: 'c', side: 'right', label: 'uplink' },
        { id: 'd', side: 'top', label: 'mgmt' },
        { id: 'e', side: 'bottom', label: 'console' },
      ],
    },
  },
];

describe('measureNode', () => {
  for (const { name, inset, node } of variants) {
    test(`${name} keeps its text inside its padding, at its measured size`, () => {
      // Arrange
      const measured = measureNode(node);

      // Act
      const layout = placedAlone(measured, intrinsicBox(measured));

      // Assert
      assert.deepEqual(contentViolations(layout, ['N2'], inset), []);
    });

    test(`${name} keeps its text inside its padding and its drawing inside the overhang it measured, in a larger area`, () => {
      // Arrange
      const measured = measureNode(node);

      // Act
      const layout = placedAlone(measured, stretchedBox(measured));

      // Assert
      assert.deepEqual(contentViolations(layout, ['N2', 'V1'], inset), []);
    });
  }

  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    test(`a caption on the ${side} sits CAPTION_GAP outside the frame, and the overhang on that side reaches its far edge`, () => {
      // Arrange
      const measured = measureNode({
        id: 'n',
        label: 'AdGuard Home',
        caption: ['DNS Forwarder', 'port 53'],
        captionSide: side,
      });
      const box = intrinsicBox(measured);

      // Act
      const { caption } = measured.place(box);

      // Assert
      const near = {
        top: box.y - (caption!.box.y + caption!.box.h),
        bottom: caption!.box.y - (box.y + box.h),
        left: box.x - (caption!.box.x + caption!.box.w),
        right: caption!.box.x - (box.x + box.w),
      }[side];
      const depth =
        side === 'top' || side === 'bottom' ? caption!.box.h : caption!.box.w;
      assert.ok(
        Math.abs(near - LAYOUT_TOKENS.CAPTION_GAP) < 0.01,
        `gap ${near}`,
      );
      assert.ok(
        Math.abs(
          measured.overhang[side] - (LAYOUT_TOKENS.CAPTION_GAP + depth),
        ) < 0.01,
        `overhang ${measured.overhang[side]}`,
      );
    });
  }

  test('a Box grows wider with its longest line', () => {
    // Arrange

    // Act
    const short = measureNode({ id: 'n', icon: 'shield', label: 'Gateway' });
    const long = measureNode({
      id: 'n',
      icon: 'shield',
      label: ['Gateway', 'Istio Ingress Gateway', '(North-South Gateway)'],
    });

    // Assert
    assert.ok(
      long.frame.w > short.frame.w + 60,
      `"Gateway" is ${short.frame.w}px wide and "Istio Ingress Gateway" is ${long.frame.w}px`,
    );
  });

  test('a Card places its title, then its description, then its items, top to bottom, all above the bottom padding', () => {
    // Arrange
    const measured = measureNode({
      id: 'n',
      icon: 'gpu',
      textAlign: 'start',
      label: 'GPU Workflow',
      description: 'NVIDIA RTX 3050',
      items: ['K3s Node Affinity', 'Automatic GPU Scheduling', 'Time slicing'],
    });
    const box = intrinsicBox(measured);

    // Act
    const { text, bullets } = measured.place(box);

    // Assert
    assert.deepEqual(
      text.map((run) => run.text),
      [
        'GPU Workflow',
        'NVIDIA RTX 3050',
        'K3s Node Affinity',
        'Automatic GPU Scheduling',
        'Time slicing',
      ],
    );
    for (const [index, run] of text.slice(1).entries()) {
      assert.ok(
        run.bounds.y >= text[index]!.bounds.y + text[index]!.bounds.h,
        `"${run.text}" starts above the end of "${text[index]!.text}"`,
      );
    }
    const last = text.at(-1)!.bounds;
    assert.ok(last.y + last.h <= box.y + box.h - LAYOUT_TOKENS.PAD_Y + 0.01);
    assert.equal(bullets.length, 3);
  });

  test('a Card keeps its content at the top-left padding when it fills a larger area', () => {
    // Arrange
    const measured = measureNode({
      id: 'n',
      textAlign: 'start',
      label: 'Authentik',
      description: 'Identity provider',
    });
    const box = stretchedBox(measured);

    // Act
    const { text } = measured.place(box);

    // Assert
    assert.equal(text[0]!.bounds.x, box.x + LAYOUT_TOKENS.PAD_X);
    assert.ok(text[0]!.bounds.y < box.y + LAYOUT_TOKENS.PAD_Y + 4);
  });

  test('a Box with an icon centres its icon and lines together when it fills a larger area', () => {
    // Arrange
    const measured = measureNode({
      id: 'n',
      icon: 'shield',
      label: 'Istio Ingress Gateway',
    });
    const box = stretchedBox(measured);

    // Act
    const { icon, text } = measured.place(box);

    // Assert
    const left = icon!.x;
    const right = text[0]!.bounds.x + text[0]!.bounds.w;
    assert.ok(Math.abs(left - box.x - (box.x + box.w - right)) <= 1);
  });

  test('a side with more ports than fit makes the frame longer on that side, and spreads the ports evenly', () => {
    // Arrange
    const ports = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      id,
      side: 'left' as const,
    }));

    // Act
    const plain = measureNode({ id: 'n', label: 'Switch' });
    const measured = measureNode({ id: 'n', label: 'Switch', ports });
    const placed = measured.place(intrinsicBox(measured));

    // Assert
    assert.ok(plain.frame.h < 7 * LAYOUT_TOKENS.PORT_SPACING);
    assert.ok(measured.frame.h >= 7 * LAYOUT_TOKENS.PORT_SPACING);
    const ys = placed.ports.map((port) => port.point.y);
    const gaps = ys.slice(1).map((y, index) => y - ys[index]!);
    assert.ok(gaps.every((gap) => Math.abs(gap - gaps[0]!) < 0.01));
    assert.ok(gaps[0]! >= LAYOUT_TOKENS.PORT_SPACING);
    assert.ok(placed.ports.every((port) => port.point.x === placed.box.x));
  });

  test('labelled ports on a side widen the frame by their labels', () => {
    // Arrange

    // Act
    const plain = measureNode({ id: 'n', label: 'Switch' });
    const labelled = measureNode({
      id: 'n',
      label: 'Switch',
      ports: [{ id: 'a', side: 'left', label: 'management-uplink' }],
    });

    // Assert
    assert.ok(labelled.frame.w > plain.frame.w + 60);
  });

  test('a stack and a caption reach outside the frame by the overhang, and only Box-like nodes stretch', () => {
    // Arrange

    // Act
    const stacked = measureNode({
      id: 'n',
      label: 'VM',
      stack: 3,
      stackDirection: 'down-right',
    });
    const marker = measureNode({ id: 'n', kind: 'marker', label: 'Laptop' });
    const pinned = measureNode({ id: 'n', label: 'VM', stretch: false });

    // Assert
    assert.deepEqual(stacked.overhang, {
      top: 0,
      left: 0,
      right: 2 * LAYOUT_TOKENS.STACK_STEP.x,
      bottom: 2 * LAYOUT_TOKENS.STACK_STEP.y,
    });
    assert.equal(stacked.stretch, true);
    assert.equal(marker.stretch, false);
    assert.equal(pinned.stretch, false);
  });

  test('a hidden node measures to nothing, and a hidden junction still holds its square', () => {
    // Arrange

    // Act
    const phantom = measureNode({ id: 'n', label: '', hidden: true });
    const junction = measureNode({
      id: 'n',
      kind: 'junction',
      label: '',
      hidden: true,
    });

    // Assert
    assert.deepEqual(phantom.frame, { w: 0, h: 0 });
    assert.deepEqual(junction.frame, {
      w: LAYOUT_TOKENS.JUNCTION,
      h: LAYOUT_TOKENS.JUNCTION,
    });
  });

  test('a line carries its own colour and the nearest font weight', () => {
    // Arrange
    const measured = measureNode({
      id: 'n',
      textColor: 'neutral',
      label: [
        { text: 'Grafana', fontWeight: 680 },
        { text: 'dashboards', textColor: 'dim', fontWeight: 420 },
        'metrics',
      ],
    });

    // Act
    const { text } = measured.place(intrinsicBox(measured));

    // Assert
    assert.deepEqual(
      text.map((run) => [run.font.weight, run.color]),
      [
        [700, 'neutral'],
        [400, 'dim'],
        [500, 'neutral'],
      ],
    );
  });

  test('a note draws its lines dim by default', () => {
    // Arrange
    const measured = measureNode({
      id: 'n',
      kind: 'note',
      label: 'Issues the TLS certificates',
    });

    // Act
    const { text } = measured.place(intrinsicBox(measured));

    // Assert
    assert.equal(text[0]!.color, 'dim');
  });

  test('a glyph the font has no width for throws the measuring error', () => {
    // Act & Assert
    assert.throws(() => measureNode({ id: 'n', label: 'Tokyo 東京' }), {
      message:
        'Cannot measure "Tokyo 東京": U+6771 has no glyph in the mono face at weight 500',
    });
  });
});

describe('measureGroupTitle', () => {
  const group = (overrides: Partial<DiagramGroup>): DiagramGroup => ({
    id: 'g',
    label: ['Kubernetes Cluster', 'k3s'],
    ...overrides,
  });

  for (const labelSide of ['top', 'bottom'] as const) {
    for (const labelAlign of ['start', 'center', 'end'] as const) {
      test(`a ${labelAlign}-aligned title band on the ${labelSide} holds its label`, () => {
        // Arrange
        const title = measureGroupTitle(
          group({ titleBand: true, labelSide, labelAlign }),
        );
        const rect = { x: 20, y: 20, w: 400, h: 300 };

        // Act
        const { band, label } = title.place(rect);

        // Assert
        assert.equal(band!.h, title.height);
        assert.equal(
          labelSide === 'top' ? band!.y : band!.y + band!.h,
          labelSide === 'top' ? rect.y : rect.y + rect.h,
        );
        const layout: GraphLayout = {
          nodes: [],
          groups: [
            {
              group: group({}),
              depth: 0,
              rect,
              band: band!,
              label,
              dividers: [],
              ports: [],
            },
          ],
          edges: [],
          leaders: [],
          viewBox: rect,
        };
        assert.deepEqual(contentViolations(layout, ['G1']), []);
        const expected = {
          start: { x: rect.x + 16, anchor: 'start' },
          center: { x: rect.x + rect.w / 2, anchor: 'middle' },
          end: { x: rect.x + rect.w - 16, anchor: 'end' },
        }[labelAlign];
        for (const run of label) {
          assert.deepEqual({ x: run.x, anchor: run.anchor }, expected);
        }
      });
    }
  }

  test('a title without a band reserves the same height and draws no band', () => {
    // Arrange
    const banded = measureGroupTitle(group({ titleBand: true }));
    const plain = measureGroupTitle(group({}));

    // Act
    const placed = plain.place({ x: 0, y: 0, w: 300, h: 200 });

    // Assert
    assert.equal(plain.height, banded.height);
    assert.equal(placed.band, undefined);
    assert.equal(placed.label.length, 2);
  });

  test('a group without a label reserves no height', () => {
    // Act
    const title = measureGroupTitle(group({ label: [] }));

    // Assert
    assert.equal(title.height, 0);
    assert.deepEqual(title.place({ x: 0, y: 0, w: 100, h: 100 }).label, []);
  });
});

describe('measureEdgeLabel', () => {
  test('a label box holds its lines, and a frame adds its padding on every side', () => {
    // Arrange
    const edge = { from: 'a', to: 'b', label: ['HTTPS 443', 'mTLS'] };

    // Act
    const plain = measureEdgeLabel(edge);
    const framed = measureEdgeLabel({ ...edge, labelFrame: true });
    const box = { x: 100, y: 50, w: framed.w, h: framed.h };
    const runs = framed.place(box);

    // Assert
    assert.equal(framed.w, plain.w + 8);
    assert.equal(framed.h, plain.h + 8);
    assert.equal(runs.length, 2);
    const padded = { x: box.x + 4, y: box.y + 4, w: box.w - 8, h: box.h - 8 };
    for (const run of runs) {
      assert.ok(
        inside(padded, run.bounds),
        `"${run.text}" lies outside its padded box`,
      );
    }
  });

  test('a badge holds its icon and its lines', () => {
    // Arrange
    const measured = measureEdgeBadge({
      from: 'a',
      to: 'b',
      badgeIcon: 'certificate',
      badgeLabel: ['TLS'],
    });
    const box = { x: 10, y: 10, w: measured.w, h: measured.h };

    // Act
    const { icon, text } = measured.place(box);

    // Assert
    assert.ok(inside(box, icon!));
    assert.ok(inside(box, text[0]!.bounds));
    assert.ok(text[0]!.bounds.x >= icon!.x + icon!.w);
  });
});
