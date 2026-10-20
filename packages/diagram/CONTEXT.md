# Diagram

React components that draw technical diagrams. A caller writes a diagram as a tree of primitives. A renderer compiles the tree into a graph or a timeline, calculates the layout, and draws it as SVG, on a canvas, or as HTML.

## Language

### The parts of the pipeline

**Primitive**:
One component of the `Diagram` object, for example `Diagram.Box` or `Diagram.Signal`. A primitive draws nothing. It only carries props, and the compiler reads them.
_Avoid_: Component (a component is a React component of the app), shape, element (an element is a DOM element)

**Renderer**:
A React component that takes a tree of primitives and draws one layout to one output: `SvgGraphDiagram`, `SvgTimelineDiagram`, `CanvasGraphDiagram` or `HtmlGraphDiagram`. Each renderer has its own compiler call.
_Avoid_: Output (the output is the SVG, canvas or HTML that a renderer makes), view, backend

**Compiler**:
The code in `src/lib/compiler/diagram-compile.ts`. It reads the primitives once and makes the IR. It throws on a child that is not a primitive, on a primitive of the other layout, on a duplicate id, and on an edge to a missing node.
_Avoid_: Parser, router (the router is part of the graph layout)

**IR**:
The plain data that the compiler makes from the primitives: `DiagramGraphIR` for a graph, `DiagramTimelineSpec` for a timeline. The layout reads only the IR.
_Avoid_: Model, AST, spec (`DiagramTimelineSpec` is the name of a type, not a second concept)

**Layout**:
The kind of diagram, and the pure functions that calculate its geometry. There are two layouts: the graph and the timeline. The functions are in `src/lib/layouts/`. `layoutGraph(ir)` calculates the layout of a graph and returns a `GraphLayout`. The package exports both.
_Avoid_: Mode (the mode is the animation), template

**Graph**:
The layout that puts nodes in the cells of a content-sized grid, and connects them with edges. It shows structure: what depends on what. See [ADR 0003](./docs/adr/0003-the-graph-layout-is-a-content-sized-grid.md).
_Avoid_: Architecture diagram (a graph can also show a state machine), network

**Timeline**:
The layout that puts lanes on the x-axis and signals on the y-axis, in order. It shows a sequence: who calls whom, and in what order. UML calls it a sequence diagram.
_Avoid_: Sequence (use it only for the UML name), gantt (a gantt chart shows clock time)

**Router**:
The part of the graph layout that selects the path of each edge and of each leader, and the position of each edge label and badge. All paths are orthogonal. `routeGraph()` in `src/lib/layouts/graph/route.ts` is its entry. `attach.ts` selects where a path touches its node, and `labels.ts` selects the position of a label.
_Avoid_: Compiler

**Measure**:
The first step of the graph layout. It calculates the size of each node from its text, its icon, its items, its stack and its caption. `measureText()` in `src/lib/layouts/text/measure-text.ts` gives the width of one text run, from a table of the glyph widths of the Geist fonts. It throws on a character that the table does not have.
_Avoid_: Estimate, guess (the table gives the real widths of the pinned fonts)

**Oracle**:
`assertSoundLayout()` in `src/testing/sound-layout.ts`. It checks the invariants of a `GraphLayout`, for example "no two nodes intersect" and "no edge goes through a node that is not its end". It throws one error that lists each violation, with the ids. Tests use it. The package does not export it.
_Avoid_: Validator (the compiler and the layout validate the input; the oracle checks the output), snapshot

### The grid of a graph

**Cell**:
One row and one column of the grid of a graph. `row` and `col` are integers from 0. One node at most is in a cell.
_Avoid_: Slot, position (a position is in pixels)

**Area**:
The rectangle of cells that a node or a group covers: `row`, `col`, `rowSpan` and `colSpan`. A span is an integer of 1 or more.
_Avoid_: Bounds (the bounds are the pixel rectangle), region

**Track**:
One row or one column of the grid. Each track gets the size of its largest content, as CSS Grid sizes an `auto` track. An empty track is 0.
_Avoid_: Lane (that is a timeline primitive), band

**Gutter**:
The space between two tracks, and before the first track and after the last track. It holds the group chrome and the paths of the edges. Each group border along a gutter is a straight line.
_Avoid_: Gap (`GAP` is only the middle part of a gutter), margin, padding

**Group chrome**:
The parts of a group around its members: the padding, the border, and the title band with the label. The layout puts the group chrome in the gutters, not in the tracks. An edge can go through a title band, but not through the label text.
_Avoid_: Chrome alone (the chrome is the header and the control panel), frame

### Timeline primitives

**Lane**:
`Diagram.Lane`. The vertical line of one actor in a timeline, with its label at the top and at the bottom. UML calls it a lifeline. The `--dgm-lifeline` variable sets its color.
_Avoid_: Swimlane (a swimlane is a band of an activity diagram), column, actor (the actor is the thing that the lane shows)

**Signal**:
`Diagram.Signal`. A horizontal arrow from one lane to another lane. A boxed signal puts its label in a box on the line, and splits the line into two stubs around the box.
_Avoid_: Message (the UML word), call, event

**Frame**:
`Diagram.Frame`. A labeled rectangle around some signals of a timeline, for example a loop or an alternative. A timeline has one frame at most.
_Avoid_: Fragment (React uses this word), box. Also, do not use frame for the chrome or for the `frame` prop of a node, which sets the border style of the node.

### Graph primitives

**Node**:
`Diagram.Node`. The general primitive for one item in the grid of a graph. Each other node primitive is a node with different defaults. A node has an area of cells. A node, a box, a card, a port, a label and a float fill their area. The other nodes keep their measured size, at the center of their area.
_Avoid_: Vertex, item

**Box**:
`Diagram.Box`. A node with a solid border and centered text. It is the usual node.
_Avoid_: Rect, block

**Card**:
`Diagram.Card`. A node with a solid border and text that starts at the left. Use it for a node with a description.
_Avoid_: Panel, tile

**Port**:
`Diagram.Port`. A node with no header and a transparent frame. It often holds a set of labels under a box.
_Avoid_: Slot. Do not mix it with a node port.

**Node port**:
One named point on a side of a node or a group, from the `ports` prop (type `DiagramNodePort`). An edge can attach to it.
_Avoid_: Port (that is the primitive), socket, handle

**Label**:
`Diagram.Label`. A node with no frame: only text at a grid position, for example a section title.
_Avoid_: Caption (a caption is text next to a node), heading

**Float**:
`Diagram.Float`. A node with a flat frame. An edge cannot attach to it.
_Avoid_: Decoration, sticker

**Marker**:
`Diagram.Marker`. A node that shows an icon, for example `server` or `user`, and has no frame by default.
_Avoid_: Icon (the icon is the picture in the marker), badge (a badge is the icon on an edge)

**Appliance**:
`Diagram.Appliance`. A node drawn as a hardware device: a body with a face, a row of ports, and an optional antenna. Its `appliancePorts` and `antenna` props change the drawing.
_Avoid_: Device, server (`server` is an icon name)

**Connector**:
`Diagram.Connector`. A small node with round corners, an optional icon, and a short label.
_Avoid_: Edge (an edge is a line), adapter

**Junction**:
`Diagram.Junction`. A small circle where edges meet or split.
_Avoid_: Dot, hub, joint

**Edge**:
`Diagram.Edge`. A line from one node or group to another node or group. The props of the edge set its arrowheads, its line style, its weight and its label. `exitSide` and `entrySide` select the sides where it goes out and goes in. The router selects its path.
_Avoid_: Link, connection, connector (that is a node)

**Arrow**:
`Diagram.Arrow`. An edge with an arrowhead at the target. It shows that X calls Y, or that X depends on Y.
_Avoid_: Pointer

**Wire**:
`Diagram.Wire`. An edge with no arrowhead. Use it when the direction is clear or the same both ways.
_Avoid_: Line (`Diagram.Line` is a line of a label), cable

**Group**:
`Diagram.Group`. A rectangle around a set of nodes, with a label. Its members are the primitives in it, in the JSX. Its area is the smallest area that holds the areas of its members, or the explicit area of its `row`, `col`, `rowSpan` and `colSpan`. A group can be in a group. Sibling groups cannot overlap.
_Avoid_: Cluster, container, subgraph

**Note**:
`Diagram.Note`. A node with no frame that holds text in a cell. With a `target`, the router draws a leader from the note to that node or group. An edge can attach to a note.
_Avoid_: Text, comment, tooltip

**Leader**:
The thin line with no arrowhead from a note to its target. The router selects its path, as for an edge.
_Avoid_: Edge (an edge is a primitive), pointer

### Primitives for both layouts

**Line**:
`Diagram.Line`. One line of a label with more than one line. It can set the color and the weight of that line.
_Avoid_: Row, Wire (that is an edge)

**Content**:
`Diagram.Content`, in a box, a card or a node. It holds real React content, for example a button. Its `size` prop gives the width and the height of the content, because the layout cannot measure React content. Only `HtmlGraphDiagram` draws it. The SVG and canvas renderers refuse it.
_Avoid_: Children (the children of a primitive are its label), slot

### Look and behavior

**Chrome**:
The parts around the drawing: the header with the title and the corner, the control panel of the mode, and the wrapper element that holds the theme classes. The code is in `src/lib/react/chrome/`.
_Avoid_: Frame (that is a timeline primitive), shell, card. Do not use chrome alone for the border and the title band of a group: that is the group chrome.

**Theme**:
The values of the `--dgm-*` CSS variables. The chrome sets a light set, and a dark set with the `dark:` variant. An app changes the theme when it sets the variables on the diagram.
_Avoid_: Style preset, tokens, skin

**Style preset**:
The `stylePreset` prop: `default` or `sketch`. The `sketch` preset sets the theme to black ink on white, and makes each tone the same gray.
_Avoid_: Theme, variant

**Accent**:
The highlight color of a diagram. The `accent` prop of a renderer sets it: `green`, `primary`, `neutral`, or a CSS color. The `accent` prop of a node, an edge, a lane or a signal is `true` or `false`: it selects the accent color for that part.
_Avoid_: Brand color, primary (`primary` is one value of the accent)

**Tone**:
A named color for the fill and the border of a node or a group: `neutral`, `green`, `blue`, `amber`, `rose`, `purple` or `slate`. Each tone has a `--dgm-tone-*-fill` and a `--dgm-tone-*-stroke` variable.
_Avoid_: Color (color is the text color of a label), variant

**Texture**:
A pattern inside a node or a group: `dots`, `hatch` or `none`.
_Avoid_: Fill, background

**Mode**:
How the diagram animates: `static` shows all at once, `reveal` draws the parts in order when the diagram comes into view, and `scrub` connects the drawing to the scroll position. A user that prefers reduced motion always gets `static`.
_Avoid_: Layout, animation type, state

**Progress**:
A `MotionValue` from 0 to 1 that the mode drives. Each part of the drawing reads it to know when to appear.
_Avoid_: Time, playhead (the playhead is the controlled value of the effects)

**Effects**:
The `effects` prop of `SvgGraphDiagram`. It draws pulses that move along the edges, with WebGPU on a canvas above the SVG. The value `'flow'` animates by itself. The value `{ flow }` gives a `MotionValue`, the playhead, that the caller controls.
_Avoid_: Animation (the mode is the animation of the drawing), particles, shader

**Viewport**:
The `viewport` prop: how the drawing fits its container. `fit` is `width`, `contain` or `natural`, and `zoom` scales it.
_Avoid_: Camera, canvas (the canvas is an output)

**Paper**:
The `paper` prop: a rectangle behind the drawing, with the background or the muted surface color, an optional border, and an optional corner radius.
_Avoid_: Background (`--dgm-bg` is the background color), card
