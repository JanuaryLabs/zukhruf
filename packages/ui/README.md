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

`TheButton` is a `Button` of `@zukhruf/shadcn` with a loading state, an icon and a tooltip. It needs a `ClockProvider` above it, see [The clock](#the-clock). It takes each prop of `Button`, for example `variant`, `size` and `onClick`, and these props:

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
