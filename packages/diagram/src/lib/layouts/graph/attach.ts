import type { Box, Point } from '../../model/diagram-ir.ts';
import type { Connection, ConnectionEnd } from './connections.ts';
import { GRID } from './route-search.ts';
import {
  OPPOSITE,
  beyond,
  isVertical,
  pointOnSide,
  sideLine,
  sideSpan,
} from './sides.ts';
import { LAYOUT_TOKENS } from './tokens.ts';

/** Where a connection touches its two shapes, and where its stubs leave them. */
export type Attachment = {
  start: Point;
  startStub: Point;
  end: Point;
  endStub: Point;
};

/** The closest two slots on one side may lie: two grid lines, so their routes keep a line between them. */
const SLOT_PITCH = 2 * GRID;

type Slot = { connection: number; role: 'from' | 'to'; end: ConnectionEnd };
type Interval = [number, number];

/**
 * Picks where every connection touches its shapes. A junction end is its
 * centre and a port end is its port. The other ends that share a side of a
 * shape split the free part of it, clear of the corners and of a caption on
 * that side, into even slots, ordered by where their other ends lie, so they
 * do not cross. A connection alone on two facing sides that overlap runs
 * straight across the middle of the overlap.
 */
export function attachConnections(connections: Connection[]): Attachment[] {
  const fixed = (end: ConnectionEnd): Point | undefined => {
    if (end.port) return end.port.point;
    if (end.shape.kind === 'junction') return centre(end.shape.box);
    return undefined;
  };

  const bySide = new Map<string, Slot[]>();
  for (const [index, connection] of connections.entries()) {
    for (const role of ['from', 'to'] as const) {
      const end = connection[role];
      if (fixed(end)) continue;
      const key = sideKey(end);
      bySide.set(key, [
        ...(bySide.get(key) ?? []),
        { connection: index, role, end },
      ]);
    }
  }
  const crowd = (end: ConnectionEnd) => bySide.get(sideKey(end))!.length;

  /** Where each slot end touches its side, by `${connection}:${role}`. */
  const touches = new Map<string, Point>();
  const touchKey = (connection: number, role: 'from' | 'to') =>
    `${connection}:${role}`;
  for (const [index, { from, to }] of connections.entries()) {
    const aligned = facingAlignment(from, to, fixed(from), fixed(to), crowd);
    if (aligned) {
      touches.set(touchKey(index, 'from'), aligned.from);
      touches.set(touchKey(index, 'to'), aligned.to);
    }
  }

  for (const slots of bySide.values()) {
    const open = slots.filter(
      ({ connection, role }) => !touches.has(touchKey(connection, role)),
    );
    if (open.length === 0) continue;
    const { end } = slots[0]!;
    const vertical = isVertical(end.side);
    const otherAt = ({ connection, role }: Slot) => {
      const other = connections[connection]![role === 'from' ? 'to' : 'from'];
      const at = fixed(other) ?? centre(other.shape.box);
      return vertical ? at.x : at.y;
    };
    const ordered = open
      .map((slot, order) => ({ slot, order, at: otherAt(slot) }))
      .sort((a, b) => a.at - b.at || a.order - b.order);
    const alongs = spread(end, ordered.length);
    for (const [index, { slot }] of ordered.entries()) {
      touches.set(
        touchKey(slot.connection, slot.role),
        pointOnSide(end.shape.box, end.side, alongs[index]!),
      );
    }
  }

  return connections.map((connection, index) => {
    const start =
      fixed(connection.from) ?? touches.get(touchKey(index, 'from'))!;
    const end = fixed(connection.to) ?? touches.get(touchKey(index, 'to'))!;
    const stub = stubLength(connection, start, end);
    return {
      start,
      startStub: beyond(start, connection.from.side, stub),
      end,
      endStub: beyond(end, connection.to.side, stub),
    };
  });
}

/**
 * The parts of a side a connection may touch: the side less its corner
 * inset, less what lies behind a caption on that side. A short side gives up
 * its corner inset before its slots come closer than SLOT_PITCH.
 */
function freeIntervals(end: ConnectionEnd, count: number): Interval[] {
  const { shape, side } = end;
  const [from, to] = sideSpan(shape.box, side);
  const inset = Math.max(
    0,
    Math.min(shape.radius, (to - from - (count + 1) * SLOT_PITCH) / 2),
  );
  const vertical = isVertical(side);
  const line = sideLine(shape.box, side);
  const outward = side === 'bottom' || side === 'right';
  const behind = shape.clear.flatMap((box): Interval[] => {
    const [near, far] = vertical
      ? [box.y, box.y + box.h]
      : [box.x, box.x + box.w];
    if (outward ? near < line : far > line) return [];
    return vertical
      ? [[box.x - SLOT_PITCH, box.x + box.w + SLOT_PITCH]]
      : [[box.y - SLOT_PITCH, box.y + box.h + SLOT_PITCH]];
  });
  let free: Interval[] = [[from + inset, to - inset]];
  for (const [cutStart, cutEnd] of behind) {
    free = free
      .flatMap(([a, b]): Interval[] => [
        [a, Math.min(b, cutStart)],
        [Math.max(a, cutEnd), b],
      ])
      .filter(([low, high]) => high > low);
  }
  return free;
}

/**
 * Positions for `count` slots on the free parts of a side, in order along
 * it: each next slot goes to the part where slots would lie farthest apart,
 * and each part spaces its slots evenly.
 */
function spread(end: ConnectionEnd, count: number): number[] {
  const intervals = freeIntervals(end, count);
  const counts = intervals.map(() => 0);
  const pitchWithOneMore = (index: number) =>
    (intervals[index]![1] - intervals[index]![0]) / (counts[index]! + 2);
  for (let placed = 0; placed < count && intervals.length > 0; placed++) {
    const roomiest = counts.reduce(
      (best, _, index) =>
        pitchWithOneMore(index) > pitchWithOneMore(best) ? index : best,
      0,
    );
    counts[roomiest] = counts[roomiest]! + 1;
  }
  const alongs = intervals.flatMap(([a, b], index) =>
    Array.from(
      { length: counts[index]! },
      (_, slot) => a + ((slot + 1) / (counts[index]! + 1)) * (b - a),
    ),
  );
  const closest = Math.min(
    ...intervals.flatMap(([a, b], index) =>
      counts[index]! > 1 ? [(b - a) / (counts[index]! + 1)] : [],
    ),
  );
  if (alongs.length < count || closest < SLOT_PITCH) {
    const { shape, side } = end;
    throw new Error(
      `Diagram ${shape.kind === 'group' ? 'group' : 'node'} "${shape.id}" side ${side} has no room for ${count} connections ${SLOT_PITCH}px apart beside its corners and caption.`,
    );
  }
  return alongs;
}

/** Both ends on the middle of the overlap of two facing sides, when the connection is alone on each. */
function facingAlignment(
  from: ConnectionEnd,
  to: ConnectionEnd,
  fromFixed: Point | undefined,
  toFixed: Point | undefined,
  crowd: (end: ConnectionEnd) => number,
): { from: Point; to: Point } | undefined {
  if (to.side !== OPPOSITE[from.side] || (fromFixed && toFixed)) return;
  if (!fromFixed && crowd(from) !== 1) return;
  if (!toFixed && crowd(to) !== 1) return;
  const vertical = isVertical(from.side);
  const free = (end: ConnectionEnd, at: Point | undefined): Interval[] => {
    if (!at) return freeIntervals(end, 1);
    const along = vertical ? at.x : at.y;
    return [[along, along]];
  };
  const widest = free(from, fromFixed)
    .flatMap(([a0, a1]) =>
      free(to, toFixed).map(([b0, b1]): Interval => [
        Math.max(a0, b0),
        Math.min(a1, b1),
      ]),
    )
    .filter(([low, high]) => low <= high)
    .sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
  if (!widest) return;
  const along = (widest[0] + widest[1]) / 2;
  return {
    from: fromFixed ?? pointOnSide(from.shape.box, from.side, along),
    to: toFixed ?? pointOnSide(to.shape.box, to.side, along),
  };
}

/**
 * A stub is STUB long, except between two ends that face each other closer
 * than two stubs: then each stub reaches half way, so they meet in the gap.
 */
function stubLength(connection: Connection, start: Point, end: Point): number {
  const { from, to } = connection;
  if (to.side !== OPPOSITE[from.side]) return LAYOUT_TOKENS.STUB;
  const gap =
    (isVertical(from.side) ? end.y - start.y : end.x - start.x) *
    (from.side === 'bottom' || from.side === 'right' ? 1 : -1);
  return gap > 0 && gap < 2 * LAYOUT_TOKENS.STUB ? gap / 2 : LAYOUT_TOKENS.STUB;
}

function sideKey(end: ConnectionEnd): string {
  return `${end.shape.id}\u0000${end.side}`;
}

function centre(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}
