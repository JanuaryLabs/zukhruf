# @zukhruf/ui

React components that an app builds from the components of [`@zukhruf/shadcn`](../shadcn). This package is a UI extension: it does not ship its own copy of `@zukhruf/shadcn`. The app installs `@zukhruf/shadcn`, sets its theme, and imports its stylesheet. The components of this package then use the same copy and the same theme.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Install

```sh
npm i @zukhruf/ui @zukhruf/shadcn
```

The peer dependencies are `@zukhruf/shadcn`, `react` 19, `react-dom` 19 and `tailwindcss` 4. Install `@zukhruf/shadcn` yourself. npm does not install it for you when `legacy-peer-deps` is set. The other dependencies, `cn` and `lucide-react`, install with the package.

## Use it

Import the stylesheets in the Tailwind CSS file of the app, after Tailwind. Import `@zukhruf/shadcn/styles.css` first, then `@zukhruf/ui/styles.css`:

```css
@import 'tailwindcss';
@import '@zukhruf/shadcn/styles.css';
@import '@zukhruf/ui/styles.css';
```

Obey two rules:

- **Use a plain `@import`.** Do not add `layer(…)` to the import. The stylesheet holds an `@source` rule, and Tailwind CSS refuses an `@source` rule in a layer.
- **Do not add an `@source` for the package.** The stylesheet registers its own `dist` folder. Tailwind CSS then finds the classes of the components.

## TheButton

`TheButton` is a `Button` of `@zukhruf/shadcn` with a loading state, an icon and a tooltip. It takes each prop of `Button`, for example `variant`, `size` and `onClick`, and these props:

| Prop      | Type                         | Default | What it does                                                                                                                           |
| --------- | ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `loading` | `boolean`                    |         | Disables the button. After `delay`, it shows a spinner in place of the icon.                                                           |
| `delay`   | `number`                     | `300`   | The time in milliseconds from the start of `loading` to the spinner. A short load ends before the spinner shows, so it does not flash. |
| `icon`    | `ReactNode` or a Lucide icon |         | The icon before the text. Give an element, for example `<Save />`, or a Lucide component, for example `Save`.                          |
| `tooltip` | `string`                     |         | The text of a tooltip that shows when the user hovers over or focuses the button.                                                      |

```tsx
import { Settings, Trash } from 'lucide-react';

import { TheButton } from '@zukhruf/ui';

export function Toolbar({
  deleting,
  onDelete,
}: {
  deleting: boolean;
  onDelete(): void;
}) {
  return (
    <>
      <TheButton
        variant="destructive"
        icon={Trash}
        loading={deleting}
        onClick={onDelete}
      >
        Delete
      </TheButton>
      <TheButton
        size="icon"
        variant="outline"
        icon={Settings}
        tooltip="Open settings"
      />
    </>
  );
}
```

With `size="icon"` (or another `icon-*` size), the button shows only the icon, and the spinner takes its place while loading. Give a `tooltip` to an icon button, so the user can know what it does.
