# Option factories add a repo's entries to the shared options

A repo that sets a rule again replaces all the options that an earlier config gave it. In Limerence, 27 projects set `@nx/dependency-checks` with only their own `ignoredFiles`. The rule's defaults filled in the rest: obsolete dependencies were checked, and test files counted as shipped code. The `base` config has the same risk. For example, `functional/no-let` with only `ignoreIdentifierPattern` drops `allowInFunctions`, and every `let` in a function becomes an error.

The package exports a factory for each rule whose options a repo extends: `noLet()`, `noFloatingPromises()`, `noUnassignedImport()`, `dependencyPolicy()` and `moduleBoundaries()`. Each factory returns the complete options and adds the repo's entries to the shared ones. The configs use the same factories, so there is one source for the shared options.

## Considered Options

- **Document the defaults, and let each repo copy them.** This is the copying that the package replaces.
- **A rule wrapper that merges options at lint time.** Flat config gives the rule only the last options, so there is nothing to merge with.

## Consequences

A repo writes `['error', noLet({ ignoreIdentifierPattern: [...] })]` instead of the raw options. A rule with no shared options gets no factory. Since 2026-11-01, `base` allows the side-effect imports that the monorepo standard defines (`**/*.css`, `**/env.ts`, `**/startup.ts`). Thus `import-x/no-unassigned-import` has shared options, and a repo adds its own entries with `noUnassignedImport()`.
