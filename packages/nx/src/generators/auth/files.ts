// The content of each file that auth writes. Each is a string in a .ts
// module, so tsc puts it in dist with no copy step (ADR 0009).

/** The factory of the backend's auth. It reads no environment, so the app and the CLI config build the same auth. */
export function authTs(dbPackageName: string): string {
  return `import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import type { PrismaClient } from '${dbPackageName}';

export interface AuthOptions {
  prisma: PrismaClient;
  /** Signs the session cookies; 32 characters or more. */
  secret: string;
  /**
   * Where better-auth builds its links: the host of the request when it is
   * one of \`allowedHosts\`, else \`fallback\`, the URL of this server.
   */
  baseURL: { fallback: string; allowedHosts: string[] };
  /** The browser origins that may call the auth routes. */
  trustedOrigins: string[];
}

/**
 * The auth of the app. It reads no environment and imports no env.ts or
 * startup.ts: startup.ts calls it with the app's client and validated
 * environment, and auth.cli.ts calls it for the better-auth CLI, so both have
 * the same plugins.
 */
export function createAuth(options: AuthOptions) {
  return betterAuth({
    database: prismaAdapter(options.prisma, { provider: 'postgresql' }),
    secret: options.secret,
    baseURL: options.baseURL,
    // A baseURL from the request takes the protocol of the page from
    // x-forwarded-proto, which portless and the proxy in production send.
    advanced: { trustedProxyHeaders: true },
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: { enabled: true },
  });
}
`;
}

/** The module that the better-auth CLI loads, with c12 and jiti. */
export function authCliTs(dbPackageName: string): string {
  return `import { createPrisma } from '${dbPackageName}';

import { createAuth } from './auth.ts';

// The config of the better-auth CLI (the auth:generate and auth:check
// targets). The CLI imports this module and each module it imports, so it must
// have no side effect: no env.ts, no startup.ts, no query. createPrisma opens
// no connection until a query, and the CLI reads only the plugins and the
// adapter, so the secret and the URL are placeholders. The export must be
// named auth.
export const auth = createAuth({
  prisma: createPrisma({
    connectionString: process.env.CONNECTION_STRING ?? '',
  }),
  // A throwaway secret of 32+ characters: the CLI only reads the schema.
  secret: 'the-better-auth-cli-reads-no-secret-from-here',
  baseURL: { fallback: 'http://localhost', allowedHosts: ['localhost'] },
  trustedOrigins: [],
});
`;
}

export const authRouteTs = `import type { Hono } from 'hono';

// better-auth answers each request under /api/auth. The handler loads
// startup.ts at the first request, not at import: server.ts has loaded it
// already, and a test that imports app.ts needs no database and no auth
// environment.
export default function (app: Hono): void {
  app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
    const { auth } = await import('../startup.ts');
    return auth.handler(c.req.raw);
  });
}
`;

/** The line of app.ts that mounts the auth routes. */
export const authMount = `(await import('./routes/auth.route.ts')).default(app);`;

/** The lines of env.ts that declare the environment of better-auth. */
export const authEnvTs = `  // better-auth signs the session cookies with the secret, and builds its
  // links on the URL of this server.
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
`;

/** The lines that startup.ts gets: the auth, on the app's client and validated environment. */
export const startupAuthTs = `
// The auth of the app, on the client above. src/routes/auth.route.ts serves it.
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');
export const auth = createAuth({
  prisma,
  secret: process.env.BETTER_AUTH_SECRET,
  // A link of better-auth (email verification, password reset) opens on the
  // host of the page that asked for it, when that is the host of an allowed
  // origin, in every setup: the Vite dev server and portless proxy /api to
  // this server, and in production the backend serves the page, so the
  // cookie that the link sets reaches the page. Any other host gets
  // BETTER_AUTH_URL. better-auth refuses an empty allowedHosts, so
  // ALLOWED_ORIGINS names at least one origin.
  baseURL: {
    fallback: process.env.BETTER_AUTH_URL,
    allowedHosts: allowedOrigins.map((origin) => new URL(origin).host),
  },
  trustedOrigins: allowedOrigins,
});
`;

/**
 * The placeholder of the models of better-auth. The CLI writes its own
 * generator and datasource blocks into a missing file, and prisma generate
 * then fails with P1012, so the file is there before the CLI runs.
 */
export const authPrisma = `// The models of better-auth. The auth:generate target of the backend writes them.
`;

/**
 * The better-auth client of the web app. It has no baseURL: a paired web app
 * reaches the API on its own origin, through the Vite proxy of `/api` in
 * development, so the client's default, the page origin plus `/api/auth`, is
 * the backend's auth.
 */
export const authClientTs = `import { createAuthClient } from 'better-auth/react';

// better-auth in the browser. It calls /api/auth on the page origin: the Vite
// dev server proxies /api to the backend, and in production the backend serves
// this app from its own origin (pair).
export const authClient = createAuthClient();
`;

/**
 * The middleware that a route module of the backend lists to require a
 * session. Its session source loads startup.ts on the first request, as
 * auth.route.ts does, so app.test.ts still needs no database, and it takes its
 * type from the app's auth, so `c.var.session.user` has the app's own fields.
 */
export const backendSessionTs = `import { requireSession } from '@zukhruf/authentication/hono';

import type { auth } from './startup.ts';

// The session source of requireSession. It loads startup.ts on the first
// request, not at import, as routes/auth.route.ts does: a test that imports
// app.ts needs no database and no auth environment.
const sessions = {
  api: {
    async getSession(context: {
      headers: Headers;
    }): Promise<typeof auth.$Infer.Session | null> {
      const startup = await import('./startup.ts');
      return startup.auth.api.getSession(context);
    },
  },
};

/**
 * Refuses a request without a session with 401. A route that lists it reads
 * the session, with the app's own user fields, on c.var.session.
 */
export const signedIn = requireSession(sessions);
`;

/**
 * The loader guard of the web app, on its better-auth client. The host's
 * router passes the paths of its own pages; the generator writes no page.
 */
export const webSessionTs = `import {
  type RequireSessionOptions,
  requireSession,
} from '@zukhruf/authentication/react-router';
import type { LoaderFunctionArgs } from 'react-router';

import { authClient } from './auth-client.ts';

/**
 * The loader of a page behind sign-in. A visitor without a session goes to
 * \`signIn\`, with the page as the return path. The loader data is the session.
 */
export function signedInLoader(
  options: RequireSessionOptions<typeof authClient.$Infer.Session>,
) {
  return ({ request }: LoaderFunctionArgs) =>
    requireSession(authClient, request, options);
}
`;

/** The comment that auth puts above ALLOWED_ORIGINS when it adds the origins of the web app. */
export const allowedOriginsComment = `# CORS and better-auth trust these origins in every setup, and better-auth
# builds its links on their hosts. Here they are the origins of the web app:
# the Vite dev server and portless.
`;

/**
 * The lines that the env map of module "stack" in the main.tf of the dokploy
 * generator gets above its marker. The comment line keeps tofu fmt from
 * aligning them with the host's own keys.
 */
export const authStackEnv = `# better-auth signs the session cookies with the secret, and builds its links on the URL.
    BETTER_AUTH_SECRET = random_password.better_auth.result
    BETTER_AUTH_URL    = "https://\${local.host}"
    `;

/** The secret of better-auth in production, next to the main.tf of the dokploy generator. */
export const authTf = `# BETTER_AUTH_SECRET of the env of module "stack" in main.tf. better-auth signs
# the session cookies and encrypts its stored data with it, so a new value signs
# every user out and leaves that data unreadable (text2sql #398): the secret is
# never replaced.
resource "random_password" "better_auth" {
  length  = 64
  special = false

  lifecycle {
    prevent_destroy = true
  }
}
`;
