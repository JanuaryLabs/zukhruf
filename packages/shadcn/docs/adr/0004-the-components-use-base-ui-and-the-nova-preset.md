# The components use Base UI and the nova preset

shadcn/ui writes each component for one of two headless libraries: Radix UI or Base UI. It also writes each component with one preset. The `style` field of `components.json` names both, as `<headless library>-<preset>`. This package uses `base-nova`: Base UI with the nova preset.

Base UI is the default headless library of shadcn/ui since 2026-07-02. Radix UI is not deprecated.

The preset is in the class strings of each component. For example, the dialog of nova has `rounded-xl`, `p-4` and `ring-1`. Thus an app cannot select a preset at runtime. A second preset would be a second set of all components. The theme is different: the components read their colors and their radius from CSS variables, so each app sets its own theme.

## Considered Options

- **Radix UI.** It is not the default of shadcn/ui.
- **Both headless libraries.** That is two sets of all components, and two sets to sync and test.
- **A preset that each app selects.** The preset is in the class strings, so each app would need its own generated source. That is a copy in each app again.
- **Base UI with one preset, nova, and a theme for each app.** The maintainer selected this option.

## Consequences

- An app that used Radix UI components changes `asChild` to the `render` prop of Base UI.
- Each app has the nova preset. An app changes its look through the theme only.
- A different preset is a change of the `style` field and a sync. It changes the look of all apps that use the package.
