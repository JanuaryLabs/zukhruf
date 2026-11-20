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
  --control-height: 2.5rem;
  --control-background: var(--card);
}

.dark {
  --primary: oklch(0.7 0.15 260);
}
```

- The package sets the default theme in `@layer base`. A rule outside of a layer wins over it. A rule in `@layer base` that comes after the import also wins over it. Thus a host theme in a layer, for example the ChatGPT tokens of OpenAI, can set the variables. A rule in `@layer theme` loses, because Tailwind CSS declares `theme` before `base`. See [ADR 0005](./docs/adr/0005-the-default-theme-is-in-layer-base.md).
- The `.dark` class switches to the dark theme. Put it on an element, usually `<html>`. The element and all elements in it then use the `.dark` variables.

The `@theme inline` block of `theme.css` maps these variables to Tailwind CSS colors, so that a class such as `bg-primary` reads them:

- `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--border`, `--input` and `--ring`.
- `--chart-1` to `--chart-5`.
- `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border` and `--sidebar-ring`.

`--radius` gives the radii `--radius-sm` to `--radius-4xl`. `theme.css` does not set or map `--destructive-foreground`, `--success`, `--warning` or `--font-heading`. Thus a class such as `text-destructive-foreground` or `bg-success` has no color. An app that needs such a variable sets it, and maps it in its own `@theme inline` block ([Tailwind CSS: theme variables](https://tailwindcss.com/docs/theme)):

```css
:root {
  --success: oklch(0.6 0.15 150);
}

@theme inline {
  --color-success: var(--success);
}
```

The preset is fixed. The class strings of each component contain the preset, for example the rounded corners and the spacing of the dialog. Thus an app cannot change the preset. An app changes only the theme. See [ADR 0004](./docs/adr/0004-the-components-use-base-ui-and-the-nova-preset.md).

The theme also covers the density of the controls and the field labels: `--control-height`, `--control-height-sm`, `--control-background`, `--field-label-foreground` and `--field-label-font-size` (see [what the stylesheet adds](#what-the-stylesheet-adds-to-stock-shadcnui)). Set a token, not a `className` restyle such as `h-10 bg-card` on each control. A subtree can set a second value, for example taller controls on the auth pages. See [ADR 0006](./docs/adr/0006-a-host-gets-its-looks-through-theme-tokens-and-data-attribute-patches.md).

## The open state of the sidebar

`SidebarProvider` keeps its open state in a cookie. `SIDEBAR_COOKIE_NAME` is the name of that cookie. Use it to read the open state of the sidebar on the server, and give the value to `defaultOpen`:

```tsx
import { SIDEBAR_COOKIE_NAME, SidebarProvider } from '@zukhruf/shadcn';

const defaultOpen = cookies.get(SIDEBAR_COOKIE_NAME)?.value !== 'false';

<SidebarProvider defaultOpen={defaultOpen}>{children}</SidebarProvider>;
```

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

## Right to left

The sync installs the components in the RTL mode of shadcn (`"rtl": true` in `components.json`). The CLI then writes logical classes in place of physical ones: `ps-2.5` for `pl-2.5`, `end-2` for `right-2`, `text-start` for `text-left`, `rtl:rotate-180` on a chevron that points forward, `rtl:` translations for the switch thumb and the submenu line of the sidebar, and `side="inline-end"` for a submenu. Thus each component mirrors itself in a right-to-left page, and it renders as before in a left-to-right page.

A right-to-left app sets `dir="rtl"` on `<html>` and wraps its tree in `<DirectionProvider direction="rtl">`. Base UI positions popups and moves the keyboard focus by the direction of `DirectionProvider`. The popups render in a portal at the end of `<body>`, so they get the direction from `<html>`, not from an element inside the app.

Not fixed: the mobile sidebar has a hidden title and description in English (`Sidebar`, `Displays the mobile sidebar.`), and `SidebarTrigger` has the hidden label `Toggle Sidebar`. The latest registry item of shadcn/ui has these strings. Give `SidebarTrigger` an `aria-label` to change its accessible name.

## What the stylesheet adds to stock shadcn/ui

The stylesheet has eight patches:

- **A pointer cursor on enabled buttons.** In Tailwind CSS 4, a button has the default cursor of the browser, not the pointer. The upgrade guide of Tailwind CSS gives a rule that sets the pointer again. The patch is that rule, in `@layer base`.
- **A cap on the height of a dialog.** A dialog is never taller than the window minus `2rem`, and it scrolls when its content is taller. Thus the buttons at the bottom of a tall dialog stay on the screen. The rule is `max-height: calc(100dvh - 2rem); overflow-y: auto` on `[data-slot="dialog-content"]`. The patch is in `@layer components`.
- **The width of the mobile sidebar.** On a small screen, the sidebar is in a `Sheet`. The class `data-[side=left]:w-3/4` of the `Sheet` wins over the class `w-(--sidebar-width)` of the sidebar. Thus the sidebar was 3/4 of the window: 292.5px, not 288px, in a window of 390px. The patch sets `width: var(--sidebar-width)` on `[data-slot="sidebar"][data-mobile="true"][data-side]`.
- **A keyboard shortcut reads left to right.** In Arabic, the direction of the page shows the shortcut `⌘P` of a menu item as `P⌘`. The rule `unicode-bidi: plaintext` on `[data-slot="dropdown-menu-shortcut"]` takes the direction of the shortcut from its own text. The element stays right to left, so its `ms-auto` still puts it at the far end of the item. `direction: ltr` would turn `ms-auto` into a left margin, and the shortcut would move next to the label. The patch is in `@layer components`.
- **A tabs list that wraps grows to its rows.** The class `group-data-horizontal/tabs:h-8` of `TabsList` wins over the class `h-auto` of the app: both have the specificity of one class, and Tailwind CSS puts a class with a variant after a plain class. Thus a horizontal list with `flex-wrap` stayed 32px tall and its second row covered the content below it. In Meddit, at a width of 390px, four tabs took two rows of 74px in a list of 32px. The patch sets `height: auto` on `[data-slot="tabs-list"][data-orientation="horizontal"].flex-wrap`. A list with `flex-wrap` on one row also takes the height of its triggers: in Meddit at 1440px, 34px in place of 32px. The patch leaves a list without `flex-wrap` at 32px. Its triggers are `h-[calc(100%-1px)]`, thus 25px, and in a list of auto height the percentage does not resolve, so they would grow to 26px.

- **A select popup sits on its trigger.** With `alignItemWithTrigger`, the default of `SelectContent`, Base UI lines up the text of the selected item with the text of the trigger. The trigger's text starts after a 1px border and `ps-2.5`, 11px; the popup draws its edge with `ring-1`, a shadow, so the item's text started at 10px. Thus the popup sat 1px off the trigger: in Meddit at 1280px, 769–1169 for a trigger at 768–1168, and the label under the popup showed at its edge. The patch sets `padding-inline: 1px` on `[data-slot="select-content"]`, in `@layer components`. The popup then has the trigger's edges in both directions, and a popup opened without `alignItemWithTrigger` lines up its text with the trigger's text too.

- **The controls take their height and background from the theme.** `--control-height` sets the height of `Input`, `SelectTrigger` at `data-size="default"`, `InputGroup` and `Button` at the default size, and the minimum height of `Textarea` and `ComboboxChips`. `--control-height-sm` sets the height of `Button` at `size="sm"`. The button rules are keyed on the `group/button` class of `buttonVariants()`, so a link with the classes of a button takes them too. `--control-background` sets the background of `Input`, `Textarea`, `SelectTrigger`, `InputGroup` and `ComboboxChips`. Without a value, each rule falls back to nova: 32px (64px for `Textarea`), 28px, and `transparent` (`input/30` under `.dark`). Each rule is keyed on the nova class that it replaces, for example `[data-slot='input'].h-8`, so a class of the app that tailwind-merge swaps in for that class turns the rule off. A disabled control, an `InputGroup` with a textarea or a block-aligned addon, a hovered dark `SelectTrigger` and a button of an `InputGroup` keep their nova styles. The patch is in `@layer utilities`. See [ADR 0006](./docs/adr/0006-a-host-gets-its-looks-through-theme-tokens-and-data-attribute-patches.md).

- **The field labels take their colour and size from the theme.** `FieldLabel` and `FieldTitle` both write `data-slot="field-label"`. `--field-label-foreground` sets their colour and `--field-label-font-size` their size. Without a value, a label inherits its colour and keeps nova's `text-sm`, 14px. A label in a `Field` with `data-invalid="true"` keeps the `text-destructive` it inherits from the `Field`. The size rule is keyed on `text-sm`; nova gives a label no colour class, so the colour rule has no specificity and any `text-*` class of the app wins over it. The patch is in `@layer utilities`. See [ADR 0006](./docs/adr/0006-a-host-gets-its-looks-through-theme-tokens-and-data-attribute-patches.md).

The cursor, the cap, the shortcut and the select popup are in layers before `utilities`. Thus a utility class of the app, for example `cursor-wait` or `max-h-none`, still changes them.

The width patch is in `@layer utilities`, because only a rule in that layer wins over a utility class. Its selector has three attributes, so it wins over the two parts of `data-[side=left]:w-3/4`. The sidebar does not give its `className` to the mobile `Sheet`, so a utility class of the app cannot get to that element. To change the mobile width, write a rule outside of a layer.

The tabs patch is in `@layer utilities` for the same reason. Its selector has two attributes and a class, so it wins over the one class of `group-data-horizontal/tabs:h-8` in any order of the rules.

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

## Use the components well

- **Use a component of the package first.** Before you write a new component, look for one in this package. Use it when it does the job.
- **Keep your own components in the app.** A component that you make from the components of this package belongs to the app. Do not add it to this package. The sync writes over the generated source, and the package holds only the components of shadcn/ui.
- **Remove the outline of a `Card` with `ring-0`.** `Card` draws its outline with `ring-1`, not with a border. Thus `border-0` does not remove the outline.
- **Use the standard names of the theme variables.** Set `--primary`, `--background` and the other variables of the [theme](#theme). Do not add a brand prefix, for example `--acme-primary`. The components read only the standard names.
- **Put a `DropdownMenuLabel` in a `DropdownMenuGroup`.** `DropdownMenuLabel` uses `Menu.GroupLabel` of Base UI, and that component reads the context of a group. A label outside a group throws Base UI error #31, and the full menu stops. Radix UI accepted a label outside a group, thus an app that moves from Radix UI must find these labels. text2sql found one when it moved.

  ```tsx
  <DropdownMenuContent>
    <DropdownMenuGroup>
      <DropdownMenuLabel>Account</DropdownMenuLabel>
      <DropdownMenuItem>Profile</DropdownMenuItem>
    </DropdownMenuGroup>
  </DropdownMenuContent>
  ```

- **Know that the stylesheet changes the `data-*` variants of your own classes too.** `theme.css` imports `shadcn/tailwind.css`, and its `@custom-variant` rules redefine `data-open`, `data-closed`, `data-checked`, `data-unchecked`, `data-selected`, `data-disabled`, `data-active`, `data-horizontal` and `data-vertical` (`node_modules/shadcn/dist/tailwind.css`, `shadcn@4.23.0`). Stock Tailwind CSS makes `data-selected:` match an element that has the attribute, with any value ([Tailwind CSS: data attributes](https://tailwindcss.com/docs/hover-focus-and-other-states#data-attributes)). With the stylesheet, `data-selected:` matches only `[data-selected="true"]`. `data-open:`, `data-closed:`, `data-checked:`, `data-unchecked:`, `data-disabled:` and `data-active:` do not match the value `"false"`, and all of them except `data-disabled:` also match the same value of `data-state`, for example `[data-state="open"]`. `data-horizontal:` and `data-vertical:` match `[data-orientation="horizontal"]` and `[data-orientation="vertical"]`. These rules apply to each class of the app, not only to the components. For a different value, write the full form, for example `data-[selected=false]:`.
- **Show an error at the place where it occurs.** Show a form error or a field error next to the field or the action that failed, for example with `FieldError`. Show the error of a background task or of a mutation as a toast. Use `toast` and `Toaster` of this package, which use the toast of Base UI.

## Your own components

An app that writes its own components often needs `cn`, the function that joins class names. Import it from the `cn` package:

```tsx
import { cn } from 'cn';
```

This package does not export `cn`. Each symbol has one home ([zukhruf ADR 0001](../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 6).

## One entry

The package has one entry, `@zukhruf/shadcn`. It exports all components, all hooks and the hand-written modules, for example `SIDEBAR_COOKIE_NAME`. There are no subpaths such as `@zukhruf/shadcn/button`.

- A development server and plain Node.js load all components and their dependencies.
- A production bundle has only the components that the app uses. The `sideEffects` field of `package.json` lets the bundler remove the others.
- The bundler resolves each import of the entry before it removes code. Thus the app needs the peers of all dependencies, also when it does not use the component. The package lists `react-is`, a peer of `recharts`, as its own dependency. Then an app builds also when npm does not install peers, for example with `legacy-peer-deps=true`.
- The stylesheet gives the classes of all components, also of the components that the app does not use. An app that uses only `Button` and `Dialog` got 212 kB of CSS (31 kB with gzip) on 2026-10-15.

See [ADR 0002](./docs/adr/0002-one-entry-and-private-imports-between-the-components.md).

## API

The entry (`src/index.ts`) has one `export *` line for each file of 63 components, two hooks and one hand-written module. The component files are in `src/components`: `accordion`, `alert-dialog`, `alert`, `aspect-ratio`, `attachment`, `avatar`, `badge`, `breadcrumb`, `bubble`, `button-group`, `button`, `calendar`, `card`, `carousel`, `chart`, `checkbox`, `code-block`, `collapsible`, `combobox`, `command`, `context-menu`, `dialog`, `direction`, `drawer`, `dropdown-menu`, `empty`, `field`, `hover-card`, `input-group`, `input-otp`, `input`, `item`, `kbd`, `label`, `marker`, `menubar`, `message-scroller`, `message`, `native-select`, `navigation-menu`, `pagination`, `popover`, `progress`, `questionnaire`, `radio-group`, `resizable`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `spinner`, `switch`, `table`, `tabs`, `textarea`, `toast`, `toggle-group`, `toggle`, `tooltip` and `trace`. Each file holds the components of the registry item with the same name.

The hooks and the hand-written module:

```ts
// src/hooks/use-mobile.ts
// true when the window is narrower than 768px; it changes when the width crosses 768px.
export function useIsMobile(): boolean;

// src/hooks/use-highlighted-code.ts
// One node for each line of `value`, highlighted with Shiki for `language`.
// Until the highlighter of the language loads, each line is plain text.
export function useHighlightedCode(
  value: string,
  language: string,
): React.ReactNode[];

// src/hand-written/sidebar-cookie.ts
// The cookie in which SidebarProvider keeps its open state.
export const SIDEBAR_COOKIE_NAME = 'sidebar_state';
```

## Documentation

**Decisions**: the [architecture decision records](./docs/adr) tell why the design is as it is.

1. [The shadcn CLI writes the source, and the commit pins it](./docs/adr/0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)
2. [One entry, and private imports between the components](./docs/adr/0002-one-entry-and-private-imports-between-the-components.md)
3. [The stylesheet registers its own source and keeps its patches in layers](./docs/adr/0003-the-stylesheet-registers-its-own-source-and-keeps-its-patches-in-layers.md)
4. [The components use Base UI and the nova preset](./docs/adr/0004-the-components-use-base-ui-and-the-nova-preset.md)
5. [The default theme is in `@layer base`](./docs/adr/0005-the-default-theme-is-in-layer-base.md)
6. [A host gets its looks through theme tokens and data-attribute patches](./docs/adr/0006-a-host-gets-its-looks-through-theme-tokens-and-data-attribute-patches.md)

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
  hand-written/ written by hand: the exports that the generated source does not give
theme.css       generated: the CSS variables and the dark variant; imports shadcn/tailwind.css
styles.css      written by hand: imports theme.css, registers dist, holds the patches
components.json the configuration of the shadcn CLI
```

### The generated source

The shadcn CLI writes `src/components`, `src/hooks`, `src/lib`, `src/index.ts` and `theme.css`. Do not edit these files. The next sync writes over them, and the edit is lost. See [ADR 0001](./docs/adr/0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md).

- The lint rules and the TypeScript flags that the stock code fails are off. These exceptions apply only to the generated source.
- To change what a component does, add a patch to `styles.css`, in a layer.

### Sync

`nx run shadcn:sync` writes the generated source again. It uses `shadcn@4.23.0` and the live registry of shadcn/ui. The registry has no versions, so a sync on a different day can write different source. Read the diff before a commit.

The sync does these steps, in this order:

1. It resets `theme.css` to one line: `@import "tw-animate-css";`.
2. It runs `shadcn add index`, then `shadcn add --all`. `components.json` sets `"rtl": true`, so the CLI writes logical classes.
3. It puts the `:root` rule and the `.dark` rule of `theme.css` into `@layer base`. The CLI writes them outside of a layer.
4. It writes `src/index.ts`: one `export *` line for each component, each hook and each hand-written module.
5. It formats the generated source with Prettier.

Known facts about the sync:

- `theme.css` keeps the line `@import "shadcn/tailwind.css";`. That file holds the variants and the animations of the components, for example `data-open`. The sync does not copy it. The `shadcn` package is a dependency of this package, so npm installs the file with it, and a new version of `shadcn` gets to each app through npm.
- `src` does not import `date-fns`, but `date-fns` stays a dependency. The `calendar` item of the registry declares it.
- One sync in four failed one time, and the cause is not known. A second run passed.
