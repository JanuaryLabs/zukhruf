# A step reads the install of the working tree to stop links to another checkout

On 2026-11-22 the owner decided that our repos never use an unreleased package through `npm link` or through a link to another checkout. A consumer installs the published version. A push to the main branch of a package releases it, so the published version comes soon after the push.

A survey on 2026-11-22 found no link outside the repo to a `@zukhruf` or `@deepagents` package. context-compiler links 80 `@eltjs` packages to its elt checkout, and keeps them by the owner's choice. The workspace links of zukhruf (45) and deepagents (28) point inside each repo.

## Decision

`NoOutsideLinks` is a pre-commit step that runs at each commit. It reads two sources:

1. The staged `package-lock.json`. An entry with `"link": true` whose `resolved` starts with `..` or is absolute is a link outside the repo, as `npm link <folder>` writes it. npm also writes the folder itself as a key that starts with `..`, but only as the target of such a link: the lockfile of context-compiler has 80 such keys, and a link names each one. Thus the step reads the links, and names each package by the folder that `import` resolves.
2. The install in the working tree. A package in `node_modules` of the root or of a workspace (`<name>` and `@scope/<name>`) that is a link whose real path is outside the real path of the repo is a link outside the repo. A link that `ln -s` made is in no lockfile, so only the install shows it.

ADR 0001 says that a step never reads the working tree. No commit holds `node_modules`, so the install has no staged copy. `Commit.installRoot` names the folder where the repo installed its packages, and this step reads only `node_modules` there. A link to a folder that does not exist has no real path, so its text names the folder.

The option `allowed` takes globs of package names, such as `@eltjs/*`, for a repo that keeps a link by its own decision.

## Considered options

- **Read the install from a snapshot with packages.** The snapshot mirrors the install of the repo only when it matches the staged lockfile; else it installs the lockfile in the state folder, which shows no link that `ln -s` made. Rejected.
- **Stop an outside link in `linkPackages`, so a snapshot build never uses another checkout.** `linkPackages` does not know the `allowed` option of a repo, so context-compiler could not build a snapshot. The pre-commit step stops the link before a commit exists. Rejected.
- **Read the lockfile only when the commit changes it.** A link stays in the install after the commit that added it, and a link that `ln -s` made changes no file of the commit. The step reads both sources at each commit; it takes about 40 ms on zukhruf. Rejected.
