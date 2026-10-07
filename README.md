# zukhruf

زخرف. A workspace of small Node.js libraries.

## Packages

| Package                                  | What it does                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@zukhruf/mutex`](./packages/mutex)     | A mutex with interchangeable lock stores, from one object to every process on a host, with fencing tokens on every lease.                                                                          |
| [`@zukhruf/eslint`](./packages/eslint)   | Shared ESLint rules and configs. Each check is its own named rule, so a repo's config cannot silently erase it. This workspace lints itself with it.                                               |
| [`@zukhruf/testing`](./packages/testing) | Disposable fixtures for integration tests: Docker containers and database servers, SQLite and DuckDB databases, HTTP servers and streams. A supervisor removes what a killed test run left behind. |

## Apps

| App                                         | What it does                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`reservation-app`](./apps/reservation-app) | An HTTP app that sells the last item once, with a fenced stock table. It uses `@zukhruf/mutex`. |

Each package has its own glossary. [CONTEXT-MAP.md](./CONTEXT-MAP.md) lists them.

## Development

```sh
npm install
npx nx run-many -t test        # builds, then runs every test
npx nx run-many -t typecheck   # formats, lints, then type checks
npx nx run <project>:test      # one project, e.g. mutex
```

## Release

Releases need no command. The packages tagged `scope:public` are released together, as their conventional commits on `main` ask: a `feat`, `fix` or `refactor` bumps the patch version while the major version is 0, and `chore`, `docs`, `test` and `ci` release nothing.

When CI is green for a push to `main`, `.github/workflows/release.yml` runs `nx release version`, which versions the packages, commits `chore(release): publish <version>`, tags `release/<version>` and pushes both, and then `nx release publish`, which publishes to npm. Nothing reaches npm unless `main` has its release commit and tag, and a version already on npm is skipped. A push with nothing to release changes nothing. The release runs only for the commit CI tested; when `main` has moved on, the newer commit's CI run releases it.

To see what the next release would be:

```sh
npx nx release version --dry-run
```
