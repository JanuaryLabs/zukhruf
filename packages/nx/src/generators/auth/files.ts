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
  /** The URL of this server, where better-auth builds its links. */
  baseURL: string;
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
  secret: 'the-better-auth-cli-reads-no-secret-from-here',
  baseURL: 'http://localhost',
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
export const auth = createAuth({
  prisma,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: process.env.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ''),
});
`;

/**
 * The placeholder of the models of better-auth. The CLI writes its own
 * generator and datasource blocks into a missing file, and prisma generate
 * then fails with P1012, so the file is there before the CLI runs.
 */
export const authPrisma = `// The models of better-auth. The auth:generate target of the backend writes them.
`;
