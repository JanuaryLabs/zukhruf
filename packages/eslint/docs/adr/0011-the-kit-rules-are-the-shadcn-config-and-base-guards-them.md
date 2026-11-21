# The kit rules are the shadcn config, and base guards them

Amended on 2026-11-22 (#5085) for the disable: a host fixes each flagged line in code. It does not disable the rule on the line, also with a reason, and it adds no exception in its config. This is the owner's rule of 2026-11-01 (#3519, #3530): no `eslint-disable` directive, even one with a `-- reason`. See [The strict rules are opt-in](#the-strict-rules-are-opt-in).

Amended on 2026-11-20 (#5017): `no-data-slot-restyle` and the rules of `@shadcn/lint` are in the opt-in export `@zukhruf/eslint/shadcn-strict`, not in the `shadcn` config. See [The strict rules are opt-in](#the-strict-rules-are-opt-in).

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

## The strict rules are opt-in

`zukhruf/no-data-slot-restyle` and the six rules of `@shadcn/lint` (`no-restyle`, `no-arbitrary-values`, `no-raw-colors`, `no-unknown-classes`, `no-inline-styles`, `require-static-classes`) are in their own export, `@zukhruf/eslint/shadcn-strict`, and not in the `shadcn` config. At `error` in `shadcn`, a release would fail the lint of every host at once: on 2026-11-20 they reported 42 errors in Meddit, 124 in factory, about 430 in deepagents, 131 in sdk-it, 126 in theagentlab, 89 in zukhruf's diagram, and 3 in ui and diagram-playground. Ezz decided that a host spreads the export after `shadcn` once it has fixed its hits, so an update of the package fails no host. The `shadcn` config keeps `no-as-child`, `no-native-select`, `require-select-group`, `require-command-group` and the guard's setting. `no-data-slot-restyle` stays a rule of the plugin, and only `shadcn-strict` turns it on.

The rules stay strict: `no-inline-styles` and `no-unknown-classes` keep their defaults, `no-arbitrary-values` has no allow-list, and a host fixes each flagged line or disables the rule on it with a reason. `no-restyle` allows `layout` on every component, and `layout` and `spacing` on the kit's layout containers.

The set is an export, not a config of the plugin, for the same reason as `./react` and `./modern-node`: a plugin that only a subpath loads is an optional peer, so a host that does not opt in does not install `@shadcn/lint`. The export also sets `settings.shadcn`, which only `@shadcn/lint` reads.

- **A config `zukhruf/shadcn-strict` of the plugin.** The plugin would load `@shadcn/lint` for every host, so the peer could not be optional. This option was not selected.
- **The rules in `shadcn` at `warn`.** A warning does not fail lint, so a host could keep its hits, and the decision is to fix them. This option was not selected.
- **The rules in `shadcn` at `error`, released after every host is fixed.** The kit's hosts are in six repos with their own work, and one release would wait for all of them. This option was not selected.
