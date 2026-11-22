# A host gets its looks through theme tokens and data-attribute patches

This ADR amends [ADR 0004](./0004-the-components-use-base-ui-and-the-nova-preset.md). ADR 0004 says that an app changes its look through the theme only, and the theme was the colors and the radius. Now the theme also covers density: the height and the background of the controls.

A host needs looks that nova does not have. Meddit's prototype has 40px controls on a white surface, and 46px controls on its auth pages; nova's controls are 32px and transparent. Before this ADR, Meddit restyled each control with `className`: `h-10`, `bg-card`, `text-sm`, `data-[size=default]:h-10` on each call site, and `[&_[data-slot=input]]:h-12` and more on the element of the auth layout. Each call site carried a copy of the same look, and `@shadcn/lint`'s `no-restyle` rule counted 209 hits in Meddit's web app.

A host cannot edit the generated source: the next sync writes over it ([ADR 0001](./0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)). Thus a look comes to a host in one of two ways, and never by a `className` restyle:

- **A theme token** for a look that holds for the whole app or for a subtree, for example the height of the controls. The token is a CSS variable. A patch of the stylesheet reads it, with nova's value as the fallback. A host that sets no token gets stock nova.
- **A data-attribute patch** for a named look of one instance that two or more apps share. The host writes `data-variant` or `data-size` on the component, and a rule of the stylesheet is keyed on `data-slot` and that attribute. Every component passes `data-*` through to its element, also the components that render with Base UI's `useRender`. A look that one app has stays in that app's stylesheet, and shadcn's own variant comes first where one exists.

## The tokens

| Token                      | Reaches                                                                                                                                                             | Fallback (nova)                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `--control-height`         | `Input` (`height`), `Textarea` (`min-height`), `SelectTrigger` at `data-size="default"`, `InputGroup`, `ComboboxChips` (`min-height`), `Button` at the default size | `calc(var(--spacing) * 8)`, 32px; 64px for `Textarea`                           |
| `--control-height-sm`      | `Button` at `size="sm"`                                                                                                                                             | `calc(var(--spacing) * 7)`, 28px                                                |
| `--control-background`     | `Input`, `Textarea`, `SelectTrigger`, `InputGroup`, `ComboboxChips`, a `PopoverTrigger` rendered as an outline `Button` (the trigger of a date picker)              | `transparent` (`background` for the `PopoverTrigger`); `input/30` under `.dark` |
| `--field-label-foreground` | `FieldLabel` and `FieldTitle` (both `data-slot="field-label"`), unless their `Field` is invalid                                                                     | the inherited colour (`currentcolor`)                                           |
| `--field-label-font-size`  | `FieldLabel` and `FieldTitle`                                                                                                                                       | `var(--text-sm)`, 14px                                                          |

A host sets a token like any other variable of the theme:

```css
:root {
  --control-height: 2.5rem;
  --control-height-sm: 2rem;
  --control-background: var(--card);
}

[data-layout='auth'] {
  --control-height: 2.875rem;
}
```

A second value on a subtree gives that subtree a second density. Meddit's auth pages take 46px this way.

## How a patch is written

- **It is keyed on the nova class that it replaces**, for example `[data-slot='input'].h-8`. When the host passes a class that tailwind-merge swaps in for that class, for example `h-12`, the element loses `h-8` and the patch no longer matches. Thus a host class still wins.
- **It is in `@layer utilities`, at one attribute more than the nova class.** A patch in an earlier layer loses to the utility class of the component. One attribute more wins without relying on the order of the rules, as the tabs patch of [ADR 0003](./0003-the-stylesheet-registers-its-own-source-and-keeps-its-patches-in-layers.md) does.
- **It leaves out each state that the nova class string styles**, with `:not()`: a disabled `Input` keeps `disabled:bg-input/50`, an `InputGroup` with a textarea or a block-aligned addon keeps `h-auto`, a hovered dark `SelectTrigger` keeps `dark:hover:bg-input/50`, a hovered or open `PopoverTrigger` keeps the `hover:bg-muted` and `aria-expanded:bg-muted` of the outline `Button`, and a button of an `InputGroup`, which writes `data-size`, keeps its own size.
- **A button patch is keyed on `group/button`, not on `data-slot`.** Each class string of `buttonVariants()` starts with `group/button`, so a link that takes the classes of a button (see the README) gets the height too.
- **When nova has no class to key on, the patch has no specificity.** nova's `InputGroup` has no background class in light mode, so its patch is `:where([data-slot='input-group'])`, and a field label has no colour class, so its patch is `:where([data-slot='field-label']…)`. Each utility class wins over them, also the `bg-input/30` of the command input.
- **A test checks each patch** for its layer and its selector, and a test checks that each control still renders the nova class that its patch is keyed on. A sync that drops one of these classes fails the test.

## The decisions

Ezz decided these on 2026-11-20 (zukhruf backlog #4994, from the plan for #5015):

- App-wide density and tone are CSS variables that the stylesheet reads, with nova's value as the fallback.
- A named look of one instance is a stylesheet rule keyed on `data-slot` and a `data-variant` or `data-size` that the host writes. A typo in such a name is caught by a guardrail, not by the types: the kit exports the names (`KIT_DATA_VARIANTS`, a hand-written module), a styles test checks each name, and a rule of `@zukhruf/eslint` checks the host's call sites. The guardrail comes with the first such look.
- The same day Ezz narrowed which looks enter the kit: shadcn's own variant comes first (a segmented control is `<ToggleGroup variant="outline" spacing={0}>`), and a named look enters the kit only when a second app needs it (the Rule of Three). Meddit's segmented track, pill tabs, chip trigger, warning and large `Badge`, and large `InputOTP` are Meddit's looks, so they live in Meddit's stylesheet until another app shares one. The kit has no data-attribute look yet.
- The 40px height of Meddit's controls is `--control-height`, not a `data-size="lg"`.
- `--control-height` reaches `Button` too: the prototype has one density for fields and buttons.
- The text of an input stays nova's `text-base md:text-sm`: 16px on a phone, 14px from 768px. iOS zooms into a focused field whose text is smaller than 16px. This is a recorded divergence from Meddit's prototype, which has 14px.
- A size of the prototype that is off Tailwind's scale is rounded to the scale, not kept exact. Meddit's auth pages lose their 15px control text and keep the kit's text sizes. Their 46px height is on the scale (`h-11.5`).
- Meddit's auth pages use the prototype's one height, 46px, through a second value of `--control-height` on that subtree.
- A look that only Meddit has lives in Meddit's own stylesheet, keyed on `data-slot`. It is neither a patch of the kit nor an exception of the lint rules.
- Spacing on a layout container is allowed for every host, by a contract in the `@shadcn/lint` config of `@zukhruf/eslint`.

## Considered Options

- **A `className` restyle at each call site.** Each call site holds a copy of the look, and `@shadcn/lint` reports it.
- **Edit the class strings of the generated source.** The next sync writes over the edit ([ADR 0001](./0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)).
- **A wrapper component in the host**, for example a Meddit `Input` that adds `h-10 bg-card`. Each host writes and keeps the same wrappers, and the wrapper hides the kit's API.
- **Typed variant props**, for example `size="lg"` on `Input`. Only an edit of the generated source adds a prop, and upstream shadcn/ui decides when its components get one.
- **Theme tokens and data-attribute patches in the stylesheet.** This option was selected.

## Consequences

- An app changes its look through the theme, which now covers the colors, the radius and the density of the controls, and through its own stylesheet for a look that only it has. A look that two apps share becomes a data-attribute look that the kit names.
- A host drops its `className` restyles of the controls. Meddit's web app drops `h-10`, `bg-card`, `text-sm` and `data-[size=default]:h-10` on its controls and buttons, and the `[&_[data-slot=…]]` rules of its auth layout.
- A host class that tailwind-merge does not see as a conflict, for example `md:h-12` next to nova's `h-8`, loses to a patch. Write the token instead.
- In light mode a host's `bg-*` class on an `InputGroup` wins over `--control-background`; in dark mode nova's `dark:bg-input/30` wins over that class, as in stock nova, and the patch replaces only nova's value.
- The command input keeps its own `bg-input/30` look in both modes.
- A sync that removes a class that a patch is keyed on fails `styles.test.ts`, and a person moves the patch to the new class.
