# @zukhruf/git-hooks

Git hooks written in TypeScript. A pre-commit hook runs steps in order against the staged commit. The steps check the staged copy of each file with Prettier and change nothing, run `nx sync` and stage only the files that sync wrote, and build generated files when nx says that their projects are affected. A pre-push hook runs steps in order against the push. Its build step builds each pushed commit in a snapshot, never the working tree. A repo adds a step of its own as a class.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Install the hook

Add the package and the repo's own Prettier:

```sh
npm install --save-dev @zukhruf/git-hooks prettier
```

Write the hook in `.husky/pre-commit.ts`, and make it executable:

```ts
#!/usr/bin/env node
import { Format, preCommit } from '@zukhruf/git-hooks';

await preCommit([new Format()]);
```

Git runs a hook by its name, and Node runs a TypeScript file only when its name ends in `.ts`. So `.husky/pre-commit` is a link to the TypeScript file. Commit the link:

```sh
chmod +x .husky/pre-commit.ts
ln -s pre-commit.ts .husky/pre-commit
```

The hook uses `await` at the top level, so Node must read it as a module. When `package.json` has no `"type": "module"`, name the file `pre-commit.mts`, and link `.husky/pre-commit` to that name.

Tell git where the hooks are, in the `prepare` script of `package.json`:

```json
{ "scripts": { "prepare": "git config core.hooksPath .husky || exit 0" } }
```

## Check the format of the staged files

`Format` checks the staged copy of each staged file with the Prettier config of the repo. It skips the files that `.prettierignore` names, the files that Prettier has no parser for, and links, because the staged copy of a link is the path that it points to. When a file is not formatted, or Prettier cannot parse it, the commit stops and the hook names each file:

```text
format    2 staged files are not formatted:
            src/app.ts
            docs/notes.md (SyntaxError: Unexpected token (3:1))
          Run `npx prettier --write src/app.ts docs/notes.md`, stage them, and commit again.
✖ commit stopped by the pre-commit hook
```

The step changes no file and stages nothing. A file that is partly staged is judged as the commit holds it.

## Stage the files that nx sync writes

`Sync` runs `nx sync` and stages the files that it changed. The option `stage` names the files that the sync generators of the repo write. The default is `**/tsconfig*.json`. A repo with the Tailwind sync generator adds its style sheets:

```ts
import { Format, Sync, preCommit } from '@zukhruf/git-hooks';

await preCommit([
  new Sync({ stage: ['**/tsconfig*.json', '**/styles.css'] }),
  new Format(),
]);
```

The step does not stage a file that was changed before the hook ran, or a changed file that `stage` does not name: another session can edit the same working tree. When `nx sync` fails, the commit stops, and the hook shows the reason that nx gave.

## Build generated files

`Codegen` runs nx targets that write generated files, and stages those files. With `when`, it builds only when nx says that the staged files affect one of those projects:

```ts
import { Codegen, Format, Sync, preCommit } from '@zukhruf/git-hooks';

await preCommit([
  new Sync(),
  new Codegen({
    when: ['backend', 'frontend'],
    run: ['backend:build', 'frontend:build'],
    stage: ['openapi.json', 'packages/client/src'],
  }),
  new Format(),
]);
```

The targets run in the order that `run` gives. When a target fails, the commit stops, and the hook shows the reason that the target gave. Put `Format` after `Codegen`, so that the generated files are checked too. nx and its tasks get none of the variables that tie git to one repo (see [Where a pre-push build runs](#where-a-pre-push-build-runs)), so a target that runs git in a folder of its own does not change the repo. The hook's own git commands keep these variables, so they read and write the index of the commit.

## Add a step of your own

A pre-commit step is a subclass of `Step<Commit>`. It names itself and gives an outcome: `this.pass()`, `this.skip(why)` or `this.fail(why)`. A fail stops the commit. `Commit` reads the staged commit: `staged()`, `files()` (the staged paths that hold file content, without links and submodules), `blob(path)`, `touches(globs)`, and `inSnapshot(work)`, which runs `work` on a copy of the staged tree in a temporary folder:

```ts
import { type Commit, Step } from '@zukhruf/git-hooks';

export class DesignCheck extends Step<Commit> {
  readonly name = 'design';

  async run(commit: Commit) {
    if (!(await commit.touches(['DESIGN.md', 'apps/**/*.css'])))
      return this.skip('no design files staged');
    const valid = await commit.inSnapshot((folder) => checkDesign(folder));
    return valid
      ? this.pass()
      : this.fail('DESIGN.md disagrees with the styles');
  }
}
```

## Install the pre-push hook

Git runs the pre-push hook before `git push` sends commits to a remote. Write the hook in `.husky/pre-push.ts`:

```ts
#!/usr/bin/env node
import { Build, prePush } from '@zukhruf/git-hooks';

await prePush([new Build()]);
```

Make it executable, and commit a link to it, as for the pre-commit hook:

```sh
chmod +x .husky/pre-push.ts
ln -s pre-push.ts .husky/pre-push
```

The hook uses `await` at the top level, so Node must read it as a module. When `package.json` has no `"type": "module"`, name the file `pre-push.mts`, and link to that name. The `prepare` script in [Install the hook](#install-the-hook) tells git where both hooks are.

Git gives the hook the name and the URL of the remote, and one line for each ref that the push changes. `prePush` reads them into a `Push`. It runs the steps in order and prints the outcome of each step. At the first fail, the push stops.

## Build the pushed commits

`Build` builds each pushed commit with the production configuration of nx. It does not build the working tree. Another session can edit the working tree while you push. An edit that is not committed is not in the push, so it cannot stop a good push, and it cannot hide a broken one.

```ts
import { Build, prePush } from '@zukhruf/git-hooks';

await prePush([
  new Build({
    targets: ['lint', 'build'],
    parallel: 1,
    env: { NODE_ENV: 'production' },
  }),
]);
```

- `targets` are the nx targets to run on all projects. The default is `['build']`.
- `parallel` is the number of tasks that nx runs at the same time. Without it, nx uses its own default.
- `env` holds more environment variables for nx.

Build runs `nx run-many` with `--configuration=production` and with `NX_DAEMON=false`. `env` goes to nx only, never to `npm ci`: with `NODE_ENV=production`, npm does not install the devDependencies. Build builds each pushed commit one time, also when the push sends it to more than one ref. Build gives one line for each pushed commit: built, skipped or failed. Each line names the commit:

```text
build     a1b2c3d: built 19 projects, 17 of 20 tasks from cache
          d4e5f6a: built 19 projects, 20 of 20 tasks from cache
          skipped: the remote already has 0b1c2d3
```

When a task fails, the push stops. The hook names the failed tasks and shows up to 20 lines of the error output of each failed task. When the output has more lines, the last line gives their number, such as `… 12 more lines`:

```text
build     a1b2c3d: 1 of 20 tasks failed: elements:build
            packages/elements/src/lib/define.ts(34,14): error TS2322: Type 'string' is not assignable to type 'number'.
✖ push stopped by the pre-push hook
```

A push that only deletes refs has no commit to build:

```text
build     skipped: the push only deletes refs
```

Build builds a pushed commit only when the push sends at least one commit that the remote does not have. A push of a commit that the remote has already, for example to a new branch, has nothing new to build:

```text
build     skipped: the remote already has a1b2c3d
```

Build works with npm workspaces. A pushed commit without `package-lock.json` stops the push at once. This is a setup error, so the first push shows it:

```text
build     a1b2c3d has no package-lock.json; Build works with npm workspaces
✖ push stopped by the pre-push hook
```

In one repo, one pre-push build runs at a time. A second push waits for the first build to end, and does not fail:

```text
build     waiting for another pre-push build in this repo
```

## Where a pre-push build runs

Each pushed commit is built in a snapshot: a clone of the repo in a temporary folder outside the repo, with the files of that commit. The hook makes the clone with `git clone --shared --no-checkout`, and then runs `git checkout --detach <sha>` in it. The clone shares the object store of the repo through `objects/info/alternates`, so git copies no objects. The snapshot holds what the commit holds, and nothing that is only in the working tree. A file that `.gitignore` names, such as `.env`, is not in the snapshot. Git writes the files of the commit as in each checkout: it makes the links and the executable files, and it applies `.gitattributes` and the filters of your git config.

nx runs in the snapshot, and git commands in nx work there. The snapshot is a repo of its own, so git sees a clean checkout of the pushed commit, with no changed and no untracked files. `nx affected --base --head` works, because git finds the base commit through the shared object store.

nx and its tasks get none of the variables that tie git to one repo, such as `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`. The hook removes each variable that `git rev-parse --local-env-vars` lists. Git removes the same list when it runs a command in another repo, such as a submodule. Thus a task that runs `git init` in a temporary folder of its own makes a repo in that folder, and does not change the repo that pushes. Before 0.3.43, the hook gave nx these variables. In sdk-it, a test ran `git init` in a temporary folder, and git wrote `core.worktree` into the config of the real repo. The snapshot was then deleted, so each git command in the repo failed.

The snapshot uses the packages that the repo installed when they match the `package-lock.json` of the commit. Then the setup takes about 1 s. A workspace package resolves to its folder in the snapshot, not in the working tree.

When the installed packages do not match the `package-lock.json` of the commit, the hook installs that lockfile in a folder of its own, and the snapshot uses that install. This is install drift: a package that the lockfile names is missing or has a different version, or a package is installed that the lockfile does not name. An extra package is drift too, because code that imports it builds here and fails in CI. Install drift occurs when a peer changed the dependencies but did not commit the change, or when the push sends a commit with other dependencies. The hook prints a line before the install, because a full install takes some time:

```text
build     a1b2c3d: the installed packages differ from package-lock.json; installing it with npm ci (first time for this lockfile)
```

The install runs `npm ci --ignore-scripts`, and then `npm rebuild` with the names of the dependencies that have install scripts. The lockfile marks these dependencies with `hasInstallScript`. Thus the install scripts of the dependencies run, such as those of esbuild and prisma. With npm 12, only the install scripts that the `allowScripts` of the repo's `package.json` approves run, as in the repo's own `npm install`. To approve a dependency, run `npm install-scripts approve <name>`. The scripts of the repo and of its workspace packages, such as `prepare`, do not run. The first push with a new lockfile waits for a full install. The next pushes with that lockfile use the same install. The hook keeps the two installs that it used last. A repo with no `node_modules` gets its install the same way.

The hook keeps the installs and the nx cache of the pre-push builds in its state folder: `git-hooks` in the common git folder of the repo (`git rev-parse --git-common-dir`). Linked worktrees use the same state folder. The nx cache of the working tree (`.nx`) is not used, and the hook does not write to it. A file lock in the state folder lets one pre-push build run at a time. The hook deletes each snapshot after its build.

On Windows, the snapshot links to folders with junctions, which need no administrator rights.

## Add a pre-push step of your own

A pre-push step is a subclass of `Step<Push>`. A step of `Step<Commit>`, such as `Format`, cannot go into `prePush`: at push time there is no staged commit.

`Push` has the `remote` (`name` and `url`) and the `updates`. Each ref update has `localRef`, `localSha`, `remoteRef`, `remoteSha` and a `kind`:

- `create`: the remote does not have the ref.
- `update`: the remote has the ref, and the push changes it.
- `delete`: the push deletes the ref from the remote.

A create or an update also has a `head` and a `base`. The `head` is the local commit. The `base` is the newest commit that the remote has:

- For an update, the `base` is the remote sha.
- For a create, the `base` is the parent of the first commit that no ref of the remote has. An update gets its `base` in the same way when the remote sha is not in the local repo, for example in a force push over commits that were never fetched.
- When the remote has the `head` already, the `base` is the `head`, and the range is empty.
- When the remote has no commit of that history, there is no `base`, and the step must check the whole history.

`push.inSnapshot(sha, work)` runs `work` on the snapshot of one commit. `work` gets the folder of the snapshot and an environment for the tools that it runs there: the environment of the hook without the variables that tie git to one repo, `NX_DAEMON=false`, and the nx cache of the state folder. `push.nx(sha, ...args)` runs nx in the snapshot of one commit, with that environment, and gives its standard output. When nx exits with a code other than 0, it throws.

This step runs the tests of the projects that each pushed range affects:

```ts
import { type Push, Step } from '@zukhruf/git-hooks';

export class AffectedTest extends Step<Push> {
  readonly name = 'test';

  async run(push: Push) {
    const updates = push.updates.filter((update) => update.kind !== 'delete');
    if (updates.length === 0) return this.skip('the push only deletes refs');
    try {
      for (const { base, head } of updates)
        await push.nx(
          head,
          ...(base === undefined
            ? ['run-many', '-t', 'test']
            : ['affected', '-t', 'test', `--base=${base}`, `--head=${head}`]),
        );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return this.fail(error.message.trimEnd());
    }
    return this.pass();
  }
}
```

Use the `base` and the `head` of each update, not `--base=origin/main --head=HEAD`. That pair checks the branch that is checked out, and a push can send other refs.
