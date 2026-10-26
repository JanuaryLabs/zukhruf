# A pre-push step builds the pushed commit in a snapshot, not the working tree

The repos of one developer copied their pre-push hooks by hand. A survey on 2026-10-26 found 13 `.husky/pre-push` files and one generator template that writes another. 12 of these places hold one piece of knowledge: build every project with the production configuration before a push. They are factory, text2sql, pm, impact-hub, iworked, gi-backend, thing, virtual-care, education, cold-ambulance, deepagents, and the template of factory. datahub also runs lint. The copies differ only in three ways: the targets (datahub: lint and build), the number of parallel tasks (4 copies use 1), and `NODE_ENV=production` (factory and text2sql). This is the third place and more, so by the Rule of Three the step goes into this package as `Build`, with those three options. The production configuration and `NX_DAEMON=false` are not options, because no copy differs there. sdk-it runs `nx affected -t test,build`, which is a different check in one place. It stays in sdk-it.

Each copy builds the working tree. ADR 0001 found that many sessions edit one working tree at the same time. Thus an edit that a peer did not commit can stop a good push, or let a broken push through. No copy reads the ref updates that git gives the hook (githooks(5)), so no copy knows which commits it judges. ADR 0001 applied to a push gives this rule: a pre-push step judges the pushed commits, never the working tree.

## Decision

`prePush(steps)` reads the remote from the arguments of the hook and one ref update from each line of the standard input: `<local ref> SP <local sha> SP <remote ref> SP <remote sha>` (githooks(5)). It runs the steps in order and stops the push at the first fail, as `preCommit` stops the commit. `Step` takes its subject as a type parameter, so the type checker stops a pre-commit step, such as `Format`, in `prePush`.

For an update, the base is the remote sha. For a create, the base is the parent of the first commit from `git rev-list <local sha> --topo-order --reverse --not --remotes=<remote>`. An update whose remote sha is not in the local object store, for example after a force push over commits that were never fetched, gets its base in the same way. The pre-commit framework finds the "from" ref of its pre-push stage with these rules. When `rev-list` gives no commit, the remote has the head already: the base is the head, and the range is empty. When the first commit has no parent, there is no base. `Build` builds only a head that has at least one commit that the remote does not have, and skips the others. A repo step sees the empty range.

`Build` builds each pushed commit in a snapshot:

1. **The files.** The hook writes the files of the commit into a temporary folder outside the repo. It reads them from the object store with `git ls-tree -r -z <sha>` and `git cat-file --batch`. No filter applies (no autocrlf, no smudge, no LFS), and `export-ignore` does not apply. A link in the commit becomes a junction when it points to a folder, or else a text file, as git does with `core.symlinks=false`.
2. **The packages.** The snapshot gets a `node_modules` that is a real folder: the root one, each `@scope` folder, and the `node_modules` of each workspace that the `workspaces` of the commit's `package.json` name. A link to a workspace package points to the same path in the snapshot. Each other entry is a link, with an absolute path, to the installed entry (a junction on Windows). The hook copies `.bin`: a link keeps its relative text, so it resolves through the snapshot, and a file is copied. Other dot entries, such as `.vite`, are not used. A `node_modules` of a workspace must be a real folder, because tools write there: vite wrote `.vite-temp` into it during the probe.
3. **Install drift.** The hook compares the `package-lock.json` of the commit with the hidden lockfile, `node_modules/.package-lock.json`, which npm writes on each install and which lists what is installed (npm docs, package-lock.json). Each difference in the third-party packages is drift: a missing package, a different version, or an extra package. An extra package is drift because code that imports it builds in the hook and fails in CI. Workspace links are not compared, because they point into the snapshot. With no drift, the snapshot uses the installed packages. With drift, the hook prints a line, and then installs the pushed lockfile in a folder of the state folder, with the hash of the lockfile as its name. The snapshot links to that install. The hook keeps the two installs that it used last. A repo with no `node_modules` has drift for each package. This is not an option.
   The install runs `npm ci --ignore-scripts`, and then `npm rebuild <names>` with only the third-party packages that the lockfile marks with `hasInstallScript`. `npm rebuild` runs the install scripts of these dependencies, which packages such as esbuild and prisma need. The lifecycle scripts of the repo and of its workspace packages, such as `prepare`, do not run. In the state folder they would act on the repo itself: a `git config` that runs inside the git folder writes the config of the repo. A probe on 2026-10-26 (npm 11.19.1) found that `npm rebuild` without names runs them: it ran the `postinstall` of the root and the `install` and `prepare` of a workspace package. With names, it ran only the install script of the named dependency. The lockfile marks the root and the workspace packages with `hasInstallScript` too, so the names come only from the entries in `node_modules`. `env` goes to nx only, because with `NODE_ENV=production` npm does not install the devDependencies.
   A commit without `package-lock.json` makes `Build` fail at once. All 12 copies use npm, so pnpm and yarn are out of scope.
4. **nx.** The hook runs `node_modules/.bin/nx` of the snapshot, with the snapshot as the current folder. It sets `GIT_DIR` to the git folder of the repo, `GIT_WORK_TREE` to the snapshot, and `GIT_INDEX_FILE` to a temporary index that it makes from the head. Thus the git commands of nx see a clean checkout of the head, with no changed and no untracked files, and `nx affected --base --head` works. `push.nx` uses the same environment. The nx cache and its workspace-data database are together in one folder of the state folder. nx exits with 130 when a task fails, so each exit code other than 0 is a fail. The fail shows up to 20 lines of the error output of each failed task. A push with more than one pushed commit gives one line for each pushed commit: built, skipped or failed.
5. **The state folder.** The hook keeps its state in `git-hooks` in `$(git rev-parse --git-common-dir)`. That folder is for one repo, it is outside the working tree, and linked worktrees use the same one. Git keeps its own state there too, such as `rr-cache` for rerere. A file lock in that folder lets one pre-push build run at a time in a repo. A second build waits for the lock and prints that it waits. A push does not fail because another push builds. The hook deletes each snapshot after its build.

## Evidence

A probe on deepagents (nx 23.2.1, npm workspaces) on 2026-10-26 proved the mechanism, and it wrote nothing in the repo:

- A marker that was only in the snapshot got into the built bundle. A type error that was only in the snapshot made the build fail.
- The setup took about 1 s: 0.23 to 0.36 s for 1571 files, and 0.35 to 0.67 s for the links.
- A cold build of 16 projects took 67.8 s. A second build in a new snapshot took 5.2 s, with 17 of 20 tasks from the cache. The 3 other tasks have no cache. The task hashes do not depend on the path of the snapshot.
- A cache folder without its workspace-data database gave 0 hits of 20. nx 23 keeps the index of the cache in that database.
- The cache of the working tree gave 1 hit of 20, because the edits of peers change the hashes. Also, nx would write the project graph of the snapshot into the workspace data of the working tree, which peer nx runs read.
- The installed packages matched the `package-lock.json` that a peer did not commit: 14 other versions, 1 missing package and 20 extra packages. The build of the commit failed with TS2307 for the missing package. This false fail is the reason for the install on drift.

## Considered Options

- **Keep the copies.** A fix in one copy does not get to the others, and each copy builds the working tree.
- **Build the working tree, as the copies do.** An edit that is not committed decides the outcome.
- **Stash the edits that are not committed, and build.** A stash changes the working tree of every session.
- **`git worktree add` for each push.** It adds an entry to the worktree list of the repo, which peers see, and a new worktree has no `node_modules`.
- **`git archive`.** It applies `export-ignore`, so the snapshot can miss files of the commit.
- **Link the whole `node_modules` folder.** vite writes into the nearest `node_modules`, so the build writes into the working tree. A workspace link resolves to the working tree, not to the snapshot.
- **Use the installed packages always.** Install drift gives false fails, as the probe found.
- **Run `npm ci` for each push.** Each push waits for a full install.
- **Install only on drift, and keep the last two installs.** This option was selected. A push with no drift stays fast. Ezz accepts the disk space of two installs.
- **Use the `.nx` cache of the working tree.** It gives almost no hits, and peer nx runs read the project graph that the snapshot writes there.

## Consequences

- A push with no drift adds about 1 s of setup to the build. The first push with a new lockfile waits for a full `npm ci`.
- The state folder holds up to two full installs and an nx cache for each repo.
- A file that is not in the commit is not in the snapshot: `.env` files and other ignored files. A build that needs one fails in the hook. Generated files and folders that a build writes come into the snapshot during the build.
- Install drift is found from npm's hidden lockfile, so `Build` supports npm workspaces only. A repo without `package-lock.json` sees the fail at its first push.
- An extra package that a peer installed but did not commit causes a full install at the next push.
- `Step` has a type parameter. Each pre-commit step is a `Step<Commit>`.
- On Windows, the snapshot uses junctions for links to folders and copies files, so it needs no administrator rights. The proof on Windows is not done yet. zukhruf #2753 tracks it, as for the other packages.
