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

Put the calculation into a pure function in `src/lib/layouts/timeline/timeline-layout.ts` or `src/lib/layouts/graph/graph-layout.ts`. The function takes inputs and returns a layout. The renderer reads the layout, and only writes attributes from it.

A pure function is easy to test without React. Thus the tests of the geometry are fast, and they do most of the work. The tests of a renderer only check that the parts are connected: the number of paths, and the attributes that must be there.

## When an edge or a label is in the wrong place, look at the router first

The compiler makes the IR: the nodes, the edges, the labels, the groups, the lanes and the signals. It does not select the corridor of an edge, the position of a label, the bends of an arrow, or the shape of a self-loop. The router does that.

Debug `src/lib/layouts/graph/graph-layout.ts` first when a graph shows one of these problems:

- A label is on a line.
- The end of an edge touches a different path.
- Two edges in opposite directions use the same lane.
- A self-loop is only a short stub.
- Two nested return edges use the same corridor.

Call `computePaths()`, and read the `points` and the `labelPlacement` of the edge that fails. Add a test to `src/lib/layouts/graph/graph-layout.test.ts` that checks the topology: different corridors, a label above its own lane, an arrowhead outside the side of the target.

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

## Throw when the content does not fit

When a boxed signal does not fit between its lanes (`boxW + 2 × stub > distance`), the layout throws. It does not draw a box that goes past the lanes, and it does not put the box on the middle of the line.

The author sees the error during development. Then the author makes the label shorter, or splits the diagram.

A long label in `Diagram.Line` makes a wide box, and causes this error. Do not add a fallback that cuts the box or makes the text smaller. The diagram has too much in it, and the correct fix is to split it.

## Add a primitive, not raw SVG

When a diagram needs a shape that no primitive gives, add a primitive. Do not put a raw `<svg>`, `<rect>` or `<path>` next to the renderer. The renderer owns the drawing area, the animation, the accessibility (`role="img"` and `aria-label`) and the theme variables. Raw SVG outside of the renderer gets none of them.
