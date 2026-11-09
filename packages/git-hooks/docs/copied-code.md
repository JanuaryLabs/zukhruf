# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## Test helpers in more than two places

The Rule of Three asks to move these helpers into `src/testing` (backlog #4082). `src/testing/pre-commit-repository.ts` already holds one of them.

**`repository` of a pre-push hook.** Three places.

- Places: `src/build.test.ts`, `src/push.test.ts` and `src/install-drift.test.ts`.
- Same: a git repo in a temp folder with a hook at `.husky/pre-push.ts`, a link to it, and a bare remote `origin`. git, npm and the hook see none of the config of the user.

**`repository` of a pre-commit hook.** Two places.

- Places: `src/codegen.test.ts` and `src/testing/pre-commit-repository.ts`.
- Same: a git repo in a temp folder with a hook at `.husky/pre-commit.ts`, and a link to it.

**The run of a git command that a hook can refuse.** Three places.

- Places: `src/codegen.test.ts`, `src/push.test.ts` and `src/testing/pre-commit-repository.ts`.
- Same: the command runs with the environment of the repo. A failure gives its exit code and its output, and each other error stays an error.
- Differs: the command: a commit or a push.

## In two places

**The packages of a probe workspace (test helper).**

- Places: `src/build.test.ts` and `src/push.test.ts`.
- Same: each package gets a link in `node_modules/@probe`, and the repo gets a link to the `nx` of this workspace.
