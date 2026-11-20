# The stylesheet registers its own source and keeps its patches in layers

Tailwind CSS 4 makes a class only when it finds the class name in a file that it scans. By default, it scans the files of the app. The class strings of the components are in `dist` of this package, in `node_modules`. When Tailwind CSS does not scan them, the app gets components with no styles.

Thus the stylesheet registers the folder itself:

```css
@import './theme.css';
@source "./dist";
```

Tailwind CSS 4.3.3 gives this evidence:

- An `@source` in an imported file resolves from that file, not from the file of the app (`at-import.test.ts:483` in the Tailwind CSS repository). Thus `./dist` is the `dist` of this package, at each place where npm installs it.
- Tailwind CSS scans a base under `node_modules` as External, and it does not obey `.gitignore` there (changelog 4.1.0, #17255, and 4.3.1, #20214).
- `./styles.css` is in the `exports` of `package.json`. Vite stops with an error for a subpath that `exports` does not list.

The stylesheet also holds six patches: the pointer cursor on enabled buttons, the cap on the height of a dialog, the width of the mobile sidebar, the height of a tabs list that wraps, the reading direction of a menu shortcut, and the inline padding of a select popup. The base-nova button has no `cursor-pointer` class. The base-nova dialog has `data-slot="dialog-content"`, but no `max-h` or `overflow` class. On a small screen, the sidebar is in a `Sheet`, and the class `data-[side=left]:w-3/4` of the `Sheet` wins over the class `w-(--sidebar-width)` of the sidebar. The tabs list has `group-data-horizontal/tabs:h-8`, which Tailwind CSS emits after an app's `h-auto`, so a list that the app lets wrap keeps 32px and its second row overlaps what follows (#4982, found in Meddit). A shortcut such as ⌘P must read left to right also in a right-to-left menu. A select popup opened with `alignItemWithTrigger`, the default of `SelectContent`, sat 1px off its trigger, to the right in a left-to-right page and to the left in a right-to-left page, and a sliver of what is under the popup showed at its edge (#4996, found in Meddit). Base UI lines up the text of the selected item with the text of the trigger's value. The trigger's text starts after a 1px border and `ps-2.5`, 11px. The popup draws its edge with `ring-1`, a shadow and not a border, so the item's text started after the group's `p-1` and the item's `ps-1.5`, 10px. Each patch is in a layer:

- The cursor is in `@layer base`.
- The cap is in `@layer components`.
- The width is in `@layer utilities`, with the selector `[data-slot="sidebar"][data-mobile="true"][data-side]`.
- The wrapping tabs list is in `@layer utilities`, with the selector `[data-slot="tabs-list"][data-orientation="horizontal"].flex-wrap`. It needs the app's `flex-wrap` class: on a list without it, `height: auto` would change what the triggers' `h-[calc(100%-1px)]` resolves against and move every single-row list by a pixel.
- The shortcut is in `@layer components`, with `unicode-bidi: plaintext`.
- The select popup is in `@layer components`, with `padding-inline: 1px` on `[data-slot="select-content"]`. The 1px stands for the trigger's border, on both sides, so the text of an item starts at 11px in both directions, and Base UI places the popup on the trigger's edges. The popup has no padding class, so no utility class of the component competes, and a utility class of the app still wins. A popup opened without `alignItemWithTrigger` is as wide as the trigger and in line with it, so the padding lines up its text with the trigger's text too. The label moves with the items. A separator's `-mx-1` still reaches the edge: the popup clips its overflow at the padding box, which is its border box.

A rule outside of a layer wins over each rule in a layer (MDN, `@layer`). Tailwind CSS puts its utility classes in `@layer utilities`. Thus a patch outside of a layer would win over each utility class of the app. In `base` and `components`, a patch comes before `utilities`, and a utility class of the app still wins.

The width patch must win over a utility class of the `Sheet`. A rule in `@layer components` cannot do this, because `utilities` comes after `components`. Thus the width patch is in `@layer utilities`. In one layer, the rule with the higher specificity wins. When the specificity is the same, the later rule wins. `data-[side=left]:w-3/4` has the specificity of two attributes. The patch has three attributes, so it wins also when a bundler changes the order of the rules. The sidebar does not give its `className` to the mobile `Sheet`, so no utility class of the app gets to that element. An app changes the mobile width with a rule outside of a layer.

An app must import the stylesheet with a plain `@import`. `@import '@zukhruf/shadcn/styles.css' layer(components)` puts all of the file into a layer, also its `@utility` and `@source` rules. Tailwind CSS refuses these rules in a layer. A build of an app on 2026-10-15 stopped with the error "`@utility` cannot be nested."

## Considered Options

- **Each app writes the `@source`**, for example `@source "../node_modules/@zukhruf/shadcn/dist";`. Each app must then know where npm puts the package, and that place changes with the layout of `node_modules`. An app that forgets the line gets components with no styles, and no error.
- **The stylesheet registers its own `@source`.** This option was selected.
- **The patches outside of a layer.** They would win over each utility class of the app.
- **The patches as edits of the class strings.** The sync writes over the generated source ([ADR 0001](./0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)).
- **The patches in `@layer base` and `@layer components`.** This option was selected.

## Consequences

- An app writes two imports, and no `@source` for this package.
- The CSS of the app has the classes of all components, also of the components that the app does not use, because Tailwind CSS scans all of `dist`.
- An app must not import the stylesheet with `layer()`. The README tells this.
- A new patch goes into `styles.css`, in a layer.
- `theme.css` is generated source. `styles.css` is written by a person, and the sync never changes it.
