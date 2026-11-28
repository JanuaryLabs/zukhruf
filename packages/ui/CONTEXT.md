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
The indicator that turns while the delay has passed and the button is still loading. It takes the place of the icon. By default it is the `Spinner` of `@zukhruf/shadcn`; the `spinner` prop replaces it. It is hidden from assistive technology, so the name of a loading button stays its label.
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

**Editable**:
`Editable`, the component that edits a saved text value in place. Its parts are the preview and the input. The root renders no element of its own. The name is the majority of the leaders: Ark UI, Chakra UI and Dice UI.
_Avoid_: Inline edit (Atlassian only), rename field, editable text

**Preview**:
`Editable.Preview`, the button that shows the saved value while not editing. A click on it opens the edit.
_Avoid_: Display, read view, trigger (an owner can have its own trigger)

**Draft**:
The text in the input while editing. Each edit starts it from the saved value. It is private to the component.
_Avoid_: Value (the value is the saved one), buffer

**Commit**:
Enter, or a blur after the first frame. The draft is trimmed; an empty or unchanged draft cancels, any other calls `onValueCommit`.
_Avoid_: Submit (no form is submitted), confirm, save (the save is the owner's call)

**Owner mode**:
The mode of `Editable` with a `saving` prop. The owner gives `editing` and `saving`, for example from a React Router fetcher, and closes the edit itself.
_Avoid_: Controlled mode (a promise mode can be controlled too), manual mode

**Promise mode**:
The mode of `Editable` with no `saving` prop. `onValueCommit` returns a promise; the component is saving until it settles, closes when it resolves and stays open when it rejects.
_Avoid_: Async mode, auto mode

**Saving**:
The state of `Editable` while a save is in flight: the owner's `saving` prop, or a promise of promise mode that has not settled. The input keeps focus, read-only and `aria-busy` (a disabled input would lose focus to the body), and a commit or an Escape is ignored.
_Avoid_: Pending (a pending promise is a different thing), loading (the loading of `TheButton`), busy

**Final focus**:
The element that gets focus when a key ends an edit (Escape, or Enter that commits or cancels): the `finalFocus` ref, or by default the preview. It gets focus in a microtask after the commit that removes the input, before any frame, so a dialog's focus manager never finds focus on the body. An edit that a blur ended does not move focus, so a user who moved focus keeps it. How the edit ended decides, not where focus is. The name is Base UI's, and Base UI returns a dialog's final focus in a microtask too.
_Avoid_: Restore focus, return focus target
