# A hook reads the staged commit, and stages only the files that its steps wrote

The repos of one developer copied their pre-commit hooks by hand. A survey of 54 repos on 2026-10-23 found these copies:

- 14 repos ran lint-staged with `prettier --write`.
- 4 repos ran `nx sync` and then staged the files that changed: zukhruf, factory, text2sql and cold-ambulance.
- 2 repos checked the staged copy of each file with Prettier and changed nothing: zukhruf and elt.
- 6 repos built an OpenAPI spec and its SDK client, and then staged them.

The copies already went apart. zukhruf staged only `tsconfig*.json` after `nx sync`; the other three staged each file that changed. elt kept a list of file extensions; zukhruf asked Prettier which files it formats. zukhruf read a staged copy with the default buffer of Node, so a file larger than 1 MiB stopped its hook. cold-ambulance looked for a project name in the raw JSON of `nx show projects`, so its codegen did not run.

This project follows the Rule of Three, as Fowler gives it in _Refactoring_: "The third time you do something similar, you refactor." Each kind of step has two places or more, and the hooks have more than three places. Thus the steps are in this package, and the repos use it.

Many sessions edit one working tree at the same time. lint-staged formatted the files, and then staged each file whose working-tree copy changed while it ran. In zukhruf, that took a file that another session saved at that moment, so the commit held a file that it did not name. A step that only reads cannot do this. Thus the rules of this package are:

- A step reads the staged copy of a file, never the working-tree copy. A file that is partly staged is judged as the commit holds it.
- A step stages only the files that it wrote: the files that `nx sync` changed during the run and that match the names that the sync generators write, or the declared outputs of a build. A file that was changed before the run is not staged.
- The format step checks and changes nothing. The commit stops and names each file that is not formatted.

## Considered Options

- **Keep the copies.** A fix in one copy does not get to the others. The buffer and the JSON defects show that this already happened.
- **lint-staged.** It formats and stages from the working tree, which is the cause of the problem above.
- **git-format-staged.** Its `--no-write` mode checks each staged copy with a command, but it starts Prettier once for each file (about 1 s each), and it cannot run `nx sync` or a build.
- **One command with flags in each hook.** A misspelt flag is found only when the hook runs, and a repo cannot add a check of its own.
- **The hook is a TypeScript file, and each step is a subclass of `Step`.** This option was selected. The steps of a hook have types, and a repo adds a step of its own as a class. `.husky/pre-commit` is a link to `.husky/pre-commit.ts`, because git runs the hook by that name, and Node runs a TypeScript file only when its name ends in `.ts`.

## Consequences

- A repo sets `core.hooksPath` to `.husky` in its `prepare` script. Husky does not run this hook, because Husky 9 runs each hook through `sh`.
- A repo that formatted its files at each commit now gets a stopped commit and a list of files. The author formats them, stages them, and commits again.
- A generated file must be formatted, or `.prettierignore` must name it, because lint-staged no longer formats it.
- `preCommit` is the one module that prints and reads the environment. The steps return an outcome, and `Commit` takes the environment as a parameter.
- Prettier is a peer dependency, so the hook uses the Prettier of the repo, with its plugins and its config.
