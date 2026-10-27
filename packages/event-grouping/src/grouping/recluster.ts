import { agnes } from 'ml-hclust';

import type { EventTable } from '../event-table.ts';
import { THRESHOLD, WINDOW_DAYS } from '../frozen-design.ts';
import type { PairScores } from './scores.ts';
import type { Shortlist } from './shortlist.ts';

// Group-average clustering of the reports with a lead in the window that ends
// on the day. Average linkage cannot join two groups with no pair at or above
// the threshold, so the clustering runs on each connected component of the
// shortlist graph whose edges pass the threshold. Each new cluster keeps the
// id of the old event that it overlaps most (docs/adr/0002).
export function recluster(
  day: number,
  table: EventTable,
  shortlist: Shortlist,
  scores: PairScores,
): void {
  const window = table.withLeadSince(day - WINDOW_DAYS);
  const inWindow = new Set(window);
  const components = new UnionFind(window);
  // The graph also holds vectors that a failed add left behind. They have no
  // report in the window.
  for (const [id, neighbours] of shortlist.ofDays(day - WINDOW_DAYS, day))
    if (inWindow.has(id))
      for (const neighbour of neighbours)
        if (
          inWindow.has(neighbour.id) &&
          scores.score(id, neighbour.id, neighbour.similarity) >= THRESHOLD
        )
          components.union(id, neighbour.id);

  const clusters: string[][] = [];
  for (const component of components.sets()) {
    if (component.length === 1) {
      clusters.push(component);
      continue;
    }
    const distances = component.map((a) =>
      component.map((b) => (a === b ? 0 : 1 - scores.score(a, b))),
    );
    for (const cluster of agnes(distances, {
      method: 'average',
      isDistanceMatrix: true,
    }).cut(1 - THRESHOLD))
      clusters.push(cluster.indices().map((index) => component[index] ?? ''));
  }
  carryIds(clusters, table);
}

// The largest overlaps choose first. Each old id goes to at most one
// cluster. Equal overlaps go to the lower old id, then to the cluster whose
// component has the lowest report id (docs/adr/0002). A cluster with no old
// id left gets a new id.
function carryIds(clusters: readonly string[][], table: EventTable): void {
  const overlaps = clusters.flatMap((cluster, index) =>
    [...Map.groupBy(cluster, (id) => table.eventOf(id)).entries()].map(
      ([event, members]) => ({ index, event, size: members.length }),
    ),
  );
  overlaps.sort(
    (a, b) => b.size - a.size || a.event - b.event || a.index - b.index,
  );
  const idOf = new Map<number, number>();
  const used = new Set<number>();
  for (const { index, event } of overlaps)
    if (!idOf.has(index) && !used.has(event)) {
      idOf.set(index, event);
      used.add(event);
    }
  for (const [index, cluster] of clusters.entries()) {
    const event = idOf.get(index) ?? table.newEvent();
    for (const id of cluster) table.move(id, event);
  }
}

class UnionFind {
  readonly #parent: Map<string, string>;

  constructor(ids: readonly string[]) {
    this.#parent = new Map(ids.map((id) => [id, id]));
  }

  union(a: string, b: string): void {
    this.#parent.set(this.#find(a), this.#find(b));
  }

  // The sets, each in the order of the ids, in the order of their first id.
  sets(): string[][] {
    return [
      ...Map.groupBy(this.#parent.keys(), (id) => this.#find(id)).values(),
    ];
  }

  #find(id: string): string {
    let root = id;
    while (this.#parent.get(root) !== root) root = this.#parent.get(root) ?? id;
    this.#parent.set(id, root);
    return root;
  }
}
