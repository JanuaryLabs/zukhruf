# @zukhruf/shadcn

Each [shadcn/ui](https://ui.shadcn.com) component, as one package. The components use Base UI as their headless library and nova as their preset. An app imports the components from one entry and the styles from one stylesheet. The app sets its theme with CSS variables.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## The problem

shadcn/ui is not a package. Its CLI copies the source of each component into the repo of the app. Thus each app keeps its own copy, and the copies drift apart. A fix in one copy does not go into the other copies. For example, two apps each wrote the same fix for a tall dialog, and other apps still do not have it. Also, `shadcn add --overwrite` writes over a copy, and it removes the changes that an app made by hand.

This package keeps one copy. A fix goes into the package one time, and each app gets it with the next version.

## Install

```sh
npm i @zukhruf/shadcn
```

The peer dependencies are `react` 19, `react-dom` 19 and `tailwindcss` 4. The other dependencies, for example `@base-ui/react` and `lucide-react`, install with the package.

## Use it

Import the stylesheet in the Tailwind CSS file of the app, after Tailwind:

```css
@import 'tailwindcss';
@import '@zukhruf/shadcn/styles.css';
```

Import the components from the entry:

```tsx
import { Button, Dialog, DialogContent } from '@zukhruf/shadcn';
```

Obey two rules:

- **Use a plain `@import`.** Do not write `@import '@zukhruf/shadcn/styles.css' layer(components);`. A `layer()` puts all of the stylesheet into a layer, also its `@utility` and `@source` rules. Tailwind CSS refuses these rules in a layer. The build stops with the error "`@utility` cannot be nested."
- **Do not add an `@source` for the package.** The stylesheet registers its own `dist` folder. Tailwind CSS then finds the classes of the components. See [ADR 0003](./docs/adr/0003-the-stylesheet-registers-its-own-source-and-keeps-its-patches-in-layers.md).

## Theme

The theme is the values of a set of CSS variables, for example `--primary`, `--background` and `--radius`. To change the theme, set the variables after the import:

```css
@import 'tailwindcss';
@import '@zukhruf/shadcn/styles.css';

:root {
  --primary: oklch(0.55 0.2 260);
  --radius: 0.5rem;
}

.dark {
  --primary: oklch(0.7 0.15 260);
}
```

- Write these rules outside of a layer. The package sets the variables outside of a layer, and a rule in a layer loses to them.
- The `.dark` class switches to the dark theme. Put it on an element, usually `<html>`. The element and all elements in it then use the `.dark` variables.

The preset is fixed. The class strings of each component contain the preset, for example the rounded corners and the spacing of the dialog. Thus an app cannot change the preset. An app changes only the theme. See [ADR 0004](./docs/adr/0004-the-components-use-base-ui-and-the-nova-preset.md).

## Composition

Base UI uses the `render` prop where Radix UI uses `asChild`. The `render` prop sets the element that the component renders.

Radix UI:

```tsx
<DialogTrigger asChild>
  <Button variant="outline">Open</Button>
</DialogTrigger>
```

Base UI:

```tsx
<DialogTrigger render={<Button variant="outline" />}>Open</DialogTrigger>
```

## What the stylesheet adds to stock shadcn/ui

The stylesheet has three patches:

- **A pointer cursor on enabled buttons.** In Tailwind CSS 4, a button has the default cursor of the browser, not the pointer. The upgrade guide of Tailwind CSS gives a rule that sets the pointer again. The patch is that rule, in `@layer base`.
- **A cap on the height of a dialog.** A dialog is never taller than the window minus `2rem`, and it scrolls when its content is taller. Thus the buttons at the bottom of a tall dialog stay on the screen. The rule is `max-height: calc(100dvh - 2rem); overflow-y: auto` on `[data-slot="dialog-content"]`. The patch is in `@layer components`.
- **The width of the mobile sidebar.** On a small screen, the sidebar is in a `Sheet`. The class `data-[side=left]:w-3/4` of the `Sheet` wins over the class `w-(--sidebar-width)` of the sidebar. Thus the sidebar was 3/4 of the window: 292.5px, not 288px, in a window of 390px. The patch sets `width: var(--sidebar-width)` on `[data-slot="sidebar"][data-mobile="true"][data-side]`.

The cursor and the cap are in layers before `utilities`. Thus a utility class of the app, for example `cursor-wait` or `max-h-none`, still changes them.

The width patch is in `@layer utilities`, because only a rule in that layer wins over a utility class. Its selector has three attributes, so it wins over the two parts of `data-[side=left]:w-3/4`. The sidebar does not give its `className` to the mobile `Sheet`, so a utility class of the app cannot get to that element. To change the mobile width, write a rule outside of a layer.

## Links that look like buttons

A control that goes to a different page must stay a link. Do not write `<Button render={<Link />} nativeButton={false}>`. This makes an `<a>` with `role="button"`. A screen reader then calls the link a button, and the Space key activates it.

Put the classes of the button on the link:

```tsx
import { cn } from 'cn';

import { buttonVariants } from '@zukhruf/shadcn';

<Link
  href="/settings"
  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
>
  Settings
</Link>;
```

Use `cn` around `buttonVariants`. `Button` merges the classes that conflict through `cn`, which uses tailwind-merge. Without `cn`, the classes that conflict stay on the link, and the link looks different from a button. In one app, the link had a radius of 10px, not 8px, and it was 2px wider than the button.

## Your own components

An app that writes its own components often needs `cn`, the function that joins class names. Import it from the `cn` package:

```tsx
import { cn } from 'cn';
```

This package does not export `cn`. Each symbol has one home ([zukhruf ADR 0001](../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 6).

## One entry

The package has one entry, `@zukhruf/shadcn`. It exports all components and hooks. There are no subpaths such as `@zukhruf/shadcn/button`.

- A development server and plain Node.js load all components and their dependencies.
- A production bundle has only the components that the app uses. The `sideEffects` field of `package.json` lets the bundler remove the others.
- The bundler resolves each import of the entry before it removes code. Thus the app needs the peers of all dependencies, also when it does not use the component. The package lists `react-is`, a peer of `recharts`, as its own dependency. Then an app builds also when npm does not install peers, for example with `legacy-peer-deps=true`.
- The stylesheet gives the classes of all components, also of the components that the app does not use. An app that uses only `Button` and `Dialog` got 212 kB of CSS (31 kB with gzip) on 2026-10-15.

See [ADR 0002](./docs/adr/0002-one-entry-and-private-imports-between-the-components.md).

## Documentation

**Decisions**: the [architecture decision records](./docs/adr) tell why the design is as it is.

1. [The shadcn CLI writes the source, and the commit pins it](./docs/adr/0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)
2. [One entry, and private imports between the components](./docs/adr/0002-one-entry-and-private-imports-between-the-components.md)
3. [The stylesheet registers its own source and keeps its patches in layers](./docs/adr/0003-the-stylesheet-registers-its-own-source-and-keeps-its-patches-in-layers.md)
4. [The components use Base UI and the nova preset](./docs/adr/0004-the-components-use-base-ui-and-the-nova-preset.md)

## Development

This package is part of the [zukhruf](../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run shadcn:sync        # writes the generated source again with the shadcn CLI
npx nx run shadcn:test        # builds, then runs the tests
npx nx run shadcn:typecheck   # formats, lints, then type checks
npx nx run shadcn:build       # compiles src/ to dist/
```

```
src/
  components/   generated: one file for each component
  hooks/        generated: the hooks that the components use
  lib/          generated: the helpers that the components use
  index.ts      generated: the entry
theme.css       generated: the CSS variables, the variants and the ejected shadcn CSS
styles.css      written by hand: imports theme.css, registers dist, holds the patches
components.json the configuration of the shadcn CLI
```

### The generated source

The shadcn CLI writes `src/components`, `src/hooks`, `src/lib`, `src/index.ts` and `theme.css`. Do not edit these files. The next sync writes over them, and the edit is lost. See [ADR 0001](./docs/adr/0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md).

- The lint rules and the TypeScript flags that the stock code fails are off. These exceptions apply only to the generated source.
- To change what a component does, add a patch to `styles.css`, in a layer.

### Sync

`nx run shadcn:sync` writes the generated source again. It uses `shadcn@4.21.5` and the live registry of shadcn/ui. The registry has no versions, so a sync on a different day can write different source. Read the diff before a commit.

The sync does these steps, in this order:

1. It resets `theme.css` to one line: `@import "tw-animate-css";`.
2. It runs `shadcn add index`, then `shadcn add --all`.
3. It runs `shadcn eject`. This step runs the CLI through `node`, because `npx` cannot find the `shadcn` package that npm hoisted to the workspace root.
4. It writes `src/index.ts`: one `export *` line for each component and each hook.
5. It formats the generated source with Prettier.

Known facts about the sync:

- The ejected CSS comes from the newest `shadcn` package, not always from 4.21.5. The first lines of `theme.css` record its version.
- `src` does not import `date-fns`, but `date-fns` stays a dependency. The `calendar` item of the registry declares it.
- One sync in four failed one time, and the cause is not known. A second run passed.
