// The content of each file that node-app writes into the project. Each is a
// string in a .ts module, so tsc puts it in dist with no copy step (ADR 0009).

export function eslintConfig(rootOffset: string): string {
  return `import zukhruf from '@zukhruf/eslint';

import baseConfig, { modernNodeRecommended } from '${rootOffset}eslint.config.mjs';

export default [
  ...baseConfig,
  ...zukhruf.configs['hono'],
  ...modernNodeRecommended,
  { settings: { env: { startupFile: 'src/env.ts' } } },
];
`;
}

/**
 * The type-check-only tsconfig of sdk-it.config.ts: it is outside src, so this
 * tsconfig is what type-checks it, and the project's tsconfig.json references
 * it (ADR 0022).
 */
export function scriptsTsconfig(rootOffset: string) {
  return {
    extends: `${rootOffset}tsconfig.base.json`,
    compilerOptions: {
      outDir: 'out-tsc/scripts',
      rootDir: '.',
      tsBuildInfoFile: 'out-tsc/tsconfig.scripts.tsbuildinfo',
      types: ['node'],
    },
    include: ['sdk-it.config.ts'],
  };
}

export const appTs = `import { evlog } from 'evlog/hono';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { contextStorage } from 'hono/context-storage';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { timing } from 'hono/timing';

import { evlogMiddlewareOptions, evlogRequestContext } from './logging.ts';

const app = new Hono();

app.use(
  evlog(evlogMiddlewareOptions),
  evlogRequestContext(),
  timing(),
  // A browser origin gets CORS only when ALLOWED_ORIGINS lists it, in every
  // setup.
  cors({
    origin: (origin) => {
      // A request with no Origin header (a health check, a server call) needs
      // no CORS and never reads ALLOWED_ORIGINS.
      if (!origin) return '';
      const allowed = process.env.ALLOWED_ORIGINS.split(',');
      return allowed.map((entry) => entry.trim()).includes(origin)
        ? origin
        : '';
    },
    credentials: true,
  }),
  // Required by @sdk-it/hono/runtime's \`output\` helpers.
  contextStorage(),
);

app.use('/api/*', compress());

// Route modules register on the /api base path. Add new modules to this list;
// sdk-it only discovers routes that use \`validate\` and a JSDoc @openapi tag.
for await (const route of [import('./routes/healthz.route.ts')]) {
  route.default(app.basePath('/api'));
}

app.notFound((c) =>
  c.json(
    {
      error: 'Not Found',
      cause: {
        code: 'api/not-found',
        detail: 'The requested resource was not found',
        instance: c.req.path,
      },
    },
    404,
  ),
);

// The evlog middleware logs the error that reaches here, its cause included,
// and logging.ts sets the level from the status.
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message, cause: error.cause }, error.status);
  }
  // The log has the error; the response never carries it.
  return c.json(
    {
      error: 'Internal Server Error',
      cause: { code: 'api/internal', detail: 'Unexpected error' },
    },
    500,
  );
});

export default app;
`;

export const appTestTs = `import assert from 'node:assert/strict';
import { test } from 'node:test';

import app from './app.ts';

test('answers the health check on the API base path, with no build sha outside an image', async () => {
  const response = await app.request('/api/healthz');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', sha: null });
});

test('rejects unknown API routes with a JSON cause', async () => {
  const response = await app.request('/api/nope');

  assert.equal(response.status, 404);
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'cause' in body);
});
`;

export function envTs(port: number): string {
  return `import z from 'zod';

import { logError } from './logging.ts';

const env = z.object({
  PORT: z.string().optional().default('${port}'),
  // The bind address: 127.0.0.1 in .env, 0.0.0.0 in the image.
  HOST: z.string().min(1),
  // Kept a string: process.env stays string-valued so the ProcessEnv
  // augmentation below remains compatible with every Node API typed against
  // it (child_process env, etc.). Parse lists at the use site.
  ALLOWED_ORIGINS: z.string().default(''),
  // The commit the image was built from (the BUILD_SHA build arg of the
  // Dockerfile). /api/healthz reports it, so a deploy can tell the new
  // container from the old one. A process that is not an image has none.
  BUILD_SHA: z.string().min(1).optional(),
  // logging.ts reads these two before this check runs. The folder of the log
  // files (unset: no file), and \`true\` for readable logs (unset: JSON lines).
  LOG_DIR: z.string().min(1).optional(),
  LOG_PRETTY: z.enum(['true', 'false']).optional(),
});

const parsed = env.safeParse(process.env);
if (!parsed.success) {
  logError(
    {
      event: 'environment.validation.failed',
      message:
        'Please check that all required environment variables are correctly set.',
    },
    parsed.error,
  );
  process.exit(1);
}
// Reassigning process.env to a plain object keeps the parsed (non-string)
// values intact; Node would stringify anything assigned to the real one.
process.env = Object.assign({}, process.env, parsed.data);

declare global {
  namespace NodeJS {
    interface ProcessEnv extends z.infer<typeof env> {}
  }
}
`;
}

export function loggingTs(name: string): string {
  return `import { randomUUID } from 'node:crypto';

import {
  type DrainContext,
  type EnrichContext,
  createLogger,
  defineEvlog,
  initLogger,
  toLoggerConfig,
  toMiddlewareOptions,
} from 'evlog';
import { createFsDrain } from 'evlog/fs';
import type { EvlogHonoOptions, EvlogVariables } from 'evlog/hono';
import { createDrainPipeline } from 'evlog/pipeline';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

declare module 'hono' {
  interface ContextVariableMap {
    // Optional: an \`exclude\`d route has no request logger at all.
    log?: EvlogVariables['Variables']['log'];
    requestId?: string;
  }
}

// This module is imported by env.ts (to report validation failures), so it
// runs before the environment is validated and reads the raw variables. The
// log files go to LOG_DIR when it is set.
const logDir = process.env.LOG_DIR;
const fileDrain =
  logDir === undefined
    ? undefined
    : createDrainPipeline<DrainContext>({ batch: { size: 1 } })(
        createFsDrain({
          dir: logDir,
          maxFiles: 7,
          maxSizePerFile: 10 * 1024 * 1024,
        }),
      );

// evlog derives the level from the log calls, not from the response status:
// its Hono middleware logs each error that onError handled at error, and a
// handler that *returns* a 5xx logs at info. Enrichment runs after emit and
// before output and drain, with a mutable event. As the OpenTelemetry HTTP
// conventions treat a server span, a 4xx is the client's error: it logs at
// warn, and its error keeps the name, message, status and cause, not the
// stack.
function levelFromStatus({ event, response }: EnrichContext): void {
  const status = response?.status;
  if (status === undefined) return;
  if (status >= 500) {
    event.level = 'error';
  } else if (status >= 400 && event.level === 'error') {
    event.level = 'warn';
    if (typeof event.error === 'object' && event.error !== null) {
      Reflect.deleteProperty(event.error, 'stack');
    }
  }
}

const config = defineEvlog({
  service: '${name}',
  // Readable logs when LOG_PRETTY is true, JSON lines otherwise.
  pretty: process.env.LOG_PRETTY === 'true',
  redact: {
    paths: [
      'authorization',
      'cookie',
      'set-cookie',
      'password',
      'token',
      'apiKey',
      'connectionString',
      'databaseUrl',
    ],
  },
  drain: fileDrain,
  // evlog globs: \`*\` stops at \`/\`, \`**\` crosses it.
  exclude: ['/api/healthz', '/assets/**'],
  enrich: levelFromStatus,
});

initLogger(toLoggerConfig(config));

export const evlogMiddlewareOptions: EvlogHonoOptions =
  toMiddlewareOptions(config);

export async function flushLogs(): Promise<void> {
  await fileDrain?.flush();
}

// Gives every request one id (inbound X-Request-Id or a fresh UUID) that is
// echoed on the response, available as a context variable, and stamped on the
// wide event together with the matched route template. Register right after
// evlog() and before routes.
export function evlogRequestContext(): MiddlewareHandler {
  return async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? randomUUID();
    context.set('requestId', requestId);
    context.header('X-Request-Id', requestId);
    const requestLogger = context.get('log');
    requestLogger?.set({ requestId });

    await next();

    // routePath() with the default index reads the handler that answered; an
    // explicit -1 would pick the last *matched* route (a catch-all).
    const matchedPath = routePath(context);
    if (matchedPath) {
      requestLogger?.set({ route: matchedPath });
    }
  };
}

export function logError(
  context: Record<string, unknown>,
  error: unknown,
): void {
  const event = createLogger(context);
  event.error(
    Error.isError(error)
      ? error
      : new Error('Non-Error value thrown', { cause: error }),
  );
  event.emit();
}
`;
}

export const healthzRouteTs = `import { validate } from '@sdk-it/hono/runtime';
import type { Hono } from 'hono';

// sdk-it discovers a route only when: the path is a string literal, an
// argument is a call literally named \`validate\` whose selector is an arrow
// function, the last argument is an arrow function, and the JSDoc block sits
// directly above the statement.
export default function (router: Hono): void {
  /**
   * @openapi getHealthz
   * @tags health
   * @description Report whether the API is up, and the commit it was built from.
   */
  router.get(
    '/healthz',
    validate(() => ({})),
    async (c) => {
      return c.json({ status: 'ok', sha: process.env.BUILD_SHA ?? null });
    },
  );
}
`;

export const serverTs = `#!/usr/bin/env tsx
// @nx-target-name: serve
import './startup.ts';

import { createTerminus } from '@godaddy/terminus';
import { serve } from '@hono/node-server';
import { log } from 'evlog';

import app from './app.ts';
import { flushLogs, logError } from './logging.ts';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
// HOST is required (env.ts). .env binds 127.0.0.1: the dual-stack wildcard
// leaves the IPv4 address free for a stray local server to capture proxy
// traffic. The image binds 0.0.0.0.
const hostname = process.env.HOST;

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  log.info({
    event: 'server.started',
    port: info.port,
    address: info.address,
  });
});

// terminus answers /healthz before Hono sees the request and turns SIGTERM
// into a drained shutdown.
createTerminus(server, {
  healthChecks: { '/healthz': async () => ({ status: 'ok' }) },
  async onSignal() {
    log.info({ event: 'server.shutdown.started' });
    await flushLogs();
  },
  useExit0: true,
});

process.on('uncaughtException', (error) => {
  logError({ event: 'server.uncaught-exception' }, error);
  process.kill(process.pid, 'SIGTERM');
});

process.on('unhandledRejection', (reason) => {
  logError({ event: 'server.unhandled-rejection' }, reason);
  process.kill(process.pid, 'SIGTERM');
});
`;

export const startupTs = `import './env.ts';

// Boot module: connect stores, run migrations, and start queues or workers here
// before the app serves. Empty until the product needs it.
export {};
`;

export function envExample(port: number, name: string): string {
  return `# Copy to \`.env\` (gitignored). Nx loads this project's \`.env\`, \`.env.<target>\`
# and \`.env.<target>.<configuration>\` into every task it runs here, so
# \`nx run <project>:serve\` needs no dotenv.
# Every setup runs under production; no code reads NODE_ENV (ADR 0016).
NODE_ENV=production
PORT=${port}
# Bind address, required. 127.0.0.1, so portless and the web dev proxy always
# reach the server; the image binds 0.0.0.0.
HOST=127.0.0.1
# Comma-separated browser origins allowed to call the API (CORS).
ALLOWED_ORIGINS=
# The folder of the log files. Unset writes no log file.
LOG_DIR=.evlog/logs/${name}
# true prints readable logs; unset prints JSON lines.
LOG_PRETTY=true
`;
}

export interface DockerfileOptions {
  projectRoot: string;
  projectName: string;
  port: number;
  /** The `workspaces` of the root package.json: npm ci reads the manifest of each. */
  workspaces: string[];
  /** The paired web app, whose build the image serves. */
  spa?: { projectName: string; projectRoot: string };
}

export function dockerfile(options: DockerfileOptions): string {
  const { projectRoot, projectName, port, workspaces, spa } = options;
  const manifests = workspaces
    .map((workspace) => `${workspace.replace(/\/+$/, '')}/package.json`)
    .join(' ');
  const buildProjects = spa ? `${projectName},${spa.projectName}` : projectName;
  const spaCopy = spa
    ? `COPY --from=build /workspace/${spa.projectRoot}/dist ./${spa.projectRoot}/dist\n`
    : '';
  // The backend serves the web build that UI_ROOT names (pair).
  const uiRoot = spa ? ` UI_ROOT=/app/${spa.projectRoot}/dist` : '';
  return `# syntax=docker/dockerfile:1
# @zukhruf/nx:node-app writes this file, and @zukhruf/nx:pair writes it again.
# Build from the workspace root: \`nx run ${projectName}:docker:build\`.

FROM node:lts-alpine AS build
ENV NX_DAEMON=false
# The lockfile is the latest npm's; the image's bundled npm can be older and
# resolve peer ranges differently, so it must not decide the tree.
RUN npm install -g npm@latest
WORKDIR /workspace
# npm ci reads only the lockfile, the root manifest, its .npmrc and the
# manifest of each workspace, so a change to any other file reuses the
# installed layer. The manifests are the \`workspaces\` of package.json when
# the generator ran: a new workspace needs its manifest here.
COPY package-lock.json package.json .npmrc ./
COPY --parents ${manifests} ./
RUN npm ci --ignore-scripts
# .dockerignore keeps node_modules, dist, .nx, .git, .env* and generated
# sdk-it output out of the context.
COPY . .
RUN NODE_ENV=production npx nx run-many --targets build --configuration production --projects ${buildProjects} \\
 && npx nx run ${projectName}:prune-lockfile

FROM node:lts-alpine AS runtime
# The commit this image is built from; /api/healthz reports it. docker:build
# passes it, and an image built without it does not start (env.ts).
ARG BUILD_SHA
ENV NODE_ENV=production HOST=0.0.0.0 PORT=${port} BUILD_SHA=$BUILD_SHA${uiRoot}
RUN npm install -g npm@latest
WORKDIR /app
# prune-lockfile writes the runtime manifest (type: module, runtime deps only)
# and a lockfile reduced to that closure.
COPY --from=build /workspace/${projectRoot}/dist/package.json /workspace/${projectRoot}/dist/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /workspace/${projectRoot}/dist ./${projectRoot}/dist
${spaCopy}USER node
EXPOSE ${port}
# No \`\${}\` so /bin/sh never sees a substitution; terminus answers /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--enable-source-maps", "${projectRoot}/dist/server.js"]
`;
}

export const dockerignore = `.git
.nx
node_modules
**/node_modules
**/dist
**/out-tsc
**/coverage
**/.env
**/.env.*
**/.sdk-it/src
**/.sdk-it/dist
**/.sdk-it/.project-hash
`;

export function sdkItConfig(projectName: string, packageName: string): string {
  return `import { defineConfig } from '@sdk-it/cli';

// Project mode: the Hono routes reachable from tsconfig.app.json are analyzed
// in memory and compiled into the ./.sdk-it workspace package
// (\`nx run ${projectName}:sdk\`). The solution tsconfig.json lists no files,
// so it must be the app config.
export default defineConfig({
  tsconfig: './tsconfig.app.json',
  output: './.sdk-it',
  packageName: '${packageName}',
});
`;
}

/**
 * The backend's \`build-deps\`, which the client's \`sdk\` runs through
 * \`^build-deps\`: the builds of the backend's dependencies, and their
 * generators, run before sdk-it reads the backend's types. Nx makes a target
 * with no command a no-op.
 */
export const buildDepsTarget = { dependsOn: ['^build'] };

/**
 * The committed stub of the generated client. \`sdk-it generate\` (0.46.11,
 * project mode) keeps an existing package.json and assigns only its own
 * fields into it, so a stub with each of those keys, and the \`nx\` block that
 * sdk-it never touches, is written back unchanged. With the stub committed,
 * \`npm ci\` links the client on a fresh clone before the first \`sdk\` run, and
 * the client is an Nx library whose \`sdk\` target is its build: consumers reach
 * it through the \`^sdk\` target default. sdk-it reads the api's types, and
 * through them the generated code of the api's dependencies (the Prisma
 * client), but the client imports neither, so the implicit dependency on the
 * api is the edge: \`nx affected\` reaches the client and its consumers, and
 * \`^build-deps\` runs the api's dependency builds, with their generators,
 * before sdk-it. Their \`.ts\` outputs are in the hash. The edge brings no npm
 * package into a consumer manifest: an implicit dependency is order, never an
 * import (\`manifest/dependency-checks\` of @zukhruf/eslint, its ADR 0005).
 */
export function clientManifest(name: string, apiProjectName: string): string {
  const manifest = {
    name,
    version: '0.0.1',
    private: true,
    type: 'module',
    main: './dist/index.js',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    publishConfig: { access: 'public' },
    exports: {
      './package.json': './package.json',
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    },
    dependencies: { 'fast-content-type-parse': '^3.0.0', zod: '^4.3.0' },
    nx: {
      projectType: 'library',
      implicitDependencies: [apiProjectName],
      targets: {
        sdk: {
          // Config discovery walks up from cwd to the api's sdk-it.config.ts.
          command: 'sdk-it generate',
          options: {
            cwd: '{projectRoot}',
            env: { NODE_ENV: 'production' },
          },
          cache: true,
          dependsOn: ['^build-deps'],
          inputs: [
            '^production',
            { dependentTasksOutputFiles: '**/*.ts', transitive: true },
            '{workspaceRoot}/package-lock.json',
            '{projectRoot}/package.json',
          ],
          outputs: [
            '{projectRoot}/src',
            '{projectRoot}/dist',
            '{projectRoot}/.project-hash',
          ],
        },
      },
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * A placeholder for the TypeScript sync of Nx and \`tsc --build\`: a consumer
 * gets a project reference to the client, but its types resolve through the
 * package.json exports (dist/index.d.ts). sdk-it keeps an existing
 * tsconfig.json (its own sets noEmit, which \`tsc --build\` refuses) and
 * compiles the client with its own program.
 */
export function clientTsconfig(rootOffset: string): string {
  const tsconfig = {
    extends: `../${rootOffset}tsconfig.base.json`,
    compilerOptions: {
      outDir: 'out-tsc',
      tsBuildInfoFile: 'out-tsc/tsconfig.tsbuildinfo',
    },
    files: [],
    include: [],
  };
  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}
