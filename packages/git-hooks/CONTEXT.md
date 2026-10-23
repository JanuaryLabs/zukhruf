# Git hooks

Git hooks written in TypeScript. A hook runs steps in order against the commit that git is about to make. A step reads the staged copy of each file, never the working tree, and stages only the files that it wrote itself.

## Language

**Hook**:
A program that git runs at one point of its work, for example before a commit. Here the hook is a TypeScript file, `.husky/pre-commit.ts`, and `.husky/pre-commit` is a link to it.
_Avoid_: Script, trigger

**Step**:
One check or one task that a hook runs. A step reads the staged commit and gives an outcome. A repo adds a step of its own as a subclass of `Step`.
_Avoid_: Task, job, plugin

**Outcome**:
What a step gives: pass, skip, or fail. A fail stops the commit and names the reason. A skip says why the step had nothing to do.
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
