# @zukhruf/diagram

React components that draw technical diagrams: the graph of a system, or the timeline of a protocol. You write a diagram as a tree of primitives, for example `Diagram.Box` and `Diagram.Arrow`. A renderer compiles the tree, calculates the layout, and draws it as SVG, on a canvas, or as HTML. The theme is a set of CSS variables, and the diagram can animate its parts and the flow on its edges.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Install

```sh
npm i @zukhruf/diagram
```

The peer dependencies are `react` 19, `motion` 12 and `tailwindcss` 4. The other dependencies, for example `vgpu` for the effects, install with the package.

## Use it

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

## Renderers

Each renderer draws one layout to one output. The compiler of a renderer throws when it gets a primitive of the other layout.

| Renderer             | Layout   | Output   | Notes                                                                                                                                                 |
| -------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SvgGraphDiagram`    | Graph    | SVG      | The only renderer that takes `effects`.                                                                                                               |
| `SvgTimelineDiagram` | Timeline | SVG      | One frame at most.                                                                                                                                    |
| `CanvasGraphDiagram` | Graph    | A canvas | The same props as `SvgGraphDiagram`, without `effects`.                                                                                               |
| `HtmlGraphDiagram`   | Graph    | HTML     | The only renderer that draws `Diagram.Content`. It draws at natural size (one layout unit is one CSS pixel), and scrolls when the page is too narrow. |

## Theme

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

The SVG text uses the font `ui-monospace, 'Geist Mono', monospace`. The layout calculates the width of a label from the widths of a monospace font.

## Effects

`SvgGraphDiagram` can draw pulses that move along its edges. Give it the `effects` prop:

- `effects="flow"`: the mode controls the pulses. In `reveal`, they move all the time. In `static`, they draw one time and do not move. In `scrub`, the scroll position moves them.
- `effects={{ flow }}`: `flow` is a `MotionValue<number>` that you control. From 0 to 1, a pulse goes along the first edge. From 1 to 2, a pulse goes along the second edge, and so on, in the order of the edges in the tree. An integer value clears the pulses. You control the timing, the pauses and the stops.

An edge with no arrowhead (`Wire`, `headless`, or `direction="none"`) gets no pulse.

The effects draw with WebGPU, on a canvas above the SVG. The package loads `vgpu` with a dynamic `import()` only when a diagram has `effects`. Thus a diagram with no `effects` adds no WebGPU code to the bundle.

The SVG drawing is always there. The effects only add to it:

- When the browser has no WebGPU, or the GPU device fails, the canvas hides. A status line shows the text "Flow animation is unavailable in this browser."
- When the user prefers reduced motion, the canvas hides, and the effects do not draw.
- When the diagram is not in view, or the page is hidden, the effects pause.

The canvas has the attribute `data-diagram-effects-status`. Its value is `initializing`, `empty`, `paused`, `controlled`, `static`, `reveal`, `scrub`, `reduced-motion` or `unavailable`. A test or a debug tool can read it.

## API

The source of truth is `src/lib/react/Diagram.tsx`, `src/lib/react/diagram-types.ts` and `src/lib/model/diagram-ir.ts`. Read the types when a prop seems to be missing.

### Layouts

The renderer sets the layout. `SvgGraphDiagram`, `CanvasGraphDiagram` and `HtmlGraphDiagram` draw a **graph**. `SvgTimelineDiagram` draws a **timeline**.

- **Graph primitives:** `Node`, `Box`, `Card`, `Port`, `Label`, `Float`, `Phantom`, `Marker`, `Appliance`, `Connector`, `Junction`, `Edge`, `Arrow`, `Wire`, `Group`, `Guide`, `Text`, `Note`.
- **Timeline primitives:** `Lane`, `Signal`, `Frame`.

`Line` makes a label with more than one line, in both layouts. `Content` goes into a `Box`, a `Card` or a `Node`, one time. `Waypoint`, `Entry` and `Exit` go into an edge.

### Timeline primitives

| Primitive        | What it is                                       | Required props | Optional props                                                                         |
| ---------------- | ------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------- |
| `Diagram.Lane`   | The vertical line of one actor                   | `id`           | `accent`                                                                               |
| `Diagram.Signal` | A horizontal arrow from one lane to another lane | `from`, `to`   | `accent`, `dim`, `boxed`, `stub`, `bordered`, `filled`                                 |
| `Diagram.Frame`  | A labeled rectangle around some signals          | `label`        | Its children must be signals. A timeline has one frame at most; a second frame throws. |

The label of a lane or a signal is its text children.

#### `Signal.boxed`

A boxed signal puts its label in a box on the line.

- `boxed` is `true`, or the position of the box: `'source'`, `'center'` or `'target'`. `true` is `'source'`.
- `stub` is the gap between the line of the lane and the edge of the box. The default is 12.
- `bordered` draws the border of the box in the color of the signal. The default is `true`.
- `filled` fills the box. The default is `true`. With `false`, the box is transparent, and it has no dots.

The layout splits the line into two stubs. The stub at the source has no arrowhead. The stub at the target has the arrowhead. When the box is wider than the distance between the lanes, the layout throws.

### Graph primitives

Each node has an `id`, and a `row` and a `col` in the grid. `colSpan`, `width` and `height` change its size.

| Primitive           | What it is                                                  | Default frame | Notes                                                                 |
| ------------------- | ----------------------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| `Diagram.Node`      | The general node                                            | `solid`       | Prefer `Box` or `Card`.                                               |
| `Diagram.Box`       | A node with a solid border and centered text                | `solid`       | The usual node.                                                       |
| `Diagram.Card`      | A node with a solid border and text that starts at the left | `solid`       | For a node with a `description` or `items`.                           |
| `Diagram.Port`      | A node with no header                                       | `transparent` | Often holds a set of labels under a box.                              |
| `Diagram.Label`     | Text at a grid position                                     | `none`        | For a section title or the label of an axis.                          |
| `Diagram.Float`     | A flat node                                                 | `flat`        | An edge cannot attach to it.                                          |
| `Diagram.Phantom`   | A node that is not visible                                  | `none`        | An edge can attach to it. Use it to make an edge go through one cell. |
| `Diagram.Marker`    | A node with an `icon`, for example `server` or `user`       | `none`        | The icon is required.                                                 |
| `Diagram.Appliance` | A hardware device                                           | `none`        | `appliancePorts`, `antenna` and `slant` change the drawing.           |
| `Diagram.Connector` | A small node with round corners and an optional `icon`      | `solid`       | The default size is 148 × 40.                                         |
| `Diagram.Junction`  | A small circle where edges meet                             | `none`        | The default size is 16 × 16.                                          |

Other props of a node:

- `tone`, `texture` and `accent` set its colors.
- `caption` puts text next to the node, on the side that `captionSide` sets.
- `ports` gives node ports: named points on a side, where an edge can attach.
- `stack` draws copies of the frame behind the node, for a set of equal items.

### Edges

| Primitive       | What it is                                | Arrowhead     | Use it                                             |
| --------------- | ----------------------------------------- | ------------- | -------------------------------------------------- |
| `Diagram.Arrow` | An edge with an arrowhead at the target   | Yes           | For "X calls Y" and "X depends on Y".              |
| `Diagram.Wire`  | An edge with no arrowhead                 | No            | When the direction is clear or the same both ways. |
| `Diagram.Edge`  | The general edge; set `headless` yourself | You select it | Prefer `Arrow` or `Wire`.                          |

The required props are `from` and `to`. Other props: `lineStyle` (`solid`, `dashed`, `dotted`), `direction` (`forward`, `both`, `none`), `route` (`orthogonal`, `straight`), `dim`, `accent`, the `label*` props, and the `badge*` props for an icon on the edge.

An edge accepts these children: text and `Diagram.Line` for its label, and `Diagram.Entry`, `Diagram.Exit` and `Diagram.Waypoint`.

### Groups

`Diagram.Group` draws a rectangle around a set of nodes. Put the nodes in it as children, or give each node a `group` prop.

The required prop is `id`. The optional props are `label`, `accent`, `tone`, `texture`, `rx` (the corner radius), `tight` (bounds that fit the nodes closely), `padding`, `dividers`, `frame` (`solid`, `dashed`, `none`), and `rowStart`, `rowEnd`, `colStart`, `colEnd` (the bounds). When you do not give the bounds, the compiler calculates them from the rows and columns of the nodes.

### Edge routing

| Primitive          | What it does                                                                            |
| ------------------ | --------------------------------------------------------------------------------------- |
| `Diagram.Entry`    | Sets the side of the target where the edge goes in: `top`, `right`, `bottom` or `left`. |
| `Diagram.Exit`     | Sets the side of the source where the edge goes out.                                    |
| `Diagram.Waypoint` | Gives a point that the edge goes through: `{ x, y }`, a grid cell, a guide, or a node.  |

Use them when the router draws a crossing, or draws an edge around a node.

The router in `src/lib/layouts/graph/graph-layout.ts` does these things:

- A self-edge (`from` is the same as `to`) is a loop around the node. The default loop is above the node. `Exit` and `Entry` can select a different side.
- Two edges in the same row that go in opposite directions get two lanes. For example, `running → paused` stays direct, and `paused → running` goes below the nodes.
- An edge in the same row that goes from right to left goes below the row, not across the top of the row.
- Return edges from the same source to the same side get different corridors. A longer return, for example `paused → idle`, goes deeper than a shorter return, for example `paused → running`.
- The router puts each edge label from the geometry of its path.

When the default paths still cross, use `Entry`, `Exit` and `Waypoint`. When the problem is general, fix the router instead. See [the internals](./docs/internals.md).

### Primitives for both layouts

| Primitive         | What it is                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `Diagram.Text`    | A free annotation: `{ x, y }`, or next to a `target` node, with an optional leader line.       |
| `Diagram.Note`    | The same as `Diagram.Text`.                                                                    |
| `Diagram.Line`    | One line of a label with more than one line. It goes into a lane, a signal, a node or an edge. |
| `Diagram.Guide`   | A vertical or horizontal line that helps to align things.                                      |
| `Diagram.Content` | Real React content in a `Box`, a `Card` or a `Node`. Only `HtmlGraphDiagram` draws it.         |

### Labels

A label has one of two shapes:

- A text child: a label with one line.
- One or more `Diagram.Line` children: a label with more than one line.

`Diagram.Line` accepts `textColor` (`accent`, `neutral`, `dim`) and `fontWeight`, so each line can have its own look. The compiler removes text that is only white space.

### The rules for children

The compiler checks the children, and it throws with a clear message:

- A renderer accepts only primitives as children.
- A React fragment (`<>…</>`) throws. Write the primitives directly, or give an array of primitives.
- A different component, for example `<MyHelper />`, throws with the name of the component.
- A lane, a signal, an edge and a frame accept only their own children: text, `Line`, `Entry`, `Exit` and `Waypoint`, and `Signal` in a frame.
- A duplicate `id` of a node, a group, a guide or a lane throws, with the id in the message.
- An edge to a missing `from` or `to` throws, with both ends in the message.

### Renderer props

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

The graph renderers also take `graph`: the size of the columns and rows, and the padding. `HtmlGraphDiagram` takes `viewport.zoom`, but not `viewport.fit`. Only `SvgGraphDiagram` takes `effects`.

The package does not set the width of a diagram on a page. Give the classes of your page layout with `className`.

## Documentation

- **Internals**: [docs/internals.md](./docs/internals.md) tells how the compiler, the layouts and the renderers divide the work, and which mistakes the code had before.
- **Copied code**: [docs/copied-code.md](./docs/copied-code.md) lists the code that is in two places, and where each fix must go.
- **Decisions**: the [architecture decision records](./docs/adr) tell why the design is as it is.
  1. [The diagram is a zukhruf package](./docs/adr/0001-the-diagram-is-a-zukhruf-package.md)

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
  lib/model/        the IR types
  lib/compiler/     reads the primitives, and makes the IR
  lib/layouts/      the pure geometry of the graph and the timeline
  lib/renderers/    svg/, canvas/, html/ and webgpu/ draw the layouts; shared/ holds the parts that they share
  lib/react/        the Diagram primitives and the chrome
  index.ts          the entry
styles.css          registers dist with @source
```
