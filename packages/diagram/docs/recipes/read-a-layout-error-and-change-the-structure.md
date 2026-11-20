# Recipe: Read a layout error and change the structure

**Use case.** An API node has edges to eight services. The graph layout throws, and the diagram does not draw. The graph has no pixel props: a node gives cells and spans, and the engine calculates all of the geometry ([ADR 0003](../adr/0003-the-graph-layout-is-a-content-sized-grid.md)). Thus you cannot move a part by some pixels until it fits. The error names the node, the side and the number of edges. Read it, and change the structure: the cells, the spans, or the sides of the edges.

**What you need.** `layoutGraph` and the `DiagramGraphIR` type of `@zukhruf/diagram`. `layoutGraph(ir)` is a pure, synchronous function, so the program runs in Node with no browser and no React ([Calculate the layout without React](../../README.md#calculate-the-layout-without-react)).

The words in this document have one meaning each. See the glossary in [CONTEXT.md](../../CONTEXT.md).

## The steps

1. Calculate the layout of the graph with `layoutGraph(ir)`.
2. When it throws, read the message. It names the node or the edge, the side, and what does not fit.
3. Find the structure that causes it. Find the row for the message in the [Errors](../../README.md#errors) table.
4. Change the cells, the spans, or the sides of the edges. Do not change the text to make a node larger.
5. Calculate the layout again.

## The program

The program makes the same graph three times: an API node in column 0, and eight services in column 1, one in each row. The first graph gives the API one cell. The second graph also gives each edge `exitSide: 'right'`. The third graph gives the API a `rowSpan` of eight rows. For each graph, the program prints the error, or the box of the API and the sides of each edge.

```ts title="fan-out.ts"
import {
  type DiagramEdge,
  type DiagramGraphIR,
  type DiagramNode,
  layoutGraph,
} from '@zukhruf/diagram';

const services = [
  'auth',
  'billing',
  'search',
  'orders',
  'mail',
  'files',
  'queue',
  'cache',
];

function fanOut(
  api: Partial<DiagramNode>,
  edge: Partial<DiagramEdge>,
): DiagramGraphIR {
  return {
    nodes: [
      { id: 'api', label: 'API', row: 0, col: 0, ...api },
      ...services.map((id, row) => ({ id, label: id, row, col: 1 })),
    ],
    edges: services.map((id) => ({ from: 'api', to: id, ...edge })),
    groups: [],
  };
}

function attempt(name: string, ir: DiagramGraphIR): void {
  console.log(`${name}:`);
  try {
    const layout = layoutGraph(ir);
    const api = layout.nodes.find(({ node }) => node.id === 'api')!;
    console.log(`  api box ${api.box.w}×${api.box.h}`);
    for (const edge of layout.edges) {
      console.log(
        `  ${edge.edge.from}→${edge.edge.to}: ${edge.exitSide} to ${edge.entrySide}`,
      );
    }
  } catch (error) {
    console.log(`  ${(error as Error).message}`);
  }
}

attempt('1. One cell for the API', fanOut({}, {}));
attempt('2. A side hint on each edge', fanOut({}, { exitSide: 'right' }));
attempt(
  '3. The API spans the eight rows',
  fanOut({ rowSpan: services.length }, {}),
);
```

Run it as `node fan-out.ts`, with `@zukhruf/diagram` installed. In this repository, build the package first with `npx nx build diagram`, and run the program without the `@zukhruf/source` condition. The package has `.tsx` source, and Node cannot run `.tsx` from the source ([writing-package-docs.md](../../../../docs/writing-package-docs.md#recipe), rule 7).

Output:

```
1. One cell for the API:
  Diagram node "api" side bottom has no room for 7 connections 8px apart beside its corners and caption.
2. A side hint on each edge:
  Diagram node "api" side right has no room for 8 connections 8px apart beside its corners and caption.
3. The API spans the eight rows:
  api box 54×484.8
  api→auth: right to left
  api→billing: right to left
  api→search: right to left
  api→orders: right to left
  api→mail: right to left
  api→files: right to left
  api→queue: right to left
  api→cache: right to left
```

## What the output shows

- **The first graph throws, and the error names the cause.** The API is one cell. The router selected the sides from the cells of the two ends, and seven edges go out at the bottom of the API. A side keeps 8 pixels between two edges and keeps clear of the corners and the caption. The bottom of a box with the text "API" is too short for seven edges.
- **The side hint only moves the problem.** With `exitSide: 'right'`, all eight edges go out on the right side. That side is also too short, so the layout throws again, now for the right side and eight edges.
- **The larger area gives the room.** With `rowSpan: 8`, the area of the API covers the eight rows. A node fills its area ([ADR 0003](../adr/0003-the-graph-layout-is-a-content-sized-grid.md), step 5), so the box is 484.8 pixels high. Each edge goes out on the right side of the API and in on the left side of its service.

## Things to know

- **The renderers throw the same error.** `SvgGraphDiagram`, `HtmlGraphDiagram` and `CanvasGraphDiagram` call `layoutGraph(ir)` and only copy its values (`src/lib/renderers/svg/graph-svg.tsx`, `src/lib/renderers/html/graph-html.tsx`, `src/lib/renderers/canvas/graph-canvas.tsx`). Thus this program gives the message of a diagram that does not draw in the browser.
- **The 8 pixels come from the grid of the router.** The pitch is two cells of the 4-pixel route grid (`SLOT_PITCH = 2 * GRID` in `src/lib/layouts/graph/attach.ts`, `GRID = 4` in `src/lib/layouts/graph/route-search.ts`). The error comes from `src/lib/layouts/graph/attach.ts`.
- **Each error has its own change of structure.** A fractional `row`, `col` or span: give a whole number of cells (`src/lib/layouts/graph/areas.ts`). Two nodes in one cell: give each node its own cell. A node in the area of a group that it is not a member of: move it into the group, or out of the area. An edge with no route, or a label with no free position: give `exitSide` or `entrySide`, or move a node to a different cell. The [Errors](../../README.md#errors) table of the README lists each message and its change. The test `src/lib/layouts/graph/layout-scenarios.test.ts` proves the messages for two nodes in one cell, a node in the area of a group, an edge with no route, and a label with no free position.
- **When no change of structure fits, split the diagram.** The diagram has too much in it. Do not add a fallback that makes the text smaller or cuts a box ([Throw when the content does not fit](../internals.md#throw-when-the-content-does-not-fit)).
- **When the input is correct and the layout still throws, the cause is in the package.** Make the smallest graph that throws, and report it to `@zukhruf/diagram`. Do not change the diagram to hide the defect. Fix the engine, not the example ([Fix the lowest level first](../internals.md#fix-the-lowest-level-first)).
