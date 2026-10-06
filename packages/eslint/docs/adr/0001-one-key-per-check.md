# One rule key for each check

The hand-written bans of each repo were entries of one rule, `no-restricted-syntax`. Flat config keeps one options list for each rule key. Any later config that sets the key replaces the whole list. In Limerence, Nx's React preset sets `no-restricted-syntax: ['warn', 'WithStatement']`, so 21 React projects lost every ban. `eslint --print-config` showed this, but no lint run reported it. The package makes each check a rule of its own (`zukhruf/no-enum`, `zukhruf/no-test-lifecycle-hooks`, …), built from its selectors by `selectorRule()`. Import bans are rules built by `importBanRule()`.

## Considered Options

- **Export the selector arrays, and let each repo spread them into its own `no-restricted-syntax`.** This is what the repos did. The repo must put the spread last, and nothing tells it when a preset comes later.
- **One rule with all the checks, switched by options.** Two configs that set the rule with different options still replace each other.

## Consequences

The package never sets `no-restricted-syntax`, `no-restricted-imports` or `@typescript-eslint/no-restricted-imports`. Those keys belong to the repo. A test fails if a shipped config sets one of them. A repo turns off one check by name, for example `'zukhruf/no-playwright-test': 'off'` for an end-to-end folder, and the other bans stay on.
