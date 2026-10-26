# Git hooks

Git hooks written in TypeScript. A pre-commit hook runs steps in order against the commit that git is about to make. A pre-push hook runs steps in order against the commits that git is about to send. A step reads the commit, never the working tree. A pre-commit step stages only the files that it wrote itself.

## Language

**Hook**:
A program that git runs at one point of its work, for example before a commit or before a push. Here the hook is a TypeScript file, such as `.husky/pre-commit.ts`, and `.husky/pre-commit` is a link to it.
_Avoid_: Script, trigger

**Step**:
One check or one task that a hook runs. A step reads its subject and gives an outcome. The subject of a pre-commit step is the staged commit (`Step<Commit>`). The subject of a pre-push step is the push (`Step<Push>`). A repo adds a step of its own as a subclass of `Step`.
_Avoid_: Task, job, plugin

**Outcome**:
What a step gives: pass, skip, or fail. A fail stops the commit or the push and names the reason. A skip says why the step had nothing to do.
_Avoid_: Result, status

**Staged commit**:
The content that the next commit holds: the index of the repo. `Commit` is its object in the code.
_Avoid_: Index (the word is correct, but it has other meanings), cache

**Staged copy**:
The content of one file in the staged commit. It can differ from the file in the working tree when only some changes of the file are staged. A link has no staged copy in this sense: the staged commit holds the path that the link points to, so a step that reads content skips links.
_Avoid_: Blob (git's word for any stored content), version

**Working tree**:
The files on the disk. Other sessions can edit them at the same time as the hook runs, so a step never reads them to judge a commit and never writes them.
_Avoid_: Workspace, checkout

**Synced file**:
A file that `nx sync` wrote during the hook, such as a `tsconfig.json` with new project references. The sync step stages a synced file only when it matches the file names that the sync generators of the repo write.
_Avoid_: Generated file (that is the next term)

**Generated file**:
A file that a build writes from other files, such as `openapi.json` and the SDK client. The codegen step builds it when nx says that the projects it depends on are affected by the staged commit, and stages it.
_Avoid_: Synced file, artifact

**Push**:
What `git push` is about to send: the remote (its name and URL) and the ref updates. Git gives them to the pre-push hook as arguments and as lines on the standard input. `Push` is its object in the code.
_Avoid_: Upload, publish

**Ref update**:
One line that git gives to the pre-push hook: the local ref, the local sha, the remote ref and the remote sha. Its kind is create (the remote sha is all zeros), update, or delete (the local sha is all zeros). A create or an update has a head, the local sha, and a base, the newest commit that the remote has. For an update, the base is the remote sha. For a create, and for an update whose remote sha is not in the local repo, the base is the parent of the first commit that no ref of the remote has. When the remote has the head already, the base is the head, and the range is empty. When the remote has no commit of that history, there is no base.
_Avoid_: Branch (a ref can also be a tag), change

**Pushed commit**:
The commit that a ref update sends: its local sha. A pre-push step judges the pushed commits. A push that only deletes refs has no pushed commit. `Build` builds a pushed commit only when the remote does not have it.
_Avoid_: HEAD (the branch that is checked out, which a push can leave out), local commit

**Snapshot**:
The files of one commit in a temporary folder outside the repo. The snapshot of the staged commit (`Commit.inSnapshot`) holds only the files. The snapshot of a pushed commit (`Push.inSnapshot`) is a clone of the repo that shares its object store, with the files of the pushed commit. It also has a `node_modules` that the build can use: its workspace packages resolve to the snapshot, and the other packages are the installed packages. Git commands that nx runs in it see a clean checkout of the pushed commit. nx and its tasks get none of the variables that tie git to the repo, such as `GIT_DIR`. The hook deletes a snapshot after use.
_Avoid_: Checkout, worktree (git's word for a working tree that git tracks), copy

**Install drift**:
The installed packages do not match the `package-lock.json` of a pushed commit: a package that the lockfile names is missing or has a different version, or a package is installed that the lockfile does not name. Workspace links are not compared. The hook finds it from npm's hidden lockfile, `node_modules/.package-lock.json`. On install drift, the build uses an install of the pushed lockfile in the state folder.
_Avoid_: Stale install, dependency mismatch

**State folder**:
The folder `git-hooks` in the common git folder of the repo (`git rev-parse --git-common-dir`). The pre-push hook keeps its installs, its nx cache and its lock there. It is outside the working tree, and linked worktrees use the same one.
_Avoid_: Cache folder (it holds more than the nx cache), `.nx`
