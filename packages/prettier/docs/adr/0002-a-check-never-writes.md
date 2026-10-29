# A check target never writes

`lint` and `typecheck` are checks: they tell if the code is correct. In zukhruf, elt and context-compiler, `lint` depends on `format`, and `format` runs `prettier --write {projectRoot}`. In text2sql, `typecheck` depends on `format`. Thus a check writes files.

Command–query separation (Bertrand Meyer, _Object-Oriented Software Construction_) says that a query gives an answer and changes nothing. A check is a query. The user ruled on 2026-10-29 that checks are read-only (#3306). whatisgoingon `AGENTS.md:17` already says "Verification is non-mutating".

A check that writes caused these problems in a shared tree, where more than one session edits the same files:

- The old lint-staged hook ran `prettier --write` on the staged files and added them again. It put files of other sessions into commits. The sweep was reproduced 18 times in 18 runs. bb78175 fixed it: the hook only checks now.
- On 2026-10-29 two sessions had files in `packages/eslint` that they did not commit. `nx run eslint:typecheck` of either session runs `lint`, then `format`, which is `prettier --write packages/eslint`. That run would change the files of the other session.

All seven workspaces already check the format with no write: the `Format` step of `@zukhruf/git-hooks` checks the staged blobs with `prettier.check` (`packages/git-hooks/src/format.ts`). In zukhruf, factory and whatisgoingon, CI runs `npx prettier --check .`.

## Considered Options

- **Checks depend on `format`, as today.** REJECTED. A check writes, and in a shared tree it changes files that another session owns.
- **No `format` target.** REJECTED. A person needs one command that formats a project.
- **Two targets: `format` writes, `format:check` reads.** ACCEPTED. factory and whatisgoingon already use these two names.

## Consequences

`format:check` runs `prettier --check`, and it never writes. `typecheck` depends on it. `format` runs `prettier --write`, and no target depends on it, so it runs only when someone runs it on purpose. An agent formats only its own files, by path: `npx prettier --write <files>`. The `Format` step of `@zukhruf/git-hooks` already tells it this command.
