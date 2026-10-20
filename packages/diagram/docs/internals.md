# Internals

The package does its work in four steps. The compiler reads the primitives and makes the IR. The layout calculates the geometry from the IR. The renderer draws that geometry. The chrome holds the theme and the mode. Each step has its own folder in `src/lib/`.

The sections below are lessons from earlier versions of this code. Each one is a real mistake that a refactor removed. Do not add it again.

The words in this document have one meaning each. See the glossary in [CONTEXT.md](../CONTEXT.md).

## The renderers do not import each other

The `svg`, `canvas` and `html` folders in `src/lib/renderers/` do not import each other. `renderers/shared/` imports none of them. The root `eslint.config.mjs` checks these rules with `import-x/no-restricted-paths`.

A part that two renderers need goes into `renderers/shared/`, `compiler/`, `layouts/` or `react/chrome/`. Thus a change to one output cannot break a different output.

## Do not draw a full line and put a box on it

A boxed signal looks like a line with a box on it. The wrong way to draw it is a full line from the source to the target, and a rectangle on top of the line:

```tsx
// WRONG: in the "boxed" branch of the renderer
// fromX is the x of the source lane, toX is the x of the target lane,
// rowY is the y of this signal, and headInset keeps the arrowhead
// off the line of the target lane.
const direction = toX > fromX ? 1 : -1;
const x2 = toX - direction * headInset;
return (
  <>
    <motion.path d={`M ${fromX} ${rowY} L ${x2} ${rowY}`} markerEnd="..." />
    {/* The full line is drawn, and the box hides a part of it. */}
    <rect
      x={fromX + 6}
      y={rowY - boxH / 2}
      width={boxW}
      height={boxH}
      fill={DIAGRAM_BG}
    />
  </>
);
```

This is wrong, for three reasons:

- The line goes from the source to the target, and the box only hides a part of it. When the box is transparent or has a texture, the line shows through at the edges of the box.
- The part of the line under the box is drawn, but nobody sees it.
- The code does not show the real geometry. It looks like "stub, box, arrow", but it is "full line, and a rectangle on it".

Split the line into two stubs around the box. `computeBoxedSignal()` in `src/lib/layouts/timeline/timeline-layout.ts` does this:

- The first stub goes from the line of the source lane to the near edge of the box. It has no arrowhead.
- The second stub goes from the far edge of the box to the target. It has the arrowhead.

`computeBoxedSignal({ fromX, toX, rowY, boxW, boxH, stub, position, headInset })` is a pure function, and it returns the geometry. The renderer only draws two `<motion.path>` elements and the box.

A boxed signal is a segment with a hole in it. Calculate the hole. Do not make it with the order of the elements.

## Do not calculate the layout in JSX

When a renderer has expressions such as `fromX + 6`, `toX - direction * headInset` or `maxLineLen * LABEL_CHAR_W`, the layout is in the wrong place.

Put the calculation into a pure function in `src/lib/layouts/timeline/timeline-layout.ts` or in `src/lib/layouts/graph/`. The function takes inputs and returns a layout. The renderer reads the layout, and only writes attributes from it.

A pure function is easy to test without React. Thus the tests of the geometry are fast, and they do most of the work. The tests of a renderer only check that the parts are connected: the number of paths, and the attributes that must be there.

## The renderers paint one GraphLayout

`layoutGraph(ir)` in `src/lib/layouts/graph/layout.ts` calculates all of the geometry of a graph, and returns one `GraphLayout`. Its type is in `graph-layout-result.ts`. It holds the box of each node, the position and the font of each text run, the rectangle of each group, the points and the SVG path of each edge, the position of each label, and the `viewBox`.

`SvgGraphDiagram`, `CanvasGraphDiagram` and `HtmlGraphDiagram` call `layoutGraph` one time. They only copy its values into SVG attributes, canvas calls or CSS positions. They do not add a padding, measure a text, or move a label. The flow effects read the same `d` of each edge. Thus the three outputs and the effects show the same geometry.

`src/lib/renderers/paint-contract.test.ts` checks this. It renders one scene, and it checks that each box, each text run and each edge path in the SVG and in the HTML is at the position that the `GraphLayout` holds.

When an output is wrong but the `GraphLayout` is correct, fix the renderer. When the `GraphLayout` is wrong, fix the layout. Do not correct the layout in a renderer.

## When an edge or a label is in the wrong place, look at the router first

The compiler makes the IR: the nodes, the edges, the labels and the groups. It does not select the path of an edge or the position of a label. The router does that, in three modules of `src/lib/layouts/graph/`:

- `attach.ts` selects where each edge touches its node: the side, and the slot on that side. The edges on one side divide it into equal slots, in the order of their other ends, so they do not cross.
- `route.ts` routes each edge and each leader. It routes the nearest edges first. It calls the A\* search in `route-search.ts`, which goes around the nodes, the captions, the group labels and the labels that are already placed.
- `labels.ts` selects the position of each label and each badge: the longest segment first, at the first free position.

Debug these modules first when a graph shows one of these problems:

- A label is on a line, or far from its edge.
- Two edges touch a node at the same point, or cross near the node.
- An edge goes around a group when a straight line is free.
- The layout throws "no orthogonal route" or "has no free position", but there is space in the drawing.

Call `layoutGraph()`, and read the `points` and the `label` of the edge that fails. Add a scenario to `src/lib/layouts/graph/layout-scenarios.test.ts` that checks the topology, for example "the edge has two points" or "the label is above the edge", and call the oracle on the layout.

The compiler is the cause when the diagram throws about a child that is not valid, a primitive of the other layout, a duplicate id, or a missing end of an edge.

## A graph and a timeline do not mix

A graph renderer throws when it gets a lane, a signal or a frame:

```
A graph diagram cannot contain Diagram.Lane, Diagram.Signal or Diagram.Frame; draw those with SvgTimelineDiagram.
```

`SvgTimelineDiagram` throws when it gets a graph primitive. This is intentional. A diagram that needs both tells two stories. Draw a graph and a timeline, one after the other.

## The compiler does not read through fragments or components

```tsx
// WRONG: the compiler throws
<SvgGraphDiagram title="...">
  <>
    <Diagram.Box id="a" row={0} col={0}>
      A
    </Diagram.Box>
    <Diagram.Box id="b" row={1} col={0}>
      B
    </Diagram.Box>
  </>
</SvgGraphDiagram>
```

The compiler reads the direct children one time, and it makes the IR. A fragment or a component hides the primitives in it. To read them, the compiler must run the code of the caller. Then the IR is not a static result of the tree.

Write the primitives directly, or give an array of primitives.

## Test the topology, not the pixels

A snapshot of the full SVG holds each cosmetic value: the padding, the size of the font, the colors. When a constant changes, each snapshot changes, and you cannot see if the change is correct or a regression.

Check the topology. These examples are from `src/lib/renderers/svg/diagram-svg.test.ts`:

```ts
// A boxed signal has one more path than a plain signal.
const boxedPathCount = (boxedMarkup.match(/<path /g) ?? []).length;
const plainPathCount = (plainMarkup.match(/<path /g) ?? []).length;
assert.equal(boxedPathCount - plainPathCount, 1);

// Only the stub at the target has the arrowhead.
const withMarker = signalPaths.filter((p) => /marker-end=/.test(p));
assert.equal(withMarker.length, 1);
```

These checks stay green when a cosmetic value changes. They fail only when the topology changes.

To see the pixels, run `nx run diagram-playground:dev`. The playground shows the five example diagrams, and it reads the source of the package, so an edit shows with no build.

Do not test private functions of a layout from a renderer test. The rendered markup is the public contract. The pure functions of a layout have their own tests.

## Test layouts with the oracle

`assertSoundLayout(layout)` in `src/testing/sound-layout.ts` is the oracle. It checks the invariants that each correct `GraphLayout` obeys:

- **N1, N2:** no two nodes intersect, and each text run is in its node.
- **G1, G2, G3:** a group holds its members and its label is clear, sibling groups do not overlap, and a node that is not a member is outside the group.
- **E1 to E5:** each edge is orthogonal, does not go through a node that is not its end, does not go through the label of a group, ends on its side, and touches a junction at its center.
- **L1, L2:** a label is clear of the nodes, the other labels and the group labels, and it is near its edge.
- **V1:** the `viewBox` holds all of the parts.

The oracle throws one error that lists each violation with its ids. Thus one run shows all of the defects of a diagram, not only the first.

Call the oracle in each layout test, and then check the one fact that the test is about. The oracle checks that the diagram is correct. The assert checks that the diagram is the one that the test wants.

```ts
const layout = layoutGraph(graph({ nodes: [gateway] }));

assertSoundLayout(layout);
assert.deepEqual(box(layout, 'gateway'), { x: 0, y: 0, ...frame });
```

The oracle is in `src/testing/`, so the build does not ship it.

## Fix the lowest level first

A large diagram with defects shows many symptoms of a few causes. A fix in the full diagram often moves the defect to a different part. Do not start with the full diagram.

Make the diagram again as a ladder, one level at a time:

1. One text run. Is the measured width the same as the width that the browser draws?
2. One box. Does its text fit in it?
3. Two boxes and one edge. Then one group. Then a group in a group.
4. Add one part at a time, until you have the full diagram.

Each level must pass the oracle, and a browser check, before you add the next part. When a level fails, fix the cause at that level, in the engine. Then go up again from that level.

The homelab example was made again in this way. The level of one text run proved the measurement first: on 73 text runs, the measured width was never smaller than the drawn width. Thus a defect at a higher level was never a text measurement.

Fix the engine, not the example. When the example must change to pass, the next diagram gets the same defect.

## Throw when the content does not fit

When a boxed signal does not fit between its lanes (`boxW + 2 × stub > distance`), the layout throws. It does not draw a box that goes past the lanes, and it does not put the box on the middle of the line.

The author sees the error during development. Then the author makes the label shorter, or splits the diagram.

A long label in `Diagram.Line` makes a wide box, and causes this error. Do not add a fallback that cuts the box or makes the text smaller. The diagram has too much in it, and the correct fix is to split it.

The graph obeys the same rule. The layout throws when:

- a `row`, a `col` or a span is not an integer, or a span is less than 1;
- two nodes are in one cell;
- a node is in the area of a group that it is not a member of;
- two sibling groups overlap, or an explicit area of a group does not hold all of its members;
- an edge has no orthogonal route, or a label or a badge has no free position;
- a side of a node has more edges than it has room for;
- a side has ports, and an edge to that side does not name a port;
- a text has a character that the glyph table does not have.

Each error names the elements. The layout never draws a diagonal line, a text outside its box, or a group on top of a node. A fallback hides the defect until a reader sees it. An error shows it to the author during development.

## Add a primitive, not raw SVG

When a diagram needs a shape that no primitive gives, add a primitive. Do not put a raw `<svg>`, `<rect>` or `<path>` next to the renderer. The renderer owns the drawing area, the animation, the accessibility (`role="img"` and `aria-label`) and the theme variables. Raw SVG outside of the renderer gets none of them.
