# zukhruf

## A commit is a release

The next push from any session sends every local commit to `main`, and a green CI run on `main` releases it. The hooks prove most of a commit: the pre-commit hook runs `nx sync`, checks the format of the staged files, and checks that `package-lock.json` records each staged `package.json` (`LockfileSync`), and the pre-push hook runs lint, typecheck and build on each pushed commit in a snapshot. No hook runs this gate yet, so run it before the commit:

- `npx nx affected -t test --base=$(git describe --tags --abbrev=0 --match 'release/*') --head=HEAD`. CI compares with the same tag.

A commit that changes only Markdown files needs no gate. No test reads a document of this repository, so a change to a document cannot change the result of a test. The pre-commit hook checks the format and the README table of the commit. When the commit changes a copy ledger (`docs/copied-*.md`), run `npx nx run copy-check:check`: only CI runs that check. If a test starts to read a document, a change to that document needs the test gate again.

A project tagged `platform:darwin` runs its targets on a macOS runner in CI ([root ADR 0005](docs/adr/0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)). On this Mac, its tests run here like the others.

## Docs

Write the docs of a package as [docs/writing-package-docs.md](docs/writing-package-docs.md) says.
