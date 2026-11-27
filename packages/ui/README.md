# @zukhruf/ui

React components for apps that use [`@zukhruf/shadcn`](../shadcn). This package is a UI extension: it does not ship its own copy of `@zukhruf/shadcn`. The app installs `@zukhruf/shadcn`, sets its theme, and imports its stylesheet. A component of this package that builds on `@zukhruf/shadcn` (`TheButton`) then uses the same copy and the same theme; `Editable` uses none of its components.

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

`TheButton` is a `Button` of `@zukhruf/shadcn` with a loading state, an icon and a tooltip. It needs a `ClockProvider` above it, see [The clock](#the-clock). It takes each prop of `Button`, for example `variant`, `size` and `onClick`, and these props:

| Prop      | Type                         | Default       | What it does                                                                                                                           |
| --------- | ---------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `loading` | `boolean`                    |               | Disables the button. After `delay`, it shows a spinner in place of the icon.                                                           |
| `delay`   | `number`                     | `300`         | The time in milliseconds from the start of `loading` to the spinner. A short load ends before the spinner shows, so it does not flash. |
| `icon`    | `ReactNode` or a Lucide icon |               | The icon before the text. Give an element, for example `<Save />`, or a Lucide component, for example `Save`.                          |
| `tooltip` | `string`                     |               | The text of a tooltip that shows when the user hovers over or focuses the button.                                                      |
| `spinner` | `ReactNode`                  | `<Spinner />` | The indicator that shows while loading. The default is the `Spinner` of `@zukhruf/shadcn`.                                             |

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

While loading, the name of the button stays its label, for example "Save", and a screen reader reads the button as disabled. The spinner is hidden from screen readers (`aria-hidden`), also when you give your own `spinner`, so its label does not join the name of the button. MUI, Mantine and Radix Themes name a disabled loading button the same way.

## Editable

`Editable` edits a saved text value in place, for example the title of a chat or a report. It has two parts: `Editable.Preview`, a button that shows the value, and `Editable.Input`, a bare input that edits a draft. The root renders no element of its own. Each part shows and hides itself: the Preview while not editing, the Input while editing. It needs no `ClockProvider`: it waits only on `requestAnimationFrame`, which is not a timer of `UiClock`.

```ts
type Label = { 'aria-label': string } | { 'aria-labelledby': string };

/** Owner mode: the owner opens and closes the edit (a React Router fetcher, a state machine). */
interface OwnerSave {
  editing: boolean;
  /** true when the Preview is clicked; false on cancel. Never false on commit: the owner closes. */
  onEditingChange: (editing: boolean) => void;
  /** A save is in flight: the input is disabled and a commit is ignored. */
  saving: boolean;
  /** Called with a trimmed, changed, non-empty value. The owner closes by editing={false}. */
  onValueCommit: (next: string) => void;
  defaultEditing?: never;
}

/** Promise mode: the package awaits the save, derives saving from it, and closes when it resolves. */
type PromiseSave = {
  saving?: never;
  onValueCommit: (next: string) => PromiseLike<unknown>;
} & (
  | {
      editing: boolean;
      onEditingChange: (editing: boolean) => void;
      defaultEditing?: never;
    }
  | {
      editing?: never;
      defaultEditing?: boolean;
      onEditingChange?: (editing: boolean) => void;
    }
);

type EditableProps = (OwnerSave | PromiseSave) & {
  /** The saved value. Each edit starts from it. */
  value: string;
  /** Gets focus when the edit ends. Default: the Preview. */
  finalFocus?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  children: ReactNode;
};

export function Editable(props: EditableProps): ReactNode;
export namespace Editable {
  function Preview(
    props: Label & { className?: string; children?: ReactNode },
  ): ReactNode;
  function Input(
    props: Label & {
      className?: string;
      'aria-invalid'?: boolean;
      'aria-describedby'?: string;
    },
  ): ReactNode;
}
```

### Two ways to save

The `saving` prop picks the mode. The types refuse each mix: owner mode with `defaultEditing`, promise mode with both `editing` and `defaultEditing`, a controlled promise mode with no `onEditingChange`, and a promise-mode save that returns nothing (write `async`).

| Mode    | Who knows the save                                       | Who closes the edit                                                       | A failed save                                                                         |
| ------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Owner   | The owner: it gives `saving`, for example from a fetcher | The owner, with `editing={false}`                                         | The owner keeps `editing` true and shows the error                                    |
| Promise | The package: `onValueCommit` returns a promise it awaits | The package, when the promise resolves; it calls `onEditingChange(false)` | The promise rejects; the edit stays open with the draft, and the error is the owner's |

Owner mode, a sidebar row whose save is a React Router fetcher. The owner has its own trigger (a double-click on the row), so it places the parts itself:

```tsx
<Editable
  value={title}
  editing={editing}
  onEditingChange={setRenaming}
  saving={fetcher.state !== 'idle'}
  onValueCommit={(next) =>
    void fetcher.submit({ intent: 'rename', title: next }, { method: 'post' })
  }
  finalFocus={rowRef}
>
  {editing ? (
    <Editable.Input
      aria-label={t('questionTitle')}
      aria-invalid={refused || undefined}
      aria-describedby={refused ? refusalId : undefined}
    />
  ) : (
    <NavLink ref={rowRef} to={to} onDoubleClick={() => setRenaming(true)}>
      {title}
    </NavLink>
  )}
</Editable>
```

Promise mode, uncontrolled. A click on the Preview opens the edit, and the Preview gets focus back when it ends:

```tsx
<Editable
  value={title}
  onValueCommit={(next) => rename.mutateAsync({ id, title: next })}
  placeholder={t('reportTitle')}
  maxLength={140}
>
  <Editable.Preview
    aria-label={t('renameReport')}
    className="truncate font-semibold"
  />
  <Editable.Input aria-label={t('reportTitle')} className="font-semibold" />
</Editable>
```

### What each event does

| Event                                  | What happens                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Click on the Preview                   | `onEditingChange(true)`; an uncontrolled root opens itself. Nothing when `disabled`.                                                                |
| The Input appears                      | It takes focus with its whole text selected, and again one frame later, so a closing menu can not move focus away.                                  |
| Enter                                  | Commit. `preventDefault`.                                                                                                                           |
| Blur                                   | Commit, but only once the Input has held focus for one frame.                                                                                       |
| Escape                                 | Cancel. `preventDefault` and `stopPropagation`, so a sheet or a dialog around the Input stays open.                                                 |
| A key while an input method composes   | Nothing. A key whose event is already `defaultPrevented` does nothing too.                                                                          |
| Commit                                 | The draft is trimmed. Empty or equal to `value`: cancel. Else `onValueCommit(trimmed)`. Ignored while saving.                                       |
| Cancel                                 | `onEditingChange(false)`; an uncontrolled root closes itself.                                                                                       |
| Saving                                 | The Input is disabled.                                                                                                                              |
| Saving ends and the edit is still open | The Input takes focus with its text selected again, so the user can fix the value.                                                                  |
| The edit ends                          | One frame later, `finalFocus` (default: the Preview) gets focus, but only when focus is on `body`. A user who moved focus elsewhere keeps it there. |

Each part throws `<Editable.Preview> must be rendered inside <Editable>` (or `<Editable.Input>`) outside a root.

### Words and direction

The package has no English string. Each part needs `aria-label` or `aria-labelledby`, and the type refuses a part with neither. The Input and the Preview have `dir="auto"`, so a title in Arabic or in English reads in its own direction. The owner gives the error text and links it with `aria-invalid` and `aria-describedby`.

The Input is a bare `<input>`, not the `Input` of `@zukhruf/shadcn`. Its fixed height, border, full width and `md:text-sm` fight inline text. The bare input takes the text style around it and hugs its content (`field-sizing-content`).

### The same concepts in other systems

| Concept             | Other systems                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Editable            | Ark UI and Chakra UI v3 `Editable`, Dice UI `Editable`, Atlassian `InlineEdit`, React Spectrum S2 `EditableCell` |
| Editing, controlled | Ark `edit` / `defaultEdit` / `onEditChange`, Dice `editing` / `defaultEditing` / `onEditingChange`               |
| Commit              | Ark `onValueCommit`, Atlassian `onConfirm`, Dice `onSubmit`                                                      |
| Saving              | React Spectrum S2 `isSaving`                                                                                     |
| Final focus         | Base UI Dialog `finalFocus`, Ark `finalFocusEl`                                                                  |

`@ark-ui/react` is the only maintained package with an editable part. It is not used: it brings a second component system (zag state machines) beside Base UI under `@zukhruf/shadcn`. Dice UI's `Editable` is a registry file to copy, not a package. Atlassian's needs `@atlaskit/*` and Compiled CSS.

## The clock

See [ADR 0001](./docs/adr/0001-a-component-gets-the-clock-from-a-required-provider.md).

`TheButton` waits on a timer for the delay. A component that waits on a timer or reads the time gets its clock from `useClock`. The app gives the clock one time, at its root, with `ClockProvider`. `useClock` throws when no provider is above it. There is no default clock.

```ts
export interface UiClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  Date: { now(): number };
  performance: { now(): number };
}

export function ClockProvider(props: {
  clock: UiClock;
  children: ReactNode;
}): ReactNode;

/** @throws Error when no ClockProvider is above the component. */
export function useClock(): UiClock;
```

`globalThis` and `createClock()` of `@sinonjs/fake-timers` both have each member. You can give a `UiClock` to a function of `@zukhruf/async`, for example `delay`, because `UiClock` has each member of its `Clock`.

### An app

The root of the app gives `globalThis`:

```tsx
import { createRoot } from 'react-dom/client';

import { ClockProvider } from '@zukhruf/ui';

createRoot(container).render(
  <ClockProvider clock={globalThis}>
    <App />
  </ClockProvider>,
);
```

### A component

`useDelayedLoading` of `TheButton` gets its clock from `useClock`. `TheButton` calls the hook on each render, so a button with no provider throws at its first render, also when it never loads.

```ts
function useDelayedLoading(loading: boolean | undefined, delay: number) {
  const clock = useClock();
  const isLoading = !!loading;
  const [delayPassed, setDelayPassed] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      return;
    }

    const timerId = clock.setTimeout(() => {
      setDelayPassed(true);
    }, delay);

    return () => {
      clock.clearTimeout(timerId);
      queueMicrotask(() => setDelayPassed(false));
    };
  }, [clock, isLoading, delay]);

  return isLoading && delayPassed;
}
```

A decision about "now" stays a function that takes the time as an argument. The component that calls it reads the time from `useClock`:

```ts
const now = new Date(useClock().Date.now());
```

### A test

A test gives `createClock()`. The clock does not replace a global, and the test moves the time inside `act`. This test from `the-button.test.ts` takes no real time for the delay. The test gives `children` in the props, because the type of `ClockProvider` requires it.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createClock } from '@sinonjs/fake-timers';

test('while loading, the spinner shows only after the delay, and each new load waits for the delay again', async () => {
  // Arrange
  GlobalRegistrator.register();
  try {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ClockProvider, TheButton } = await import('@zukhruf/ui');
    const clock = createClock();
    const root = createRoot(
      document.body.appendChild(document.createElement('div')),
    );
    const spinnerShows = () =>
      document
        .querySelector('svg.animate-spin')
        ?.parentElement?.classList.contains('opacity-100');
    const render = (loading: boolean) =>
      act(async () => {
        root.render(
          createElement(ClockProvider, {
            clock,
            children: createElement(
              TheButton,
              { loading, delay: 1000 },
              'Save',
            ),
          }),
        );
      });
    try {
      // Act
      await render(true);
      const atStart = spinnerShows();
      await act(() => clock.tickAsync(999));
      const beforeDelay = spinnerShows();
      await act(() => clock.tickAsync(1));
      const afterDelay = spinnerShows();
      await render(false);
      const afterLoad = spinnerShows();
      await render(true);
      const atNextStart = spinnerShows();
      await render(false);

      // Assert
      assert.deepEqual(
        { atStart, beforeDelay, afterDelay, afterLoad, atNextStart },
        {
          atStart: false,
          beforeDelay: false,
          afterDelay: true,
          afterLoad: false,
          atNextStart: false,
        },
      );
      assert.equal(clock.countTimers(), 0);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    await GlobalRegistrator.unregister();
  }
});
```

- The test moves the time to 1 ms before the delay. A test on real time can not do this.
- `clock.countTimers()` shows that the end of a load stops the timer. A test on real time can only sleep and hope.
- The other three tests of the file render `TheButton` too. Each one puts it in a `ClockProvider` with `createClock()`, and does not move the time.
- The test of the missing provider gives a function to `assert.rejects`: `assert.rejects(async () => { await act(…); }, /ClockProvider/)`. `act` returns a thenable and not a `Promise`, so `assert.rejects(act(…))` fails with `ERR_INVALID_ARG_TYPE`.
