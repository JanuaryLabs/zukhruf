# The default theme is in `@layer base`

`theme.css` sets the default theme: the `:root` rule and the `.dark` rule with the CSS variables. The shadcn CLI writes these two rules outside of a layer. A rule outside of a layer wins over each rule in a layer, also when the rule in the layer comes later (MDN, `@layer`). Thus a host theme in a layer could not change the theme. For example, context-compiler loads the ChatGPT tokens of OpenAI. `@openai/mcp-extensions/styles.css` declares them in `@layer base`, with the same names: `--background`, `--primary`, `--radius` and more. With the default theme outside of a layer, the components and all other controls of the page got the values of shadcn/ui, not the values of ChatGPT.

Thus the sync puts the `:root` rule and the `.dark` rule into `@layer base`. Tailwind CSS uses the same method for its own variables: it declares them in `@layer theme`, and an app changes them with a later rule.

Tailwind CSS 4.3.3 gave these results on 2026-10-31:

- `@import './theme.css' layer(base)` stops with the error "`@utility` cannot be nested." `theme.css` imports `shadcn/tailwind.css` and `tw-animate-css`, and these files hold `@utility` rules.
- `@custom-variant` in a layer stops with the error "`@custom-variant` cannot be nested." `theme.css` holds `@custom-variant dark`.
- `@layer base { :root { … } }` and `@layer base { .dark { … } }` compile. `@theme inline` stays outside of the layer, and its `var(--background)` and the other references resolve to the variables in the layer. A host rule in `@layer base` after the import comes after the default theme in the output.

Thus only the two rules go into the layer. The rest of `theme.css` stays outside of a layer.

The CLI finds the `:root` rule and the `.dark` rule only at the top level of the file. Before each sync, the sync resets `theme.css`, and the CLI writes the two rules at the top level again. Thus the sync puts them into the layer after the CLI runs, with `perl`. A sync that loses this step makes `styles.test.ts` fail: the test finds the default theme outside of `@layer base`.

The order in the layer is important. `:root` and `.dark` have the same specificity. Thus `.dark` comes after `:root`, and the `.dark` class switches the theme. In one layer, the later rule wins. Thus a host theme in `@layer base` wins when it comes after the import of the stylesheet.

## Considered Options

- **Keep the default theme outside of a layer.** A host theme in a layer cannot change it.
- **Import `theme.css` with `layer(base)`.** Tailwind CSS refuses `@utility` and `@custom-variant` in a layer.
- **Edit `theme.css` by hand.** The next sync writes over the edit ([ADR 0001](./0001-the-shadcn-cli-writes-the-source-and-the-commit-pins-it.md)).
- **The sync puts the two rules into `@layer base`.** This option was selected.

## Consequences

- A rule outside of a layer still wins over the default theme. The themes of factory, text2sql and deepagents are outside of a layer, and they do not change.
- A host theme in `@layer base` wins when it comes after the import of the stylesheet. A host theme in `@layer theme` loses, because Tailwind CSS declares `theme` before `base`.
- The sync has one more step. The step changes only the `:root` rule and the `.dark` rule.
