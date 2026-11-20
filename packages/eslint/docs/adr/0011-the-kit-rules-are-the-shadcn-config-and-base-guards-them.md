# The kit rules are the shadcn config, and base guards them

The package had two things named react. `@zukhruf/eslint/react` gives the configs of the React community. The config `zukhruf/react` turned on the rules of the package for `@zukhruf/shadcn`: `no-as-child`, `no-native-select`, `require-select-group`, `require-command-group` and `no-data-slot-restyle`. Meddit's web app spread `@zukhruf/eslint/react` and took React as covered, so no kit rule ran on it. The config is now `zukhruf/shadcn`, named for what it checks, and `base` reports a file that imports the kit when the config is missing (#4990).

## The rename

`zukhruf.configs['shadcn']` and `extends: ['zukhruf/shadcn']` give the config. The rule ids do not change: a rule id belongs to the check, not to the config (ADR 0001), so a repo's `'zukhruf/no-as-child': 'off'` still works. The rules stay in `src/react`. A concept's folder does not carry its config's name: the `env` config is in `src/environment`, and `tests` is in `src/test-files`.

`react` stays for one release, as a getter on `configs` that returns the same array as `shadcn`. Each read emits a `DeprecationWarning` with the code `ZUKHRUF_ESLINT_REACT_CONFIG`, so a host sees the new name on its next lint run. The getter is not enumerable, so the plugin lists each config once, and the test that each package rule has exactly one config still holds. ESLint gives a rule a `meta.deprecated`, but it has no field for a deprecated config, so the warning is the only signal it can show.

## The guard

The `shadcn` config sets `settings.zukhruf.shadcn: true`, in its first block, which has no `files`. ESLint merges `settings` across the configs of a file, so the setting is in each file that the config covers, a `.ts` file too, and in no other file. A repo that scopes the config with `files` gets the guard on the files outside that scope. `zukhruf/require-shadcn-config`, a rule of `base`, reports each `import … from '@zukhruf/shadcn'` in a file without the setting. Its message names `zukhruf.configs['shadcn']` and `extends: ['zukhruf/shadcn']`.

The setting is under `zukhruf`, not a top-level `shadcn` key, because the config writes it, and the key of another plugin cannot collide with it. A repo setting such as `settings.env.startupFile` is a fact that the repo gives. This setting is a fact that the config gives.

Over each git-tracked `.tsx` that imports `@zukhruf/shadcn` in meddit, factory, deepagents, sdk-it, theagentlab and zukhruf (113 files; whatisgoingon has none), each with its own config and the `react` alias, the guard reported no file. Meddit's web app with the community configs and the root config only, as it was before it added the kit config, had all 23 of its kit files reported.

## Considered Options

- **Keep the name `react`, and document the difference.** The README already said that `@zukhruf/eslint/react` has no rule of the package, and Meddit still missed the config. This option was not selected.
- **Put the kit rules into `@zukhruf/eslint/react`.** That export gives only the configs of the React community, and a React project without the kit would get rules about a kit it does not use. This option was not selected.
- **Turn the kit rules on in `base` for every `.tsx`.** `no-as-child` and `no-native-select` report a prop and an element with no kit import, such as the `asChild` of Radix and a plain `<select>`, so a React project without the kit would get them too. This option was not selected.
- **A rename with no alias.** Each repo that uses `react`, zukhruf's own root config among them, would fail to load its config on the next upgrade. This option was not selected.

## Consequences

- Each host switches `zukhruf.configs['react']` or `extends: ['zukhruf/react']` to `shadcn` in its own change, before the release that removes the alias.
- A host that imports the kit and has no `shadcn` config fails `base`'s lint, with the config to add in the message.
- A repo that sets `settings.zukhruf.shadcn` by hand silences the guard and gets no kit rule. No check stops this.
