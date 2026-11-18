# Git hooks

Git hooks written in TypeScript. A pre-commit hook runs steps in order against the commit that git is about to make. A commit-msg hook runs steps in order against the message of that commit. A pre-push hook runs steps in order against the commits that git is about to send. A step reads a tree of the commit, never the working tree. A step runs its tools in a snapshot, with the tool environment. A pre-commit step stages only generated files.

## Language

**Hook**:
A program that git runs at one point of its work, for example before a commit or before a push. Here the hook is a TypeScript file, such as `.husky/pre-commit.ts`, and `.husky/pre-commit` is a link to it.
_Avoid_: Script, trigger

**Host**:
The one module that reads the process: `src/scripts/host.ts`. It reads the current folder, the arguments, the standard input and the hook environment. It builds the subject of the steps, prints their outcomes and sets the exit code. A step never reads the process and never gets an environment. The word comes from the island rules of `@zukhruf/eslint`: the host reads its environment and passes values in.
_Avoid_: Runner, entry, main

**Step**:
One check or one task that a hook runs. A step reads its subject and gives an outcome. The subject of a pre-commit step is the staged commit (`Step<Commit>`). The subject of a commit-msg step is the commit message (`Step<CommitMessage>`). The subject of a pre-push step is the push (`Step<Push>`). A repo adds a step of its own as a subclass of `Step`.
_Avoid_: Task, job, plugin

**Outcome**:
What a step gives: pass, skip, or fail. A fail stops the commit or the push and names the reason. A skip says why the step had nothing to do.
_Avoid_: Result, status

**Staged commit**:
The content that the next commit holds: the index that git gives the hook. `Commit` is its type in the code. Its tree is the staged tree, which `git write-tree` writes from a private copy of that index: `git write-tree` takes the lock of the index, and fails while another process holds it. When the index changes while the hook runs, and no step staged the change, the commit stops.
_Avoid_: Index (the word is correct, but it has other meanings), cache

**Commit message**:
The message of the commit that git is about to make, as git gives it to the commit-msg hook in a file, without the comment lines of the editor. Its subject is the first paragraph, with its lines joined by spaces, as `git log --format=%s` and nx release read it. Its trailers are the lines that `git interpret-trailers --parse` reads from its last paragraph. `CommitMessage` is its type in the code.
_Avoid_: Commit (that is the staged commit), header

**Tree**:
Git's tree object: the paths of a commit, with the mode and the content of each. It does not change. The staged tree is what `git write-tree` writes from the index of the hook. The tree of a pushed commit is `<sha>^{tree}`. `Tree` is its type in the code.
_Avoid_: Index (it can change while the hook runs), checkout, file list

**Tree entry**:
One path of a tree, with its kind: a file (also an executable file), a link, or a submodule. A tree lists no folders. The term is libgit2's (`git_tree_entry`).
_Avoid_: File (a link and a submodule are entries too), blob

**Diff entry**:
One path that differs between two trees, and how it differs: added, modified, deleted, or type-changed (for example, a file that became a link). A rename is a deleted entry and an added entry. The diff of a staged commit goes from the tree of `HEAD` to the staged tree. The diff of a ref update goes from the tree of its base to the tree of its head. A step that reads content skips the deleted entries. A step that decides whether to run counts them. The term is JGit's (`DiffEntry`).
_Avoid_: Staged file (a deleted path is not a file), change, delta

**Staged copy**:
The content of one file in the staged tree. It can differ from the file in the working tree when only some changes of the file are staged. A link has no staged copy in this sense: the tree holds the path that the link points to, so a step that reads content skips links.
_Avoid_: Blob (git's word for any stored content), version

**Working tree**:
The files on the disk. Other sessions can edit them at the same time as the hook runs, so a step never reads them and never writes them. The hook writes one file there only for a generated file, and only when the working-tree copy still equals the old staged copy. Else it leaves the copy and names it.
_Avoid_: Workspace, checkout

**Generated file**:
A file that the work of a step writes in a private snapshot of the staged commit, and that matches the globs of the step, such as a `tsconfig.json` that `nx sync` writes or the `openapi.json` of a build. `generate(globs, work)` stages it, deletions too. In a partial commit (`git commit --only`, `git commit <paths>`), the step fails and names the generated files.
_Avoid_: Artifact, output

**Synced file**:
A generated file that `nx sync` writes, such as a `tsconfig.json` with new project references. The globs of `Sync` name the files that the sync generators of the repo write.
_Avoid_: Generated file (that is the wider term)

**Push**:
What `git push` is about to send: the remote (its name and URL) and the ref updates. Git gives them to the pre-push hook as arguments and as lines on the standard input. `Push` is its type in the code.
_Avoid_: Upload, publish

**Ref update**:
One line that git gives to the pre-push hook: the local ref, the local sha, the remote ref and the remote sha. Its kind is create (the remote sha is all zeros), update, or delete (the local sha is all zeros). A create or an update has a head, the local sha, and a base, the newest commit that the remote has. For an update, the base is the remote sha. For a create, and for an update whose remote sha is not in the local repo, the base is the parent of the first commit that no ref of the remote has. When the remote has the head already, the base is the head, and the range is empty. When the remote has no commit of that history, there is no base.
_Avoid_: Branch (a ref can also be a tag), change

**Pushed commit**:
The commit that a ref update sends: its local sha. A pre-push step judges the pushed commits. A push that only deletes refs has no pushed commit. `Build` builds a pushed commit only when the remote does not have it.
_Avoid_: HEAD (the branch that is checked out, which a push can leave out), local commit

**Snapshot**:
One commit checked out in a temporary folder outside the repo, where a step runs its tools. It is a clone of the repo that shares its object store (`git clone --shared`). The snapshot of the staged commit checks out a commit that the hook writes from the staged tree with `git commit-tree`, with a fixed author, committer and date, so one tree and one parent give one commit; no ref holds that commit. Git in a snapshot sees a clean checkout of the commit. A snapshot has a `node_modules` only when a step asks for packages: its workspace packages resolve to the snapshot, and the other packages come from the install of the commit's lockfile. The steps that ask for the same tree share one snapshot, and do not change its files. A later ask for packages adds a `node_modules` to the same snapshot. The hook deletes each snapshot after the last step.
_Avoid_: Checkout, worktree (git's word for a working tree that git tracks), copy

**Hook environment**:
The environment that git gives the hook. It can hold the variables that tie git to the repo, such as `GIT_DIR` and `GIT_INDEX_FILE`. Only the git commands of the hook on the repo get it, so they read and write the index of the commit.
_Avoid_: Process environment, `process.env`

**Tool environment**:
The hook environment without each variable that `git rev-parse --local-env-vars` lists. Each tool gets it: nx, npm, ESLint, Prettier, a command of the repo, and git in a snapshot. In a snapshot it also holds `NX_DAEMON=false` and the nx cache of the state folder. Thus a tool that runs git in a folder of its own does not reach the repo. githooks(5) gives the rule. The term is a coinage of this package.
_Avoid_: Clean environment, isolated environment

**Install**:
A folder of the state folder that holds an `npm ci` of a commit: a copy of the full tree of the commit, without `.git` and `node_modules`, with the packages that its lockfile names. Its name is the sha256 of the lockfile and the `.npmrc` together, so two commits with the same lockfile and the same `.npmrc` use one install. The hook keeps the two installs that it used last.
_Avoid_: Cache, node_modules

**Install drift**:
The installed packages do not match the `package-lock.json` of the commit of a snapshot: a package that the lockfile names is missing or has a different version, or a package is installed that the lockfile does not name. Workspace links are not compared. The hook finds it from npm's hidden lockfile, `node_modules/.package-lock.json`. On install drift, the snapshot uses an install of the commit's lockfile in the state folder.
_Avoid_: Stale install, dependency mismatch

**State folder**:
The folder `git-hooks` in the common git folder of the repo (`git rev-parse --git-common-dir`). Both hooks keep the installs and the nx cache there. The pre-push hook holds `build.lock` there from its first snapshot to its end. A hook holds `installs.lock` while it installs or prunes. The folder is outside the working tree, and linked worktrees use the same one.
_Avoid_: Cache folder (it holds more than the nx cache), `.nx`
