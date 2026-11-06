# A commit-msg step asks the parser of the repo's own nx

On 2026-11-06, the release of zukhruf stopped. Nx 23.2.1 reads a conventional-commit header with `/^(?<type>[^\s():!]+)(?:\s*\((?<scope>.+)\))?(?<breaking>!)?: (?<description>.+)$/u` (`parseConventionalCommitsMessage` in `nx/src/command-line/release/utils/git`). The scope group is greedy, so it ends at the last `): ` of the subject. The subject `fix(sqlite-changefeed): the watch … (3da09167, #3840): async …` gave a scope with the piece `#3840`, and minimatch read that piece as a comment: `Invalid glob pattern #3840`. The subject `feat(async)!: … (#3840, ADR 0007): …` lost its scope and its `!`, so a breaking change would have shipped as a patch. The subjects were reworded by hand. In the 300 commits before that day, 21 subjects of zukhruf had a later `(…): `. Nx 24.0.3 has the same parser.

Only the message of a commit can show this, so the check is a commit-msg hook (githooks(5)). The package had a pre-commit and a pre-push hook. `commitMsg(steps)` follows them: git gives the hook the file of the message, `CommitMessage` reads it, and each step is a `Step<CommitMessage>`, as ADR 0001 gives for the other hooks. Git gives the hook the message before its cleanup, so `CommitMessage` removes the comment lines with `git stripspace --strip-comments`, which uses the comment character of the repo's config. The subject is the first paragraph with its lines joined by spaces, because nx reads `%s` of `git log`, and git makes `%s` that way.

## Decision

`NxReleaseScope` gives the subject to the parser of the repo's own nx, and to a strict parse whose scope is the first parenthesis: `[^()]*` in place of `.+`. The commit stops when the two give another type, scope or `!`. A subject that neither parser reads as a header, such as that of a merge commit, passes.

## Considered Options

- **A copy of the regex of nx.** It is not exact for each repo: when nx changes its parser, the copy judges subjects that the nx of the repo reads correctly, or passes subjects that it reads wrongly.
- **Refuse each later `): ` in the subject.** `fix: the parser reads (a): b` has no scope, so nx reads it correctly. A rule on the text stops it; the comparison does not.
- **commitlint.** Its parser (`conventional-commits-parser`) is not the parser of nx release, so it does not see this failure.
- **Ask the parser of the repo's own nx.** This option was selected. nx exports `./src/*`, so the import is part of its package exports. nx is an optional peer dependency of this package, and the step imports it only when it runs, as `DependencyChecks` imports ESLint.

## Consequences

- A repo that adds `NxReleaseScope` needs `nx`. Without it, the import fails, and the commit stops with the error of Node.
- When a version of nx moves the parser, the import fails, and the commit stops. The step must then follow nx.
- `--no-verify` skips the hook, as it skips each hook.
