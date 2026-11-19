// The content of each file that pair writes. Each is a string in a .ts
// module, so tsc puts it in dist with no copy step (ADR 0009).

export function apiTs(clientName: string): string {
  return `import { Client } from '${clientName}';

// Same-origin in production (the API serves this SPA) and proxied by the vite
// dev server in development, so the page origin is always right. The client
// needs an absolute URL (its interceptor calls \`new URL(baseUrl)\`), and the
// API mounts its routes under /api, which the sdk-it analyzer cannot see.
export const api = new Client({
  baseUrl: new URL('/api', globalThis.location.origin).toString(),
});
`;
}

/** The first line of the UI mount in app.ts; auth inserts its routes above it. */
export const uiMountComment =
  '// pair: the backend serves the web build that UI_ROOT names.';

/** The import of the UI route, in the mount of each version of pair. */
export const uiRouteImport = "import('./routes/ui.route.ts')";

/** The lines of app.ts that mount the UI route of pair. */
export const uiMount = `${uiMountComment} Unset, as in
// development, where Vite serves the web, there is no UI route.
const uiRoot = process.env.UI_ROOT;
if (uiRoot !== undefined) {
  await (await ${uiRouteImport}).default(app, uiRoot);
}`;

/** The mount that pair wrote before UI_ROOT; a second run replaces it. */
export const legacyUiMount = `// pair fixed the path of the web build; development enters through the Vite proxy.
(await ${uiRouteImport}).default(app);`;

/** The line of env.ts that declares UI_ROOT. */
export const uiRootEnvTs = `  // The folder of the web build that the backend serves (ui.route.ts). Unset,
  // the backend serves no UI.
  UI_ROOT: z.string().min(1).optional(),
`;

export const uiRouteTs = `import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';

import { logError } from '../logging.ts';

// Same-origin SPA shell from the web build in \`root\` (UI_ROOT): hashed
// assets are immutable (served precompressed when the web build emitted
// .br/.gz), and every other GET returns index.html so the client router owns
// the URL. A GET under /api/ goes on to the API routes and their notFound.
// It reads index.html once, at startup, and the process stops there when
// UI_ROOT names no web build.
export default async function (router: Hono, root: string): Promise<void> {
  const indexHtml = join(root, 'index.html');
  const html = await readIndexHtml(indexHtml);
  router.use(
    '/assets/*',
    serveStatic({
      root,
      precompressed: true,
      onFound: (_path, c) => {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  router.get('*', compress(), etag(), async (c, next) => {
    if (c.req.path.startsWith('/api/')) {
      await next();
      return;
    }
    return c.html(html);
  });
}

async function readIndexHtml(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (!(Error.isError(error) && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
    logError(
      {
        event: 'ui.build.missing',
        message: \`UI_ROOT names no web build: \${path} does not exist. Build the web app, or unset UI_ROOT.\`,
      },
      error,
    );
    process.exit(1);
  }
}
`;
