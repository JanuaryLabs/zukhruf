# Nx migrations bring a change of generated output to the repos that ran the generator before

Status: Accepted 2026-11-19 by the owner (backlog #4818).

A generator writes files once. When what it writes changes, a repo that ran it before stays behind until someone copies the change by hand. On 2026-11-19 three changes were copied by hand into meddit, factory and whatisgoingon: the portless proxy env (#4768), the local Postgres (#4792, ADR 0012 decisions 16 and 17), and the NODE_ENV configuration (#4833, ADR 0016). Nx runs a package's migrations when a repo moves to a new version of it with `nx migrate` (`nx-migrations` in package.json names `migrations.json`, whose entries carry the version that brings them).

## Decision

1. **Migrations run only when someone calls them**, with `npx nx migrate @zukhruf/nx@latest` and then `npx nx migrate --run-migrations` (decided by the owner). No hook runs them, and none refuses a bump made without them.
2. **`package.json` of @zukhruf/nx has `nx-migrations`**: `migrations: ./migrations.json`, and `packageGroup`, every published @zukhruf package. They share one version (nx release publishes the packages that Nx tags `npm:public`, every package that is not private), so `nx migrate` moves the family together. A test compares `packageGroup` with the packages of the repo that are not private, so a new package cannot be left out. `files` lists `migrations.json`.
3. **A migration is a generator over the repo, in `src/migrations/update-<version>/<name>.ts`**, as the Nx packages lay theirs out. Its `version` is the release that brings it: the next patch after the version on npm when it is written. A repo on an older version runs it on its next `nx migrate`. One that installs a release without it, and later one with it, would skip it, because Nx runs a migration only when its version is above the installed one.
4. **A migration follows the second-run rule of the generators**: it adds only what is missing, a value that is there stays (`addMissingKeys`, `unique`, `addEnvEntry`), and a second run writes nothing. It replaces a value only when the value is the one the generator wrote before (the `development` of a backend's serve).
5. **A migration finds the projects of a kind by the file its generator leaves**: `sdk-it.config.ts` for a node-app, `prisma.config.ts` for a db package, `vite.config.ts` beside an `index.html` for a react-app (a ui-package has no `index.html`), and a `portless` target. When a file it must change lost the shape the generator wrote (a `compose.dev.yml` with no `database` service on 127.0.0.1, a `prisma.config.ts` that reads another variable, a `main.tf` with no env marker), it changes nothing there and logs the step to take by hand. It never makes a partial edit.
6. **A migration writes what the generator writes now, through the generator's own code**: `addPortlessProxyEnv` (node-app, react-app and the migration: the third place, so the copy of #4786 is extracted), `addEnvEntry` (prisma, auth and the migrations: the third place of ADR 0014 decision 12, #4732), `localDatabaseTargets` and `composeDevYml` of the prisma generator, `addProductionNodeEnvDefaults` of init, and `envMarker` and `infraRoot` of dokploy. A test of each migration compares its output with a Tree that today's generators wrote.
7. **Source code is not rewritten.** `node-env-production` logs each NODE_ENV read with its file and line, and `zukhruf/no-node-env` refuses them; the replacements are in ADR 0016.
8. **The first three migrations (version 0.8.40)**:
   - `add-portless-proxy-env`: a repo with a `portless` target gets `PORTLESS_UNPRIVILEGED=1` and `PORTLESS_HTTPS=1` in `targetDefaults.portless.options.env`.
   - `add-local-postgres`: each db package gets a root `compose.dev.yml` when missing (port 5432, the database of the workspace scope; a file that is there names the port and the database), `up` and `down`, the local `CONNECTION_STRING` in its env files and those of each node-app whose source imports it (an empty `CONNECTION_STRING=` gets the URL), and `^up` in that backend's serve.
   - `node-env-production`: the nx.json defaults of test and serve, NODE_ENV=production in the backend's serve, auth CLI and sdk targets and the db package's `up`, the web's dev, serve and test exceptions, `NODE_ENV=production` in the `.env.example` (and `.env`) of each backend, db package and `infra/`, `NODE_ENV: production` and `npm_config_include: dev` in the workflow env of ci.yml and deploy.yml, and `ALLOWED_ORIGINS` above the env marker of the production `main.tf`.

## Considered Options

- **A pre-commit step that runs the migrations, or refuses a bump without them.** Not selected by the owner (decision 1).
- **A copy of each generator's output in the migration.** REJECTED: two copies of what a generator writes drift, and a migration must write exactly what the generator writes (decision 6).
- **Rewriting the NODE_ENV reads in source.** Not selected: a repo's code differs from the templates after it is generated (meddit's better-auth plugins and sign-up hook), and the lint rule already points at each read (decision 7).

## Consequences

- A dry run on 2026-11-19 (each migration on an `FsTree` of the repo, no flush): meddit got no change from any of the three, because it has all three by hand. factory got 11 updates from `node-env-production`, and a log that its db package reads DATABASE_URL, not CONNECTION_STRING. whatisgoingon got 10 updates, and a log that its `main.tf` has no env marker. Both logged their NODE_ENV reads (3 and 6, as #4865 and #4866 list them).
- A change of generated output now comes with a migration, or says why none can bring it.
