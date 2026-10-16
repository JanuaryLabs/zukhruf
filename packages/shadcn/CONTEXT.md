# Shadcn

React components for an app. The shadcn CLI writes the components, and this package ships them with one entry and one stylesheet. An app imports the components and the stylesheet, and sets its own theme.

## Language

**Component**:
One React component of shadcn/ui, for example `Button` or `DialogContent`. One file in `src/components` holds the components of one registry item, for example `dialog.tsx` holds `Dialog`, `DialogTrigger` and `DialogContent`.
_Avoid_: Primitive (a primitive is a part of the headless library), widget, element (an element is a DOM element)

**Registry**:
The live service of shadcn/ui at `https://ui.shadcn.com/r`, from which the shadcn CLI downloads each item. An item is a set of files and dependencies, for example `calendar`. The registry has no versions.
_Avoid_: Catalog, repository (the git repository of shadcn/ui is a different thing)

**Headless library**:
The library that gives the behavior and the accessibility of a component, with no styles. This package uses Base UI. The other headless library of shadcn/ui is Radix UI.
_Avoid_: Primitives, base (zukhruf uses base for its lowest layer), UI library

**Preset**:
The visual design that the class strings of the components contain: the sizes, the spacing, the corners and the rings. This package uses nova. The preset is fixed when the CLI writes the source, and an app cannot change it.
_Avoid_: Style (the `style` field of `components.json` names the headless library and the preset together, as `base-nova`), theme

**Theme**:
The values of the CSS variables, for example `--primary` and `--radius`. The `.dark` class selects the dark values. An app changes the theme when it sets the variables after the import of the stylesheet.
_Avoid_: Preset, tokens, skin. `theme.css` is the generated file that sets the default theme.

**Generated source**:
The files that the shadcn CLI writes: `src/components`, `src/hooks`, `src/lib`, `src/index.ts` and `theme.css`. Nobody edits them by hand. The commit pins them.
_Avoid_: Vendored code (a person updates vendored code by hand), copy (each app kept a copy before this package)

**Sync**:
The run of `nx run shadcn:sync`. It writes the generated source again from the registry, with `shadcn@4.21.5`. A person reads the diff before a commit.
_Avoid_: Update (npm updates dependencies), build (the build compiles the generated source), regenerate

**Patch**:
A CSS rule in `styles.css`, in a layer, that changes what stock shadcn/ui does. There are three patches: the pointer cursor on buttons, the cap on the height of a dialog, and the width of the mobile sidebar. A utility class of an app still wins over the cursor and the cap. The width patch is in `@layer utilities`, because it must win over a utility class of the `Sheet`.
_Avoid_: Override, hack

**Private import**:
An import specifier that starts with `#`, for example `#components/button`. The `imports` field of `package.json` maps it to a file. Only files in this package can resolve it, so it is not public API. Node.js calls this feature subpath imports. The components use private imports to import each other.
_Avoid_: Alias (the `aliases` of `components.json` give the CLI these specifiers), internal import, self-reference (a self-reference uses the package name and needs a public subpath)

**Entry**:
The one public module of the package: `@zukhruf/shadcn`. It exports each component and each hook. The `exports` field of `package.json` also has `./styles.css`, which is the stylesheet, not an entry.
_Avoid_: Barrel, subpath, index (`src/index.ts` is the file of the entry)

**Stylesheet**:
`styles.css`, the one CSS file that an app imports. It imports `theme.css`, registers the `dist` folder with `@source`, and holds the patches. A person writes it, and the sync never changes it.
_Avoid_: Theme (the stylesheet holds more than the theme), CSS bundle
