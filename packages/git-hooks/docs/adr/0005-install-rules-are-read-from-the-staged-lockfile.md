# Two install rules of the monorepo standard are read from the staged lockfile

The monorepo standard (`packages/nx/README.md`, `## monorepo standard`) kept two install rules as prose, with no check (#4651):

1. Keep one copy of each shared runtime package, and run `npm ls <pkg>` after each generator. Two copies of `react` fail with "Invalid hook call", and tooling that pins `zod` 3 puts a second `zod` in a bundle.
2. Review each install script before you name it in `allowScripts`. Some scripts block only on Linux (`dtrace-provider` under `eas-cli`, `protobufjs`), so read the list from a Linux install too: `docker run node:lts-bookworm-slim … npm ci`.

A survey of the lockfiles of 32 repos on 2026-11-18 found both rules broken in many of them. 11 repos have more than one copy of `zod`, and 2 have two copies of `react` and `react-dom`. 17 repos have a package with an install script that `allowScripts` does not name, such as `fsevents` (`os: darwin`), `nice-napi` (`os: !win32`) and `protobufjs`.

## Decision

Both rules become pre-commit steps that read the staged `package-lock.json`, never `node_modules` and never a run of npm. A step reads a tree (ADR 0004), and the lockfile is the tree that `npm ci` installs, so the step is fast and needs no network.

### One copy of each runtime package

`OneRuntimeCopy` runs when the commit changes `package-lock.json`. It reads each third-party key of the lockfile's `packages`: `node_modules/<pkg>`, `node_modules/<a>/node_modules/<pkg>` and `packages/<w>/node_modules/<pkg>`. The folder name is the name that `import` resolves, so the step counts folders, not versions: two folders of the same version are two module instances too, and `npm ls` lists them too. A link (`link: true`) is a workspace or a `file:` dependency, not a copy. The commit stops when a named package has more than one folder, and the hook names each folder with its version.

The packages are `react`, `react-dom` and `zod` by default; the `packages` option replaces the list. The standard's own fix for tooling that pins an older major leaves a second copy: declare the runtime major at the root so npm hoists it, and npm nests the old one under the tool, such as `node_modules/@expo/cli/node_modules/zod` in whatisgoingon. That copy never reaches a bundle, so `allowed` names it by its lockfile folder, with the reason. An allowed folder that the lockfile no longer holds stops the commit too, so the list never outlives its reason.

The step counts what npm installs. Whether a bundle loads two copies is a question for the bundler; a copy under a tool is the one case the standard names, and `allowed` holds it.

### Each install script has a decision

`InstallScriptsReviewed` runs when the commit changes `package-lock.json` or the root `package.json`. npm's lockfile marks each package that has an install script with `hasInstallScript: true`, and it lists the packages of every platform, with their `os`, `cpu` and `libc`: a lockfile written on macOS holds `@esbuild/linux-x64`, and `fsevents` with `os: ["darwin"]`. npm 12 checks the policy only for the packages that the install meets: `collectUnreviewedScripts` (arborist `lib/unreviewed-scripts.js`) skips an inert node, one that fails its `os`, `cpu` or `libc` check (npm/cli#9562). That is why a script blocks only on Linux: macOS never meets it. The lockfile has no such filter, so the step reads every platform at once, and "read the list from a Linux install" needs no Linux install.

A package has a decision when a key of `allowScripts` in the root `package.json` names it: the bare name, or the name with exact versions joined by `||` that hold the locked version, as npm matches a key (arborist `lib/script-allowed.js`). Its name is the `name` of its entry for an alias, and else its folder name. npm reads the policy only from the root `package.json`; a workspace's `allowScripts` is ignored with a warning. The step skips a bundled package (`inBundle`), which npm skips too, because it never runs its scripts. It leaves a package from git or a tarball to npm's own check at install, because a key of its source names it, not its name: the step reads a `resolved` that is not a registry tarball as such a package, with the pattern of arborist `lib/install-scripts.js`. The commit stops with each package that has no decision, its folders, and the platform that each folder fits.

### What a commit cannot check

- **Whether an approved script works.** The step proves that each script has a decision, not that `true` is right. A script that fails on Linux fails `npm ci` there; the pre-push `Build` installs the commit on the machine that pushes, and the image build of the repo installs it on Linux. Reading a script before naming it stays a review.
- **A script the lockfile does not mark.** The step trusts `hasInstallScript`, which the registry gives for `preinstall`, `install`, `postinstall` and a `binding.gyp`. `prepare` runs only for a package from git or a folder, which the step skips. A lockfile that `npm install --os=… --cpu=…` wrote without the other platforms would hide their packages; npm writes every platform by default.
- **An `allow-scripts` list in `.npmrc`.** npm uses it only when `package.json` has no `allowScripts`. The standard writes `allowScripts` in `package.json`, so the step reads only that.

## Considered options

- **Run `npm ls <pkg>` in the snapshot.** It needs an install of the commit, which costs minutes on a new lockfile, and it reads the same tree that the lockfile describes. Rejected.
- **A CI job that runs `npm ci` in `node:lts-bookworm-slim`.** It meets only the Linux packages, after the push, and it needs an image pull. The lockfile holds the answer for every platform at commit time. Rejected.
- **Count versions, not folders.** The mutex lockfile holds `zod` 4.6.7 in five nested folders under a hoisted `zod` 3. Each folder is its own instance, so counting versions would report two where npm installs six. Rejected.
- **An exception keyed by the parent package, such as `@expo/cli`.** It would also allow a copy that a later version of the parent bundles under another folder. The folder is exact, and it goes stale on its own. Rejected.
