import type {
  DiagramGraphIR,
  DiagramGroup,
  DiagramNode,
} from '../../model/diagram-ir.ts';

/** A rectangle of grid cells: rows `[row, row + rowSpan)` and columns `[col, col + colSpan)`. */
export type CellArea = {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
};

export type GroupArea = {
  group: DiagramGroup;
  /** The nesting level; a top-level group is depth 0. */
  depth: number;
  area: CellArea;
};

export type GridAreas = {
  rows: number;
  cols: number;
  nodes: Map<string, CellArea>;
  /** Parents before their children. */
  groups: GroupArea[];
};

/**
 * Gives every node and group its cell area and rejects a grid that cannot be
 * drawn without overlap. Each error names the elements and the cells.
 */
export function gridAreas(ir: DiagramGraphIR): GridAreas {
  const nodes = new Map(
    ir.nodes.map(
      (node) => [node.id, checkedArea(`node "${node.id}"`, node)] as const,
    ),
  );
  rejectSharedCells(ir.nodes, nodes);

  const groupsById = new Map(ir.groups.map((group) => [group.id, group]));
  for (const node of ir.nodes) {
    if (node.group !== undefined && !groupsById.has(node.group)) {
      throw new Error(
        `Diagram node "${node.id}" names group "${node.group}", which does not exist.`,
      );
    }
  }
  const depth = (group: DiagramGroup): number => {
    const parent = group.parent && groupsById.get(group.parent);
    return parent ? depth(parent) + 1 : 0;
  };

  const areas = new Map<string, CellArea>();
  const areaOf = (group: DiagramGroup): CellArea => {
    const known = areas.get(group.id);
    if (known) return known;
    const members = [
      ...ir.nodes
        .filter((node) => node.group === group.id)
        .map((node) => ({
          what: `node "${node.id}"`,
          area: nodes.get(node.id)!,
        })),
      ...ir.groups
        .filter((child) => child.parent === group.id)
        .map((child) => ({ what: `group "${child.id}"`, area: areaOf(child) })),
    ];
    const area = explicitArea(group) ?? boundingArea(group, members);
    for (const member of members) {
      if (!covers(area, member.area)) {
        throw new Error(
          `Diagram group "${group.id}" area ${formatArea(area)} misses its member ${member.what} at ${formatArea(member.area)}.`,
        );
      }
    }
    areas.set(group.id, area);
    return area;
  };

  const groups = ir.groups
    .map((group) => ({ group, depth: depth(group), area: areaOf(group) }))
    .sort((a, b) => a.depth - b.depth);
  rejectSiblingOverlap(groups);
  rejectStrangers(ir.nodes, nodes, groups, groupsById);
  rejectSingleCellDividers(groups);

  const all = [...nodes.values(), ...groups.map(({ area }) => area)];
  return {
    rows: Math.max(0, ...all.map((area) => area.row + area.rowSpan)),
    cols: Math.max(0, ...all.map((area) => area.col + area.colSpan)),
    nodes,
    groups,
  };
}

function explicitArea(group: DiagramGroup): CellArea | undefined {
  const { row, col, rowSpan, colSpan } = group;
  if ([row, col, rowSpan, colSpan].every((value) => value === undefined)) {
    return undefined;
  }
  return checkedArea(`group "${group.id}"`, group);
}

function checkedArea(
  what: string,
  cell: {
    row?: number | undefined;
    col?: number | undefined;
    rowSpan?: number | undefined;
    colSpan?: number | undefined;
  },
): CellArea {
  for (const key of ['row', 'col'] as const) {
    const value = cell[key];
    if (value === undefined || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `Diagram ${what} ${key} ${value} must be a non-negative integer.`,
      );
    }
  }
  // An area without a span covers one track, as a CSS Grid item does.
  const area: CellArea = {
    row: cell.row!,
    col: cell.col!,
    rowSpan: cell.rowSpan ?? 1,
    colSpan: cell.colSpan ?? 1,
  };
  for (const key of ['rowSpan', 'colSpan'] as const) {
    if (!Number.isInteger(area[key]) || area[key] < 1) {
      throw new Error(
        `Diagram ${what} ${key} ${area[key]} must be an integer of at least 1.`,
      );
    }
  }
  return area;
}

function boundingArea(
  group: DiagramGroup,
  members: { area: CellArea }[],
): CellArea {
  if (members.length === 0) {
    throw new Error(
      `Diagram group "${group.id}" has no members and no area. Give it members or row, col, rowSpan and colSpan.`,
    );
  }
  const areas = members.map(({ area }) => area);
  const row = Math.min(...areas.map((area) => area.row));
  const col = Math.min(...areas.map((area) => area.col));
  return {
    row,
    col,
    rowSpan: Math.max(...areas.map((area) => area.row + area.rowSpan)) - row,
    colSpan: Math.max(...areas.map((area) => area.col + area.colSpan)) - col,
  };
}

function rejectSharedCells(
  nodes: DiagramNode[],
  areas: Map<string, CellArea>,
): void {
  const occupant = new Map<string, string>();
  for (const node of nodes) {
    for (const { row, col } of cellsOf(areas.get(node.id)!)) {
      const key = `${row},${col}`;
      const other = occupant.get(key);
      if (other !== undefined) {
        throw new Error(
          `Diagram nodes "${other}" and "${node.id}" both occupy cell (row ${row}, col ${col}).`,
        );
      }
      occupant.set(key, node.id);
    }
  }
}

function rejectSiblingOverlap(groups: GroupArea[]): void {
  for (const [index, a] of groups.entries()) {
    for (const b of groups.slice(index + 1)) {
      if (a.group.parent !== b.group.parent) continue;
      const cell = firstSharedCell(a.area, b.area);
      if (cell) {
        throw new Error(
          `Diagram groups "${a.group.id}" and "${b.group.id}" overlap at cell (row ${cell.row}, col ${cell.col}). Sibling groups need disjoint areas.`,
        );
      }
    }
  }
}

/** A node inside a group's area must belong to the group, or its border would cut through the node. */
function rejectStrangers(
  nodes: DiagramNode[],
  areas: Map<string, CellArea>,
  groups: GroupArea[],
  groupsById: Map<string, DiagramGroup>,
): void {
  const ancestors = (node: DiagramNode) => {
    const ids = new Set<string>();
    for (
      let id = node.group;
      id !== undefined && !ids.has(id);
      id = groupsById.get(id)?.parent
    ) {
      ids.add(id);
    }
    return ids;
  };
  for (const node of nodes) {
    const memberOf = ancestors(node);
    const area = areas.get(node.id)!;
    for (const { group, area: groupArea } of groups) {
      if (memberOf.has(group.id) || !firstSharedCell(area, groupArea)) continue;
      throw new Error(
        `Diagram node "${node.id}" lies inside the area of group "${group.id}" ${formatArea(groupArea)} but is not its member. Move it into the group or out of the area.`,
      );
    }
  }
}

function rejectSingleCellDividers(groups: GroupArea[]): void {
  for (const { group, area } of groups) {
    if (group.dividers && area.rowSpan === 1 && area.colSpan === 1) {
      throw new Error(
        `Diagram group "${group.id}" has dividers, but its area is the one cell (row ${area.row}, col ${area.col}). Dividers need two rows or two columns.`,
      );
    }
  }
}

function covers(outer: CellArea, inner: CellArea): boolean {
  return (
    inner.row >= outer.row &&
    inner.col >= outer.col &&
    inner.row + inner.rowSpan <= outer.row + outer.rowSpan &&
    inner.col + inner.colSpan <= outer.col + outer.colSpan
  );
}

function firstSharedCell(
  a: CellArea,
  b: CellArea,
): { row: number; col: number } | undefined {
  const row = Math.max(a.row, b.row);
  const col = Math.max(a.col, b.col);
  const shared =
    row < Math.min(a.row + a.rowSpan, b.row + b.rowSpan) &&
    col < Math.min(a.col + a.colSpan, b.col + b.colSpan);
  return shared ? { row, col } : undefined;
}

function* cellsOf(area: CellArea) {
  for (let row = area.row; row < area.row + area.rowSpan; row++) {
    for (let col = area.col; col < area.col + area.colSpan; col++) {
      yield { row, col };
    }
  }
}

/** Inclusive ranges, as an author reads them: `(rows 2–6, cols 3–6)`. */
function formatArea(area: CellArea): string {
  const range = (start: number, span: number) =>
    span === 1 ? `${start}` : `${start}–${start + span - 1}`;
  const rows = `${area.rowSpan === 1 ? 'row' : 'rows'} ${range(area.row, area.rowSpan)}`;
  const cols = `${area.colSpan === 1 ? 'col' : 'cols'} ${range(area.col, area.colSpan)}`;
  return `(${rows}, ${cols})`;
}
