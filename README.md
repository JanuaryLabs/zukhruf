# zukhruf

زخرف. A workspace of small Node.js libraries.

## Packages

| Package                              | What it does                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| [`@zukhruf/mutex`](./packages/mutex) | A mutex with interchangeable lock stores, from one object to every process on a host, with fencing tokens on every lease. |

## Apps

| App                                         | What it does                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`reservation-app`](./apps/reservation-app) | An HTTP app that sells the last item once, with a fenced stock table. It uses `@zukhruf/mutex`. |

Each package has its own glossary. [CONTEXT-MAP.md](./CONTEXT-MAP.md) lists them.

## Development

You need Node.js 26.9 or later.

```sh
npm install
npx nx run-many -t test        # builds, then runs every test
npx nx run-many -t typecheck   # formats, lints, then type checks
npx nx run <project>:test      # one project, e.g. mutex
```

## Release

The packages tagged `scope:public` are released together with conventional commits.

```sh
npx nx release --skip-publish --dry-run   # shows the next version and changelog
npx nx release --skip-publish             # versions, commits, tags release/<version>
git push origin main --follow-tags
```

The `release/*` tag starts `.github/workflows/release.yml`, which publishes to npm.

No `release/*` tag exists before the first release, so Nx bumps the version in `package.json`. To publish that version as it is, give it explicitly:

```sh
npx nx release 0.1.0 --first-release --skip-publish
```
