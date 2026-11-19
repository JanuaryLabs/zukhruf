# The generated code reads explicit settings, and never NODE_ENV

Status: Accepted 2026-11-19 by Ezz (backlog #4825, step #4833). It supersedes in part [ADR 0014](./0014-the-auth-generator-adds-better-auth-to-a-backend-and-its-db-package.md) decisions 7 and 17.

NODE_ENV is `production` on a laptop, in CI, in tests and in production, and code never decides anything on it (https://ezz.sh/posts/nodeenv-does-not-mean-what-you-think-it-means). A behavior that differs between setups reads its own setting, and fails loudly when that setting points at nothing. Tools may read NODE_ENV, and a target may set it for them. `zukhruf/no-node-env` of @zukhruf/eslint (#4832) refuses every read of NODE_ENV in code, so the code that the generators write must pass it.

Before this ADR a generated backend read NODE_ENV in seven places: CORS, the 500 body, the bind address, the log file drain, the evlog environment label, the better-auth baseURL and the message of the UI route. The backend `serve` and the auth CLI targets set `NODE_ENV=development` for it.

Facts read on 2026-11-19:

- better-auth 1.7.26 refuses only its own default secret under production (`validateSecret` in `context/create-context.mjs`). `auth check schema` with `NODE_ENV=production` and the explicit secret of `auth.cli.ts` passed in meddit.
- better-auth refuses a dynamic `baseURL` whose `allowedHosts` is empty.
- evlog 2.35 takes `pretty` from NODE_ENV when the option is omitted, and its environment label from NODE_ENV.
- Vite under `NODE_ENV=production` sets `isProduction`, and `@vitejs/plugin-react` turns React Fast Refresh off in the dev server. Production React 19.3 has no `act()`, so Testing Library cannot render under production.
- `serveStatic` of `@hono/node-server` 2 joins an absolute `root` with the request path.
- Nx 24.0.6 merges a target's `options` key by key, and a plain object value such as `env` replaces the value of the lower layer (`getMergeValueResult` in `project-configuration/utils.js`) unless it starts with `"...": true`. `nx show project` on a scratch workspace with `targetDefaults.test` and `.serve` at `NODE_ENV=production` gave the inferred node `test` and a `serve` with no env `production`, and a project `serve` and `test` with their own env `development` and `test`.

## Decision

1. **CORS takes ALLOWED_ORIGINS in every setup** (`app.ts`). Nothing reflects an origin. The dokploy generator's production env sets `ALLOWED_ORIGINS = "https://${local.host}"`, the public origin it already knows.
2. **A 500 body never carries the error** (`app.ts`): it is `{ code: 'api/internal', detail: 'Unexpected error' }` everywhere, and the log has the error.
3. **HOST is required** (`env.ts`, `z.string().min(1)`), with no default in code (`server.ts`). `.env.example` and the generated `.env` set `127.0.0.1`, and the Dockerfile `0.0.0.0`.
4. **The log file drain runs when LOG_DIR is set, and evlog prints readable logs when LOG_PRETTY is `true`** (`logging.ts`). `.env.example` sets `LOG_DIR=.evlog/logs/<app>` (the folder of before) and `LOG_PRETTY=true`; the image sets neither, so it writes JSON lines to stdout and no file. There is no explicit environment label: evlog derives one. `logging.ts` runs before `env.ts` validates, so it reads the raw variables; `env.ts` declares both (`LOG_DIR` optional, `LOG_PRETTY` `'true' | 'false'` optional), so a wrong value stops the process.
5. **The better-auth baseURL is always `{ fallback: BETTER_AUTH_URL, allowedHosts: <the hosts of ALLOWED_ORIGINS> }`** (`startup.ts`), and `createAuth` takes only that shape and always sets `advanced.trustedProxyHeaders`. A verification or reset link lands on the host of the page that asked for it, in every setup; a host that is not an allowed origin gets `BETTER_AUTH_URL`. `auth.cli.ts` passes `{ fallback: 'http://localhost', allowedHosts: ['localhost'] }`.
6. **UI_ROOT names the built web folder** (pair). When it is set, `app.ts` mounts the UI route with it, and the route reads `<UI_ROOT>/index.html` once at startup; a missing file logs `ui.build.missing` with the path and exits 1. When it is unset (development, where Vite serves the web), there is no UI route at all. pair declares `UI_ROOT` optional in `env.ts`, and its Dockerfile sets `UI_ROOT=/app/<web>/dist`, the folder it copies the web build into. A backend with no web has no UI_ROOT. pair replaces the mount it wrote before UI_ROOT.
7. **env.ts has no NODE_ENV**; it declares HOST, LOG_DIR and LOG_PRETTY (node-app) and UI_ROOT (pair) in the existing style.
8. **NODE_ENV=production comes from four places, and no `.env` file is committed.**
   - (a) Each `.env.example` that a generator writes (node-app, prisma, the `infra/` of dokploy) holds `NODE_ENV=production` under a one-line comment, and so does the gitignored `.env` that node-app and prisma write from it when it is missing.
   - (b) Each target that a generator writes into a `package.json` and that runs code sets `NODE_ENV: 'production'` in `options.env`: the backend `serve` (in place of `development`), `auth:generate` and `auth:check`, the `up` of the db package, and the `sdk` target of the client stub. `auth.cli.ts` passes an explicit throwaway secret of 32 or more characters, with a comment that the CLI only reads the schema. Not `portless`: its own env would replace the portless env of the target default, and the target it runs sets NODE_ENV. Not `docker:build`, `docker:run` and `down`: they run the Docker CLI, and the Dockerfile sets NODE_ENV itself.
   - (c) `init` sets `targetDefaults.test` and `.serve` `options.env.NODE_ENV` to `production`, with `updateTargetDefault`, and keeps a `NODE_ENV` that is there. Not `build`: the backend build runs the `@nx/esbuild` executor, whose schema may refuse an `env` option. A project target's own `env` replaces this one (the Nx fact above).
   - (d) CI: the `ci.yml` and `deploy.yml` that dokploy writes set `env: NODE_ENV: production` at workflow level, with `npm_config_include: dev` beside it. npm reads NODE_ENV too: under production it omits devDependencies (npm 12: `npm config get omit` gives `dev`), so `npm ci` in zukhruf's setup action left out the Prettier plugin and failed the strict allow-scripts check (meddit 2399cf1). `include=dev` is npm's own setting, and it wins over the omit. zukhruf's shared actions stay as they are (decided by the owner).
9. **Exceptions, each on a project's own targets, never in a shared default.** The web `dev` and `serve` targets set `NODE_ENV=development`, because Vite turns Fast Refresh off under production. The web `test` target keeps `NODE_ENV=test`, because production React has no `act()`. The web test needs it because Testing Library wraps each render and event in `act()`. The owner approved these two web exceptions and no others. The component test of a ui-package needs none: it renders with `flushSync` of `react-dom`, which production React has, in place of `act()` (under production React 19.3.1, the latest, `typeof act` is `undefined`; `createRoot` with `flushSync` rendered, applied a click and ran a passive effect). So its `test` target runs under the production of `targetDefaults.test`.
10. **Kept.** `namedInputs.production` keeps `{ env: 'NODE_ENV' }`, so a build under another value is never served from the cache. The pre-push `Build` sets `NODE_ENV=production`, and the Dockerfile sets it in the build and the runtime stage: they set it for tools, which is allowed.

## Considered Options

- **A committed root `.env` holding only `NODE_ENV=production`, with `!/.env` in `.gitignore`.** REJECTED by the owner: no `.env` file is ever committed.
- **`NODE_ENV=production` in `targetDefaults.build`.** REJECTED: see decision 8 (c).
- **NODE_ENV in zukhruf's shared `setup-workspace` action**, one place for every repo. Not selected by the owner: each repo's own workflow files set it.
- **UI_ROOT declared by node-app for every backend.** Not selected: a backend without a web would declare a setting that names nothing. pair, which writes the UI route, declares it.
- **Read index.html on each request and answer 404 `ui/build-missing`, as before.** Not selected: a missing build is a broken setup, so the process stops at startup instead of serving a 404 page.

## Consequences

- A repo that sets NODE_ENV some other way (a shell, an IDE) still gets production in every Nx task of a generated target or default, because a target's `options.env` wins over the process environment; a target that no generator wrote and no default reaches gets the shell's value.
- A generated backend behaves the same on a laptop, in tests and in production; each difference is a line of its `.env` or its image.
- A backend with auth needs at least one origin in ALLOWED_ORIGINS, or better-auth refuses its baseURL. `--web` of auth adds the Vite and portless origins, and the dokploy generator adds the public origin.
- A repo generated before (meddit) makes the same edits by hand: its `main.tf` env gets `ALLOWED_ORIGINS`, and its `.env` gets `NODE_ENV`, `LOG_DIR` and `LOG_PRETTY`; its targets and `nx.json` get the env of decision 8.
- The backend tests run with the project `.env` that Nx loads, so with `LOG_DIR` set they write log files to `.evlog/logs/<app>`, as `serve` does.
