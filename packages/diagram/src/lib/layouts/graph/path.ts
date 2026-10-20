import type { Point } from '../../model/diagram-ir.ts';
import { round } from './round.ts';

/** The radius of the rounded corner the SVG path draws at each bend. */
const CORNER_RADIUS = 8;

/** Drops every point that lies on the straight line through its neighbours. */
export function simplifyPath(path: Point[]): Point[] {
  if (path.length < 3) return path;
  const result: Point[] = [path[0]!];
  for (const [index, current] of path.slice(1, -1).entries()) {
    const previous = result.at(-1)!;
    const next = path[index + 2]!;
    const cross =
      (current.x - previous.x) * (next.y - current.y) -
      (current.y - previous.y) * (next.x - current.x);
    if (cross !== 0) result.push(current);
  }
  result.push(path.at(-1)!);
  return result;
}

/** An SVG path through the points, with each bend rounded, and each number to the layout's precision. */
export function pathToSvg(points: Point[]): string {
  const [first, ...rest] = points;
  if (!first) return '';
  const at = ({ x, y }: Point) => `${round(x)} ${round(y)}`;
  const parts = [`M ${at(first)}`];
  for (const [index, current] of rest.slice(0, -1).entries()) {
    const previous = points[index]!;
    const next = points[index + 2]!;
    const dpx = current.x - previous.x;
    const dpy = current.y - previous.y;
    const dnx = next.x - current.x;
    const dny = next.y - current.y;
    const lp = Math.hypot(dpx, dpy);
    const ln = Math.hypot(dnx, dny);
    const r = Math.min(CORNER_RADIUS, lp / 2, ln / 2);
    const cs = { x: current.x - (dpx / lp) * r, y: current.y - (dpy / lp) * r };
    const ce = { x: current.x + (dnx / ln) * r, y: current.y + (dny / ln) * r };
    parts.push(`L ${at(cs)}`, `Q ${at(current)} ${at(ce)}`);
  }
  const last = rest.at(-1);
  if (last) parts.push(`L ${at(last)}`);
  return parts.join(' ');
}
