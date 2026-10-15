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

The stylesheet also holds two patches: the pointer cursor on enabled buttons, and the cap on the height of a dialog. The base-nova button has no `cursor-pointer` class. The base-nova dialog has `data-slot="dialog-content"`, but no `max-h` or `overflow` class. Each patch is in a layer:

- The cursor is in `@layer base`.
- The cap is in `@layer components`.

A rule outside of a layer wins over each rule in a layer (MDN, `@layer`). Tailwind CSS puts its utility classes in `@layer utilities`. Thus a patch outside of a layer would win over each utility class of the app. In `base` and `components`, a patch comes before `utilities`, and a utility class of the app still wins.

An app must import the stylesheet with a plain `@import`. `@import '@zukhruf/shadcn/styles.css' layer(components)` puts all of the file into a layer, also its `@source`. Tailwind CSS then stops with the error "`@source` cannot be nested."

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
