# The graph layout is a content-sized grid

The graph layout put each node in a grid of fixed pixel tracks. A node was 176 pixels wide, and a row had a fixed height. The layout did not measure text, and it did not refuse an overlap. When the content did not fit, the author moved the parts with pixel props: fractional rows and columns, guides, waypoints, label offsets, and group padding. The engine trusted these values.

The homelab example shows the result. It drew about 30 defects that we measured in the browser:

- 11 nodes had text that went out of the box.
- 5 sibling groups overlapped, and the border of the cluster went through two nodes.
- The title bands of groups were on top of their nodes.
- One edge went through a node, because a waypoint segment did not avoid obstacles.
- One label was 252 pixels from its edge, because of a `labelDx`.
- Some edges were diagonal, because the router had a fallback when it found no orthogonal path.

The cause is the API, not the example. The API told the author to do the geometry. No record told why the pixel props were there. The fractional positions and the `tight` groups were patches for the fixed row height (text2sql `4de93388`). Backlog item #2744 tracked the overlaps of the homelab.

The words in this document have one meaning each. See the glossary in [CONTEXT.md](../../CONTEXT.md).

## Decision

The graph layout is a content-sized grid, as the grid of D2 and CSS Grid are. The author gives each node a cell. The engine calculates all of the geometry. `layoutGraph(ir)` is a pure, synchronous function that returns a `GraphLayout`. The package exports both. The three graph renderers call it one time and only copy its values.

The engine does these steps, in this order:

1. **Measure.** The engine calculates the size of each node from its text, its icon, its items, its stack and its caption. It measures each text run with a table of glyph widths.
2. **Areas.** Each node and each group gets an area of whole cells: `row`, `col`, `rowSpan` and `colSpan`. A group gets the area of its members, or the area that the author gives. The engine throws when the grid cannot be drawn without overlap.
3. **Gutters.** The engine puts the chrome of each group (its padding, its border and its title band) in the gutters between the tracks, not in the tracks. The engine sizes the gutters before the tracks, because no gutter depends on the size of a track. Each depth of group has one slot along the full gutter, so each group border is a straight line.
4. **Tracks.** Each row and each column gets the size of its largest content, as CSS Grid sizes its `auto` tracks. An item that spans tracks divides the missing size equally between them. An empty track is 0.
5. **Place.** A node, a box, a card, a port, a label and a float fill their area. A marker, an appliance, a connector, a junction and a note keep their own size, at the center of their area.
6. **Route and label.** An orthogonal router finds the path of each edge with A\* on a 4-pixel grid. The nearest edges route first. Each edge, with its label and its badge, is an obstacle for the next edge. A label goes beside the longest segment of its edge, at the first free position.

The engine throws when the content does not fit: two nodes in one cell, a node in the area of a group that it is not a member of, sibling groups that overlap, an edge with no route, a label with no free position, or a character that the glyph table does not have. Each error names the elements and the cells. The engine never draws a diagonal line or moves a part on top of another part.

An edge can go through the title band of a group, but not through its label text. ELK and D2 use the same rule. With a stricter rule, the edges into a cluster went around the full cluster.

`assertSoundLayout` in `src/testing/sound-layout.ts` is the oracle. It checks the invariants of a `GraphLayout`, for example "no two nodes intersect" and "no edge goes through a node that is not its end". The tests of the engine and of the renderers use it. See [the internals](../internals.md).

### Why not ELK

ELK is the best known engine for this work, but it does not fit:

- Its API is asynchronous only. A React renderer must have the layout during the render, and the layout must also run on the server.
- It is about 8 MB.
- Its interactive modes keep the order of the nodes, not their cells. The author of a diagram selects the cells.

### Why the fonts are pinned

The engine measures text before a browser draws it, also on the server. The engine can do this only when it knows the font. Thus the package ships Geist Sans and Geist Mono (`@fontsource/geist-sans` and `@fontsource/geist-mono`, OFL), and its stylesheet loads them. The width of a text is the same on each operating system and in server rendering.

A script reads the installed font files and writes `src/lib/layouts/text/font-metrics.generated.ts`: the advance of each glyph, the kerning of each ASCII pair, and the vertical metrics, for each face and weight. Run `nx run diagram:generate-font-metrics` after an upgrade of `@fontsource`. A test makes the table again from the installed files, and it fails when the table changed.

We proved the measurement in the browser. On 73 text runs of the homelab, the width that the engine calculates was never smaller than the width that the browser draws. It was larger by 0.52 pixels at most, because the engine rounds up to the next half pixel.

### Why `Diagram.Content` takes a declared size

`Diagram.Content` holds real React content, for example a button. The engine is synchronous, and it runs before React draws anything. It cannot measure React content. Thus the author gives the size: `<Diagram.Content size={{ w: 96, h: 56 }}>`. An HTML `<img>` element has `width` and `height` for the same reason. It is the only pixel value that the graph API accepts.

## Considered Options

- **Keep the pixel API, and fix the example.** The next diagram gets the same defects, because the API still tells the author to do the geometry.
- **ELK.** See above.
- **A content-sized grid with our own engine.** This option was selected.
- **libavoid-js 0.5.0-beta.5** for the routes. Its license is LGPL-2.1, and this package is MIT. Its API is asynchronous WebAssembly. It is a beta version.
- **taffy-layout 3.0.0** for the tracks. It is WebAssembly, and it replaces only about 100 lines of track sizing. It does not have the gutter model.
- **@chenglou/pretext 1.0.0** for the text. It measures with a canvas, so it does not work in server rendering.
- **@capsizecss/metrics 4.4.0** for the text. It gives the vertical metrics only, not the width of each glyph.
- **yoga-layout 3.2.1.** It does flexbox only, not a grid.
- **heap-js** for the A\* queue. It is a dependency that replaces a heap of 50 lines.
- **The system fonts.** Each operating system draws a different width, so the engine cannot measure the text before the browser draws it.

## The removed API

The rule: remove each prop that exists only for geometry. Keep the kinds of nodes, because they tell what a node is. There are no shims and no aliases.

- **Primitives:** `Guide`, `Waypoint` and `Phantom`. `Entry` and `Exit`, because `entrySide` and `exitSide` do the same. `Text`, the alias of `Note`.
- **Renderer prop:** `graph`, the size of the columns and rows.
- **Node props:** `width`, `height`, `fontSize`, `fontWeight`, `bodyFontSize`, `bodyLineGap`, `iconSize`, `captionOffset`, `captionFontSize`, `captionFontWeight`, `stackOffset`, `stackDx`, `stackDy`, `stackWidthStep`, `stackHeightStep`, `rx`, `slant`, `textAlign`, `connectable` and `group`, and the `offset` of a node port. A fractional `row` or `col` throws.
- **Edge props:** `route`, `waypoints`, `exitOffset`, `entryOffset`, `entryGap`, `stubDistance`, `labelSide`, `labelOffset`, `labelT`, `labelSegment`, `labelDx`, `labelDy`, `labelAlign`, `labelFontSize`, `labelFramePadding`, `labelLineGap`, `badgeSide`, `badgeOffset`, `badgeDx`, `badgeDy` and `badgeT`. `weight` (`regular` or `bold`) replaces `strokeWidth`.
- **Group props:** `padding`, `tight`, `tightX`, `tightY`, `titleGap`, `bounds`, `rx`, `rowStart`, `rowEnd`, `colStart` and `colEnd`. A group gets `row`, `col`, `rowSpan` and `colSpan` for an explicit area. `dividers` is now a boolean.
- **DOM attributes:** `data-diagram-edge-route`, `data-diagram-edge-label-segment`, `data-diagram-edge-label-line-gap`, and the attributes of the body font.

The API also gets new parts: `rowSpan` on each node, the explicit area of a group, `Diagram.Note` as a node in a cell with a leader to its `target`, and the `size` of `Diagram.Content`.

## Consequences

- An author gives cells, and the diagram does not overlap. When the content does not fit, the author gets an error during development, not a bad drawing.
- The text2sql blog and its diagrams skill use the removed API, for example `colSpan={1.19}` to fit text. They must change to the new API when they update the package. Backlog item #2797 tracks this work.
- The playground examples were made again on the new API, one box at a time. The homelab and the agent workflow pass the oracle, and a browser check of each example finds no text outside its box.
- The package has two more dependencies, `@fontsource/geist-sans` and `@fontsource/geist-mono`. An app that imports the stylesheet loads the Geist fonts.
- A diagram cannot be fine-tuned with pixels. When the router or the label placement is wrong, fix the engine, not the diagram. See [the internals](../internals.md).
- A canvas has no switch for ligatures, so the canvas can draw the Geist `->` ligature, which the table does not measure. Backlog item #2799 tracks this.
