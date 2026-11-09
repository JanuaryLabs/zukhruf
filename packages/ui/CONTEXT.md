# UI

React components that an app builds from the components of `@zukhruf/shadcn`. This package is in the UI extension layer of the workspace ADR. It ships the components and one stylesheet. The app gives `@zukhruf/shadcn` and its theme.

## Language

**UI extension**:
A package of React components that an app builds from the components of `@zukhruf/shadcn`. It lists `@zukhruf/shadcn` as a peer dependency, so the app has one copy and one theme. The term comes from Mantine, which calls the packages on top of `@mantine/core` extensions.
_Avoid_: Plugin, add-on, wrapper, UI package (a UI package of the workspace ADR imports no zukhruf package)

**Component**:
One React component that this package exports, for example `TheButton`.
_Avoid_: Widget, element (an element is a DOM element), primitive

**Kit component**:
A component of `@zukhruf/shadcn` that a component of this package uses, for example `Button` or `Tooltip`.
_Avoid_: Base component (zukhruf uses base for its lowest layer), primitive

**Loading**:
The state of `TheButton` while the `loading` prop is true. The button is disabled in this state.
_Avoid_: Busy, pending (a pending promise is a different thing)

**Delay**:
The time in milliseconds from the start of loading to the spinner. A load that ends before the delay shows no spinner.
_Avoid_: Debounce (a debounce waits for the input to stop), timeout

**Clock**:
The object that gives the timers and the time to the components of one React tree. The type is `UiClock`. An app gives `globalThis`, and a test gives `createClock()` of `@sinonjs/fake-timers`. There is no default.
_Avoid_: Timer (a timer is one wait on the clock), time provider, scheduler

**Clock provider**:
`ClockProvider`, the component that gives the clock to the tree below it. `useClock` throws when no clock provider is above the component.
_Avoid_: Clock context (the context is private to this package), wrapper

**Spinner**:
The `Loader2` icon of Lucide that turns while the delay has passed and the button is still loading. It takes the place of the icon.
_Avoid_: Loader (Lucide names its icons loaders), progress (a progress bar shows an amount)

**Icon**:
The `icon` prop: a React element, or a Lucide component that `TheButton` draws at size 4.
_Avoid_: Image, glyph

**Icon button**:
A `TheButton` with a size that starts with `icon`. It shows only the icon or the spinner, and no text.
_Avoid_: Icon-only button, square button

**Tooltip**:
The `tooltip` prop: a text that a kit `Tooltip` shows when the user hovers over or focuses the button.
_Avoid_: Title (the `title` attribute is a different thing), hint, label (an `aria-label` is a different thing)

**Stylesheet**:
`styles.css`, the one CSS file that an app imports after `@zukhruf/shadcn/styles.css`. It registers the `dist` folder with `@source`, so Tailwind CSS makes the classes of the components.
_Avoid_: Theme (the theme comes from `@zukhruf/shadcn` and the app), CSS bundle
