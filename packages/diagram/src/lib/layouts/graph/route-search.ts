import type { Box, Point } from '../../model/diagram-ir.ts';
import { MinHeap } from './min-heap.ts';

/** A direction of travel: right, left, down, up. */
export type Heading = 0 | 1 | 2 | 3;

/** The routing grid's pitch. */
export const GRID = 4;
const TURN_COST = 14;
const EDGE_CROSSING_COST = 20;
const BORDER_CROSSING_COST = 6;
/** Charged for every grid step that runs parallel to a group border within HUG_DISTANCE of it. */
const BORDER_HUG_COST = 10;
const HUG_DISTANCE = 4;
/** A run of another edge closer than this to a grid line lies on that line. */
const RUN_TOLERANCE = GRID / 2;

const STEPS: Record<Heading, [number, number]> = {
  0: [1, 0],
  1: [-1, 0],
  2: [0, 1],
  3: [0, -1],
};
const HEADINGS: Heading[] = [0, 1, 2, 3];

const REVERSE: Record<Heading, Heading> = { 0: 1, 1: 0, 2: 3, 3: 2 };

function reverse(heading: Heading): Heading {
  return REVERSE[heading];
}

function isHorizontal(heading: Heading): boolean {
  return heading < 2;
}

export type RouteSearch = {
  /** Only grid points inside this box are searched. */
  window: Box;
  /** Coordinates the grid holds besides every multiple of GRID: the route's own ends, slots and stubs. */
  lines: { x: number[]; y: number[] };
  /** No route passes a grid point strictly inside one of these. */
  walls: Box[];
  /** Segments of routes already drawn: a route may cross them at a cost, never run along them. */
  runs: [Point, Point][];
  /** Group rects and title bands: crossing or hugging their borders costs extra. */
  borders: Box[];
  start: Point;
  /** The heading of the stub that reaches `start`. */
  startHeading: Heading;
  goal: Point;
  /** The heading of the stub that leaves `goal` for the entry side. */
  goalHeading: Heading;
};

/**
 * The cheapest orthogonal path from `start` to `goal` on a grid of GRID
 * pitch, or undefined when the walls leave none. The search state is a grid
 * point together with the heading that reached it, so a turn costs the same
 * whichever way a point was reached.
 */
export function searchRoute(search: RouteSearch): Point[] | undefined {
  const grid = new SearchGrid(search);
  const start = grid.indexOf(search.start);
  const goal = grid.indexOf(search.goal);
  if (start === undefined || goal === undefined) return undefined;
  if (grid.blocked[start] || grid.blocked[goal]) return undefined;

  const states = grid.cells * 4;
  const virtualGoal = states;
  const cost = new Float64Array(states + 1).fill(Infinity);
  const cameFrom = new Int32Array(states + 1).fill(-1);
  const open = new MinHeap<number>();
  const startState = start * 4 + search.startHeading;
  cost[startState] = 0;
  open.push(startState, grid.estimate(start, goal));

  while (open.size > 0) {
    const state = open.pop()!;
    if (state === virtualGoal) return grid.trace(cameFrom, cameFrom[state]!);
    const cell = state >> 2;
    const heading = HEADINGS[state & 3]!;
    const reached = cost[state]!;
    if (cell === goal) {
      if (heading === reverse(search.goalHeading)) continue;
      const total = reached + (heading === search.goalHeading ? 0 : TURN_COST);
      if (total < cost[virtualGoal]!) {
        cost[virtualGoal] = total;
        cameFrom[virtualGoal] = state;
        open.push(virtualGoal, total);
      }
      continue;
    }
    for (const next of HEADINGS) {
      if (next === reverse(heading)) continue;
      const step = grid.step(cell, next);
      if (step === undefined) continue;
      const nextState = step.cell * 4 + next;
      const total = reached + step.cost + (next === heading ? 0 : TURN_COST);
      if (total >= cost[nextState]!) continue;
      cost[nextState] = total;
      cameFrom[nextState] = state;
      open.push(nextState, total + grid.estimate(step.cell, goal));
    }
  }
  return undefined;
}

/** The grid points of one search, with what each one costs to enter. */
class SearchGrid {
  readonly xs: number[];
  readonly ys: number[];
  readonly cells: number;
  readonly blocked: Uint8Array;
  readonly #alongRunH: Uint8Array;
  readonly #alongRunV: Uint8Array;
  /** Group borders between grid column i − 1 and column i, at each row. */
  readonly #bordersBeforeX: Uint8Array;
  readonly #bordersBeforeY: Uint8Array;
  readonly #hugH: Uint8Array;
  readonly #hugV: Uint8Array;

  constructor(search: RouteSearch) {
    const { window } = search;
    this.xs = axis(window.x, window.x + window.w, search.lines.x);
    this.ys = axis(window.y, window.y + window.h, search.lines.y);
    this.cells = this.xs.length * this.ys.length;
    this.blocked = new Uint8Array(this.cells);
    this.#alongRunH = new Uint8Array(this.cells);
    this.#alongRunV = new Uint8Array(this.cells);
    this.#bordersBeforeX = new Uint8Array(this.cells);
    this.#bordersBeforeY = new Uint8Array(this.cells);
    this.#hugH = new Uint8Array(this.cells);
    this.#hugV = new Uint8Array(this.cells);

    for (const wall of search.walls) {
      this.#fill(
        this.blocked,
        strictlyInside(this.xs, wall.x, wall.x + wall.w),
        strictlyInside(this.ys, wall.y, wall.y + wall.h),
      );
    }
    for (const [a, b] of search.runs) {
      if (a.y === b.y) {
        this.#fill(
          this.#alongRunH,
          within(this.xs, Math.min(a.x, b.x), Math.max(a.x, b.x)),
          near(this.ys, a.y, RUN_TOLERANCE),
        );
      } else {
        this.#fill(
          this.#alongRunV,
          near(this.xs, a.x, RUN_TOLERANCE),
          within(this.ys, Math.min(a.y, b.y), Math.max(a.y, b.y)),
        );
      }
    }
    for (const rect of search.borders) {
      const rows = within(this.ys, rect.y, rect.y + rect.h);
      const cols = within(this.xs, rect.x, rect.x + rect.w);
      for (const x of [rect.x, rect.x + rect.w]) {
        this.#fill(this.#bordersBeforeX, crossedBefore(this.xs, x), rows);
        this.#fill(this.#hugV, near(this.xs, x, HUG_DISTANCE + 1e-6), rows);
      }
      for (const y of [rect.y, rect.y + rect.h]) {
        this.#fill(this.#bordersBeforeY, cols, crossedBefore(this.ys, y));
        this.#fill(this.#hugH, cols, near(this.ys, y, HUG_DISTANCE + 1e-6));
      }
    }
  }

  indexOf(point: Point): number | undefined {
    const i = this.xs.indexOf(point.x);
    const j = this.ys.indexOf(point.y);
    return i === -1 || j === -1 ? undefined : j * this.xs.length + i;
  }

  /** A lower bound on the cost from `cell` to `goal`: one unit per GRID of distance. */
  estimate(cell: number, goal: number): number {
    const width = this.xs.length;
    return (
      (Math.abs(this.xs[cell % width]! - this.xs[goal % width]!) +
        Math.abs(
          this.ys[Math.floor(cell / width)]! -
            this.ys[Math.floor(goal / width)]!,
        )) /
      GRID
    );
  }

  step(
    cell: number,
    heading: Heading,
  ): { cell: number; cost: number } | undefined {
    const width = this.xs.length;
    const i = cell % width;
    const j = Math.floor(cell / width);
    const [di, dj] = STEPS[heading];
    const ni = i + di;
    const nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= width || nj >= this.ys.length)
      return undefined;
    const next = nj * width + ni;
    if (this.blocked[next]) return undefined;
    const horizontal = isHorizontal(heading);
    if ((horizontal ? this.#alongRunH : this.#alongRunV)[next])
      return undefined;
    const length = horizontal
      ? Math.abs(this.xs[ni]! - this.xs[i]!)
      : Math.abs(this.ys[nj]! - this.ys[j]!);
    const crossed = horizontal
      ? this.#bordersBeforeX[j * width + Math.max(i, ni)]!
      : this.#bordersBeforeY[Math.max(j, nj) * width + i]!;
    const hugs = (horizontal ? this.#hugH : this.#hugV)[next]! > 0;
    const crossesRun =
      (horizontal ? this.#alongRunV : this.#alongRunH)[next]! > 0;
    return {
      cell: next,
      cost:
        length / GRID +
        crossed * BORDER_CROSSING_COST +
        (hugs ? (BORDER_HUG_COST * length) / GRID : 0) +
        (crossesRun ? EDGE_CROSSING_COST : 0),
    };
  }

  trace(cameFrom: Int32Array, last: number): Point[] {
    const width = this.xs.length;
    const points: Point[] = [];
    for (let state = last; state !== -1; state = cameFrom[state]!) {
      const cell = state >> 2;
      points.push({
        x: this.xs[cell % width]!,
        y: this.ys[Math.floor(cell / width)]!,
      });
    }
    return points.reverse();
  }

  #fill(target: Uint8Array, cols: number[], rows: number[]): void {
    const width = this.xs.length;
    for (const j of rows) for (const i of cols) target[j * width + i]! += 1;
  }
}

/** Every multiple of GRID in [from, to], with the extra lines inside it, sorted and distinct. */
function axis(from: number, to: number, extra: number[]): number[] {
  const values = new Set<number>();
  for (let v = Math.ceil(from / GRID) * GRID; v <= to; v += GRID) values.add(v);
  for (const v of extra) if (v >= from && v <= to) values.add(v);
  return [...values].sort((a, b) => a - b);
}

function indicesWhere(
  values: number[],
  keep: (value: number) => boolean,
): number[] {
  const indices: number[] = [];
  for (const [index, value] of values.entries())
    if (keep(value)) indices.push(index);
  return indices;
}

function strictlyInside(values: number[], from: number, to: number): number[] {
  return indicesWhere(values, (v) => v > from && v < to);
}

function within(values: number[], from: number, to: number): number[] {
  return indicesWhere(values, (v) => v >= from && v <= to);
}

function near(values: number[], at: number, distance: number): number[] {
  return indicesWhere(values, (v) => Math.abs(v - at) < distance);
}

/** The index i whose step from i − 1 crosses `at`. */
function crossedBefore(values: number[], at: number): number[] {
  const i = values.findIndex((v) => v >= at);
  return i > 0 && values[i - 1]! < at ? [i] : [];
}
