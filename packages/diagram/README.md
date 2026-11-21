# @zukhruf/diagram

React components that draw technical diagrams: the graph of a system, or the timeline of a protocol. You write a diagram as a tree of primitives, for example `Diagram.Box` and `Diagram.Arrow`. A renderer compiles the tree, calculates the layout, and draws it as SVG, on a canvas, or as HTML. The theme is a set of CSS variables, and the diagram can animate its parts and the flow on its edges.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm i @zukhruf/diagram
```

The peer dependencies are `react` 19, `motion` 12 and `tailwindcss` 4. The other dependencies, for example `vgpu` for the effects, install with the package.

Import the stylesheet in the Tailwind CSS file of the app, after Tailwind:

```css
@import 'tailwindcss';
@import '@zukhruf/diagram/styles.css';
```

Obey two rules:

- **Use a plain `@import`.** Do not write `@import '@zukhruf/diagram/styles.css' layer(components);`. A `layer()` puts all of the stylesheet into a layer, also its `@source` rule. Tailwind CSS refuses these rules in a layer.
- **Do not add an `@source` for the package.** The stylesheet registers its own `dist` folder. Tailwind CSS then finds the classes of the diagrams. See [ADR 0001](./docs/adr/0001-the-diagram-is-a-zukhruf-package.md).

Write the diagram with the primitives of `Diagram`, and give it to a renderer:

```tsx
import { Diagram, SvgGraphDiagram } from '@zukhruf/diagram';

export function Checkout() {
  return (
    <SvgGraphDiagram title="Checkout" defaultMode="static">
      <Diagram.Box id="web" row={0} col={0}>
        Web app
      </Diagram.Box>
      <Diagram.Box id="api" row={0} col={1}>
        API
      </Diagram.Box>
      <Diagram.Arrow from="web" to="api">
        POST /orders
      </Diagram.Arrow>
    </SvgGraphDiagram>
  );
}
```

A timeline uses lanes and signals:

```tsx
import { Diagram, SvgTimelineDiagram } from '@zukhruf/diagram';

export function Handshake() {
  return (
    <SvgTimelineDiagram title="Handshake" defaultMode="static">
      <Diagram.Lane id="client">Client</Diagram.Lane>
      <Diagram.Lane id="server">Server</Diagram.Lane>
      <Diagram.Signal from="client" to="server">
        hello
      </Diagram.Signal>
      <Diagram.Signal from="server" to="client" boxed>
        session id
      </Diagram.Signal>
    </SvgTimelineDiagram>
  );
}
```

## Select a renderer for the layout and the output

Each renderer draws one layout to one output. The compiler of a renderer throws when it gets a primitive of the other layout.

| Renderer             | Layout   | Output   | Notes                                                                                                                                                 |
| -------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SvgGraphDiagram`    | Graph    | SVG      | The only renderer that takes `effects`.                                                                                                               |
| `SvgTimelineDiagram` | Timeline | SVG      | One frame at most.                                                                                                                                    |
| `CanvasGraphDiagram` | Graph    | A canvas | The same props as `SvgGraphDiagram`, without `effects`.                                                                                               |
| `HtmlGraphDiagram`   | Graph    | HTML     | The only renderer that draws `Diagram.Content`. It draws at natural size (one layout unit is one CSS pixel), and scrolls when the page is too narrow. |

The renderer sets the layout. `SvgGraphDiagram`, `CanvasGraphDiagram` and `HtmlGraphDiagram` draw a **graph**. `SvgTimelineDiagram` draws a **timeline**.

- **Graph primitives:** `Node`, `Box`, `Card`, `Port`, `Label`, `Float`, `Marker`, `Appliance`, `Connector`, `Junction`, `Note`, `Edge`, `Arrow`, `Wire`, `Group`, `Content`.
- **Timeline primitives:** `Lane`, `Signal`, `Frame`.

`Line` makes a label with more than one line, in both layouts. `Content` goes into a `Box`, a `Card` or a `Node`, one time.

## Give a renderer only primitives as children

The compiler checks the children, and it throws with a clear message:

- A renderer accepts only primitives as children.
- A React fragment (`<>…</>`) throws. Write the primitives directly, or give an array of primitives.
- A different component, for example `<MyHelper />`, throws with the name of the component.
- A lane, a signal, an edge and a frame accept only their own children: text and `Line`, and `Signal` in a frame.
- A duplicate `id` of a node, a group or a lane throws, with the id in the message.
- An edge to a missing `from` or `to` throws, with both ends in the message.

## Place nodes on the grid of a graph

A graph is a grid of cells. Give each node an `id`, and a `row` and a `col`: integers from 0. `rowSpan` and `colSpan` let a node cover more cells. One node at most is in a cell. You do not give sizes in pixels. The layout measures the content of each node, and gives each row and each column the size of its largest content.

| Primitive           | What it is                                                  | Default frame | Size                                    |
| ------------------- | ----------------------------------------------------------- | ------------- | --------------------------------------- |
| `Diagram.Node`      | The general node                                            | `solid`       | Fills its area. Prefer `Box` or `Card`. |
| `Diagram.Box`       | A node with a solid border and centered text                | `solid`       | Fills its area. The usual node.         |
| `Diagram.Card`      | A node with a solid border and text that starts at the left | `solid`       | Fills its area.                         |
| `Diagram.Port`      | A node with no header                                       | `transparent` | Fills its area.                         |
| `Diagram.Label`     | Text at a grid position                                     | `none`        | Fills its area.                         |
| `Diagram.Float`     | A flat node. An edge cannot attach to it.                   | `flat`        | Fills its area.                         |
| `Diagram.Marker`    | A node with an `icon`, for example `server` or `user`       | `none`        | Its own size. The icon is required.     |
| `Diagram.Appliance` | A hardware device                                           | `none`        | Its own size.                           |
| `Diagram.Connector` | A small node with round corners and an optional `icon`      | `solid`       | Its own size.                           |
| `Diagram.Junction`  | A small circle where edges meet                             | `none`        | Its own size.                           |
| `Diagram.Note`      | Text with no frame, with an optional leader to a `target`   | `none`        | Its own size.                           |

A node that keeps its own size goes at the center of its area.

Other props of a node:

- `tone`, `texture` and `accent` set its colors. `frame` sets its border.
- `textColor` (`accent`, `neutral`, `dim`) sets the color of its text: the title, and the `description` and `items` of a card.
- `icon` puts an icon before the title, for example `server` or `user`.
- `description` and `items` add text under the title of a card.
- `caption` puts text next to the node, on the side that `captionSide` sets. `captionFrame` draws a border with round ends around the caption. `captionColor` (`accent`, `neutral`, `dim`) sets the color of the caption.
- `hidden` keeps the node in the grid, but no renderer draws it. The measure step gives a hidden `Diagram.Node` the size 0 × 0. A hidden `Diagram.Junction` keeps its size.
- `ports` gives node ports: named points on a side, where an edge can attach. When a side has ports, each edge to that side must name a port.
- `stack` draws copies of the frame behind the node, for a set of equal items. `stackDirection` sets where the copies go.
- `appliancePorts` and `antenna` change the drawing of an appliance.

A note explains a node or a group. With a `target`, the layout draws a leader from the note to it:

```tsx
<Diagram.Box id="cert-manager" row={2} col={5}>
  cert-manager
</Diagram.Box>
<Diagram.Note id="cert-note" row={2} col={7} target="cert-manager">
  <Diagram.Line>Manages</Diagram.Line>
  <Diagram.Line>certificates</Diagram.Line>
</Diagram.Note>
```

## Connect nodes with edges

| Primitive       | What it is                                | Arrowhead     | Use it                                             |
| --------------- | ----------------------------------------- | ------------- | -------------------------------------------------- |
| `Diagram.Arrow` | An edge with an arrowhead at the target   | Yes           | For "X calls Y" and "X depends on Y".              |
| `Diagram.Wire`  | An edge with no arrowhead                 | No            | When the direction is clear or the same both ways. |
| `Diagram.Edge`  | The general edge; set `headless` yourself | You select it | Prefer `Arrow` or `Wire`.                          |

The required props are `from` and `to`. Each is the id of a node or a group, or `id:port` for a node port. The other props are:

- `lineStyle` (`solid`, `dashed`, `dotted`), `direction` (`forward`, `both`, `none`), `weight` (`regular`, `bold`), `dim`, `accent`, and `headless`.
- `exitSide` and `entrySide` (`top`, `right`, `bottom`, `left`): the side of the source where the edge goes out, and the side of the target where it goes in.
- `layer` (`background`, `foreground`): whether the edge draws below or above the nodes.
- `labelFrame`: a box around the label.
- `badgeIcon` and `badgeLabel`: an icon on the edge.
- `channel`: a name that the layout copies to the `data-diagram-edge-channel` attribute.

The text children and the `Diagram.Line` children of an edge are its label.

The router in `src/lib/layouts/graph/route.ts` selects each path:

- Each path is orthogonal. The router finds it with A\*, and it goes around the nodes, the captions, the group labels, and the labels of the edges that routed before it.
- The router routes the nearest edges first.
- When you do not give `exitSide` and `entrySide`, the router selects the sides from the cells of the two ends.
- The edges on one side of a node divide that side into equal slots, in the order of their other ends, so they do not cross.
- The router puts each label beside the longest segment of its edge, at the first free position.

When the router finds no path or no position, the layout throws. The message names the edge. See [Errors](#errors).

## Group nodes

`Diagram.Group` draws a rectangle around a set of nodes. Put the nodes in it as children. A group can be in a group.

The required prop is `id`. The optional props are `label`, `labelAlign`, `labelSide` (`top`, `bottom`), `titleBand` (a band behind the label), `accent`, `tone`, `texture`, `fill`, `frame` (`solid`, `dashed`, `none`), `ports`, and `dividers` (a line through each gutter in the group).

The area of a group is the smallest area that holds its members. To give a larger area, set `row`, `col`, `rowSpan` and `colSpan`:

```tsx
<Diagram.Group id="bug" row={0} col={3} colSpan={5} label="BUG">
  <Diagram.Box id="reproduce" row={0} col={3}>
    Reproduce
  </Diagram.Box>
  <Diagram.Box id="review-fix" row={0} col={6}>
    Review fix
  </Diagram.Box>
</Diagram.Group>
```

The border, the padding and the title band of a group go in the gutters between the rows and the columns. Thus a group never covers a node. The layout throws when two sibling groups overlap, when a node is in the area of a group that it is not a member of, and when an explicit area does not hold all of the members.

## Write a label with more than one line

| Primitive      | What it is                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `Diagram.Line` | One line of a label with more than one line. It goes into a lane, a signal, a node or an edge. |

A label has one of two shapes:

- A text child: a label with one line.
- One or more `Diagram.Line` children: a label with more than one line.

`Diagram.Line` accepts `textColor` (`accent`, `neutral`, `dim`) and `fontWeight`, so each line can have its own look. The compiler removes text that is only white space.

## Put React content in a node

`Diagram.Content` holds real React content in a `Box`, a `Card` or a `Node`. Only `HtmlGraphDiagram` draws it. The layout cannot measure React content, so give its size in pixels with `size`. The layout keeps a space of that size under the label:

```tsx
<HtmlGraphDiagram title="Query">
  <Diagram.Box id="database" row={0} col={0}>
    Database
    <Diagram.Content size={{ w: 96, h: 56 }}>
      <button type="button">Run query</button>
    </Diagram.Content>
  </Diagram.Box>
</HtmlGraphDiagram>
```

## Draw a timeline with lanes and signals

| Primitive        | What it is                                       | Required props | Optional props                                                                         |
| ---------------- | ------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------- |
| `Diagram.Lane`   | The vertical line of one actor                   | `id`           | `accent`                                                                               |
| `Diagram.Signal` | A horizontal arrow from one lane to another lane | `from`, `to`   | `accent`, `dim`, `boxed`, `stub`, `bordered`, `filled`                                 |
| `Diagram.Frame`  | A labeled rectangle around some signals          | `label`        | Its children must be signals. A timeline has one frame at most; a second frame throws. |

The label of a lane or a signal is its text children.

### Put the label of a signal in a box

A boxed signal puts its label in a box on the line.

- `boxed` is `true`, or the position of the box: `'source'`, `'center'` or `'target'`. `true` is `'source'`.
- `stub` is the gap between the line of the lane and the edge of the box. The default is 12.
- `bordered` draws the border of the box in the color of the signal. The default is `true`.
- `filled` fills the box. The default is `true`. With `false`, the box is transparent, and it has no dots.

The layout splits the line into two stubs. The stub at the source has no arrowhead. The stub at the target has the arrowhead. When the box is wider than the distance between the lanes, the layout throws.

## Set the props of a renderer

Each renderer takes these props:

| Prop          | Type                                 | Default        | What it does                                                                           |
| ------------- | ------------------------------------ | -------------- | -------------------------------------------------------------------------------------- |
| `title`       | `string \| string[]`                 | Required       | The title. Each string is one line.                                                    |
| `children`    | Primitives                           | Required       | The diagram.                                                                           |
| `defaultMode` | `'static' \| 'reveal' \| 'scrub'`    | `'reveal'`     | The first mode. A user that prefers reduced motion always gets `static`.               |
| `controls`    | `boolean`                            | `false`        | Shows the control panel, in which the user selects the mode.                           |
| `showHeader`  | `boolean`                            | `true`         | Shows the header with the title and the corner.                                        |
| `corner`      | `ReactNode`                          |                | A slot at the corner of the header, for example a logo.                                |
| `accent`      | `DiagramAccent`                      | `'green'`      | The highlight color.                                                                   |
| `stylePreset` | `'default' \| 'sketch'`              | `'default'`    | The style preset.                                                                      |
| `className`   | `string`                             |                | Classes for the wrapper element, for example the width in the grid of a page.          |
| `viewport`    | `{ fit?, zoom? }`                    | `fit: 'width'` | How the drawing fits its container: `width`, `contain` or `natural`. `zoom` scales it. |
| `paper`       | `boolean \| { fill?, stroke?, rx? }` |                | A rectangle behind the drawing. `fill` is `background` or `surface`.                   |

`HtmlGraphDiagram` takes `viewport.zoom`, but not `viewport.fit`. Only `SvgGraphDiagram` takes `effects`.

## Change the theme

The theme is the values of the `--dgm-*` CSS variables. The wrapper element of each diagram sets a light set of values, and a dark set with the `dark:` variant of Tailwind CSS. Thus the dark values follow the dark variant of the app. By default, that is the `prefers-color-scheme` media query. An app that sets `@custom-variant dark` uses its own rule, for example a `.dark` class.

| Variable                                             | What it colors                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--dgm-bg`                                           | The background of the diagram                                                                        |
| `--dgm-surface-muted`                                | A muted surface, for example the `surface` paper                                                     |
| `--dgm-text`                                         | The text                                                                                             |
| `--dgm-neutral`                                      | Lines and text with no accent                                                                        |
| `--dgm-dim`                                          | Dim lines and dim text, and the status of the effects                                                |
| `--dgm-lifeline`                                     | The line of a lane                                                                                   |
| `--dgm-border`                                       | The border of the paper                                                                              |
| `--dgm-divider`                                      | The lines of the control panel                                                                       |
| `--dgm-hover`                                        | The hover state of the control panel                                                                 |
| `--dgm-dot`                                          | The `dots` texture                                                                                   |
| `--dgm-hatch`                                        | The `hatch` texture                                                                                  |
| `--dgm-accent-green`                                 | The `green` accent                                                                                   |
| `--dgm-accent-primary`                               | The `primary` accent                                                                                 |
| `--dgm-accent-neutral`                               | The `neutral` accent                                                                                 |
| `--dgm-on-accent`                                    | Text on an accent fill                                                                               |
| `--dgm-tone-<tone>-fill`, `--dgm-tone-<tone>-stroke` | The fill and the border of each tone: `neutral`, `green`, `blue`, `amber`, `rose`, `purple`, `slate` |

The theme classes are utilities, so they are in `@layer utilities`. A rule outside of a layer wins over each rule in a layer (MDN, `@layer`). To change the theme, write a rule outside of a layer that selects the diagram:

```css
@import 'tailwindcss';
@import '@zukhruf/diagram/styles.css';

[data-diagram-style-preset] {
  --dgm-accent-primary: oklch(0.55 0.2 260);
}

.dark [data-diagram-style-preset] {
  --dgm-accent-primary: oklch(0.7 0.15 260);
}
```

Do not set the variables only on `:root`. The wrapper element sets its own values, and a value on an element wins over the value that it gets from `:root`.

Two props also change the look:

- `accent`: the highlight color. It is `green` (the default), `primary`, `neutral`, or a CSS color.
- `stylePreset`: `default`, or `sketch`. The `sketch` preset draws black ink on white, and makes each tone the same gray.

The text uses the fonts Geist Sans and Geist Mono. The stylesheet loads them from `@fontsource/geist-sans` and `@fontsource/geist-mono`, which install with the package. The graph layout measures each text with a table of the glyph widths of these fonts. Thus the text fits its box on each operating system and in server rendering. See [ADR 0003](./docs/adr/0003-the-graph-layout-is-a-content-sized-grid.md).

## Draw pulses along the edges with effects

`SvgGraphDiagram` can draw pulses that move along its edges. Give it the `effects` prop:

- `effects="flow"`: the mode controls the pulses. In `reveal`, they move all the time. In `static`, they draw one time and do not move. In `scrub`, the scroll position moves them.
- `effects={{ flow }}`: `flow` is a `MotionValue<number>` that you control. From 0 to 1, a pulse goes along the first edge. From 1 to 2, a pulse goes along the second edge, and so on, in the order of the edges in the tree. An integer value clears the pulses. You control the timing, the pauses and the stops.

An edge with no arrowhead (`Wire`, `headless`, or `direction="none"`) gets no pulse.

The effects draw with WebGPU, on a canvas above the SVG. The package loads `vgpu` and `@vgpu/wgsl` with a dynamic `import()` only when a diagram has `effects`. Thus a diagram with no `effects` adds no WebGPU code to the bundle.

The SVG drawing is always there. The effects only add to it:

- When the browser has no WebGPU, or the GPU device fails, the canvas hides. A status line shows the text "Flow animation is unavailable in this browser."
- When the user prefers reduced motion, the canvas hides, and the effects do not draw.
- When the diagram is not in view, or the page is hidden, the effects pause.

The canvas has the attribute `data-diagram-effects-status`. Its value is `initializing`, `empty`, `paused`, `controlled`, `static`, `reveal`, `scrub`, `reduced-motion` or `unavailable`. A test or a debug tool can read it.

## Calculate the layout without React

`layoutGraph(ir)` calculates the layout of a graph and returns a `GraphLayout`: the boxes of the nodes, the rectangles of the groups, the paths of the edges and the leaders, the positions of each text, and the `viewBox`. It is a pure, synchronous function. The renderers call it, and only copy its values. The package exports it and its types.

## Errors

The layout throws an `Error` when it cannot place the structure that you give. It never draws a diagonal line, and it never moves a part on top of another part ([ADR 0003](./docs/adr/0003-the-graph-layout-is-a-content-sized-grid.md)). The message names the node, the group or the edge, and the cell or the side. Read the message, and change the structure: a cell, a side or a span. Do not add a size or an offset. The recipe [Read a layout error and change the structure](./docs/recipes/read-a-layout-error-and-change-the-structure.md) shows the steps.

An edge is named `edge <from>→<to>` in the message. The graph errors come from `src/lib/layouts/graph/areas.ts`, `connections.ts`, `attach.ts` and `route.ts`, and the tests are in `src/lib/layouts/graph/layout-scenarios.test.ts`.

| Error                                                                                                       | When                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Diagram node "<id>" row <value> must be a non-negative integer.` (also `col`)                              | A `row` or a `col` is not an integer from 0. Give a whole cell.                                                                                                                                             |
| `Diagram node "<id>" rowSpan <value> must be an integer of at least 1.` (also `colSpan`)                    | A span is not an integer of 1 or more. Give a whole number of cells.                                                                                                                                        |
| `Diagram nodes "<a>" and "<b>" both occupy cell (row <r>, col <c>).`                                        | The areas of two nodes share a cell. Move one node to a free cell, or make a span smaller.                                                                                                                  |
| `Diagram node "<id>" names group "<group>", which does not exist.`                                          | An IR that you give to `layoutGraph(ir)` names a group that it does not have. Add the group, or remove the name.                                                                                            |
| `Diagram group "<id>" has no members and no area.`                                                          | A group has no members and no `row`, `col`, `rowSpan` and `colSpan`. Put nodes in it, or give it an area.                                                                                                   |
| `Diagram group "<id>" area <area> misses its member <member> at <area>.`                                    | The explicit area of a group does not hold a member node, or a child group goes outside its parent. Make the area larger, or move the member into it.                                                       |
| `Diagram groups "<a>" and "<b>" overlap at cell (row <r>, col <c>). Sibling groups need disjoint areas.`    | Two groups with the same parent share a cell. Move the members of one group, so that the areas do not share a cell, or put one group in the other.                                                          |
| `Diagram node "<id>" lies inside the area of group "<group>" <area> but is not its member.`                 | A node is in the area of a group, but it is not a child of the group in the JSX. Move it into the group, or out of the area.                                                                                |
| `Diagram group "<id>" has dividers, but its area is the one cell (row <r>, col <c>).`                       | A group with `dividers` covers one cell. Give it two rows or two columns, or remove `dividers`.                                                                                                             |
| `Diagram edge <from>→<to>: "<id>" is not a node or a group.`                                                | An end of an edge is not the id of a node or a group. Correct the `from` or the `to`.                                                                                                                       |
| `Diagram edge <from>→<to>: "<id>" has no port "<port>".`                                                    | An `id:port` end names a port that the `ports` of the node do not have. Correct the port id, or add the port.                                                                                               |
| `Diagram edge <from>→<to>: exitSide <side> contradicts port "<id:port>" on side <side>.` (also `entrySide`) | An edge names a node port, and an `exitSide` or an `entrySide` that is not the side of that port. Remove the side, because the port sets it.                                                                |
| `Diagram node "<id>" side <side> declares ports; edge <from>→<to> must use "<id>:<port>".`                  | The side that the edge selects has node ports, and the edge does not name one. Write `id:port` in `from` or `to`, or select a different side with `exitSide` or `entrySide`.                                |
| `Diagram node "<id>" side <side> has no room for <n> connections 8px apart beside its corners and caption.` | A side has too many edges for its length. Move some edges to a different side with `exitSide` or `entrySide`, give the node a larger `rowSpan` or `colSpan`, or let the edges meet at a `Diagram.Junction`. |
| `Diagram edge <from>→<to>: no orthogonal route from <end> to <end> avoids the nodes and labels.`            | Each choice of sides of the edge has no path around the nodes and the labels. Change `exitSide` or `entrySide`, or move a node. For the leader of a note, move the note or its target.                      |
| `Diagram edge <from>→<to>: label "<text>" (<w>×<h>) has no free position beside its route.` (also a badge)  | The path of the edge has no free position for its label or its badge. Give `exitSide` or `entrySide`, move a node to a different cell, or split the diagram.                                                |
| `Cannot measure "<text>": U+<code point> has no glyph in the <face> face at weight <weight>`                | The text has a character that the glyph table of the Geist fonts does not have (`src/lib/layouts/text/measure-text.ts`, test `measure-text.test.ts`). Write the text with other characters.                 |
| `boxed signal label box (width=<w>) overflows the lane distance …`                                          | In a timeline, the box of a boxed signal is wider than the distance between its lanes (`src/lib/layouts/timeline/timeline-layout.ts`). Make the label shorter, or give a smaller `stub`.                    |

The compiler throws on children that are not primitives. See [Give a renderer only primitives as children](#give-a-renderer-only-primitives-as-children).

When the error is wrong, for example a throw on a structure that clearly fits, the cause is in the layout, not in your diagram. Make the smallest graph that throws, and report it. When the problem is general, fix the router. See [the internals](./docs/internals.md).

## What the package does not do

- **It does not set the width of a diagram on a page.** Give the classes of your page layout with `className`.
- **It does not size a graph in pixels.** You give cells, and the layout measures the content and sizes each track. See [ADR 0003](./docs/adr/0003-the-graph-layout-is-a-content-sized-grid.md).

## API

The source of truth is `src/lib/react/Diagram.tsx`, `src/lib/react/diagram-types.ts` and `src/lib/model/diagram-ir.ts`. Read the types when a prop seems to be missing.

```ts
// The primitives. Each one draws nothing; the compiler of a renderer reads its props.
const Diagram: {
  Node: PrimitiveComponent<DiagramNodeProps>;
  Box: PrimitiveComponent<DiagramNodeProps>;
  Card: PrimitiveComponent<DiagramNodeProps>;
  Port: PrimitiveComponent<DiagramNodeProps>;
  Label: PrimitiveComponent<DiagramNodeProps>;
  Float: PrimitiveComponent<DiagramNodeProps>;
  Marker: PrimitiveComponent<DiagramMarkerProps>;
  Appliance: PrimitiveComponent<DiagramApplianceProps>;
  Connector: PrimitiveComponent<DiagramConnectorProps>;
  Junction: PrimitiveComponent<DiagramJunctionProps>;
  Note: PrimitiveComponent<DiagramNoteProps>;
  Edge: PrimitiveComponent<DiagramEdgeProps>;
  Arrow: PrimitiveComponent<DiagramEdgeProps>;
  Wire: PrimitiveComponent<DiagramEdgeProps>;
  Group: PrimitiveComponent<DiagramGroupProps>;
  Content: PrimitiveComponent<DiagramContentProps>;
  Line: PrimitiveComponent<DiagramLineProps>;
  Lane: PrimitiveComponent<DiagramLaneProps>;
  Signal: PrimitiveComponent<DiagramSignalProps>;
  Frame: PrimitiveComponent<DiagramFrameProps>;
};

type DiagramProps = {
  title: string | string[];
  children: ReactNode;
  defaultMode?: DiagramMode;
  controls?: boolean;
  showHeader?: boolean;
  className?: string;
  corner?: ReactNode;
  accent?: DiagramAccent;
  stylePreset?: DiagramStylePreset;
  viewport?: DiagramViewport;
  paper?: DiagramPaper;
};

type DiagramMode = 'static' | 'reveal' | 'scrub';
type DiagramAccent = 'green' | 'primary' | 'neutral' | (string & {});
type DiagramStylePreset = 'default' | 'sketch';
type DiagramViewport = { fit?: DiagramViewportFit; zoom?: number };
type DiagramViewportFit = 'width' | 'contain' | 'natural';
type DiagramPaper =
  boolean | { fill?: 'background' | 'surface'; stroke?: boolean; rx?: number };
type DiagramEffects = 'flow' | { flow: MotionValue<number> };

// The renderers.
type SvgGraphDiagramProps = DiagramProps & { effects?: DiagramEffects };
type SvgTimelineDiagramProps = DiagramProps;
type CanvasGraphDiagramProps = DiagramProps;
type HtmlGraphDiagramProps = Omit<DiagramProps, 'viewport'> & {
  viewport?: Omit<DiagramViewport, 'fit'>;
};
function SvgGraphDiagram(props: SvgGraphDiagramProps): JSX.Element;
function SvgTimelineDiagram(props: SvgTimelineDiagramProps): JSX.Element;
function CanvasGraphDiagram(props: CanvasGraphDiagramProps): JSX.Element;
function HtmlGraphDiagram(props: HtmlGraphDiagramProps): JSX.Element;

// The layout of a graph, without React. It throws the errors in the table above.
function layoutGraph(ir: DiagramGraphIR): GraphLayout;
type GraphLayout = {
  nodes: NodeLayout[];
  groups: GroupLayout[];
  edges: EdgeLayout[];
  leaders: LeaderLayout[];
  viewBox: Box;
};
```

The package also exports the types of the props of each primitive, of the IR (`DiagramGraphIR`, `DiagramTimelineSpec`, `DiagramNode`, `DiagramEdge`, `DiagramGroup` and their parts), of the layout (`NodeLayout`, `GroupLayout`, `EdgeLayout`, `EdgeLabelLayout`, `LeaderLayout`, `PortLayout`, `TextRun`, `TextAnchor`) and of the fonts (`Font`, `FontFace`, `FontWeight`). See `src/index.ts`.

## Documentation

**Concepts**

- [The internals](./docs/internals.md): how the compiler, the layouts and the renderers divide the work, and which mistakes the code had before.

**Recipes**

- [Read a layout error and change the structure](./docs/recipes/read-a-layout-error-and-change-the-structure.md)

**Decisions**

- [ADR 0001](./docs/adr/0001-the-diagram-is-a-zukhruf-package.md): the diagram is a zukhruf package.
- [ADR 0002](./docs/adr/0002-the-examples-are-a-playground-app-in-zukhruf.md): the examples are a playground app in zukhruf.
- [ADR 0003](./docs/adr/0003-the-graph-layout-is-a-content-sized-grid.md): the graph layout is a content-sized grid.

**Copied code**

- [docs/copied-code.md](./docs/copied-code.md): the code that is in two places, and where.

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run diagram:test        # builds, then runs the tests
npx nx run diagram:typecheck   # formats, lints, then type checks
npx nx run diagram:build       # compiles src/ to dist/ with the React Compiler
npx nx run diagram:lint        # lints the code
```

```
src/
  lib/model/        the IR types, and parseEndpointRef, which reads the from and to of an edge
  lib/compiler/     reads the primitives, and makes the IR
  lib/layouts/      the pure geometry of the graph and the timeline; text/ measures text with the glyph table
  lib/renderers/    svg/, canvas/, html/ and webgpu/ draw the layouts; shared/ holds the parts that they share
  lib/react/        the Diagram primitives and the chrome
  testing/          the oracle (assertSoundLayout), the script that writes the glyph table, and app.css, the app stylesheet that the tests build and the linter reads the theme from; the build does not ship them
  index.ts          the entry
styles.css          loads the Geist fonts, registers dist with @source, and holds the dgm theme tokens and utilities that the classes of dist use
```
