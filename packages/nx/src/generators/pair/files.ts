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

/** `webDist` is the web build relative to the api build, for example `../../web/dist`. */
export function uiRouteTs(webDist: string): string {
  return `import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';

// Same-origin SPA shell: hashed assets are immutable (served precompressed
// when the web build emitted .br/.gz), and every other GET returns index.html
// so the client router owns the URL. A GET under /api/ goes on to the API
// routes and their notFound.
export default function (router: Hono): void {
  // The path starts from the folder of the server bundle, because Nx and the
  // runtime image keep both app outputs under the workspace root.
  const webDist = join(
    relative(process.cwd(), import.meta.dirname),
    '${webDist}',
  );
  const indexHtml = join(webDist, 'index.html');
  router.use(
    '/assets/*',
    serveStatic({
      root: webDist,
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
    const html = await readFile(indexHtml, 'utf-8').catch(() => undefined);
    if (html === undefined) {
      return c.json(
        {
          error: 'Not Found',
          cause: {
            code: 'ui/build-missing',
            detail:
              process.env.NODE_ENV === 'development'
                ? \`Build the web app first (expected \${indexHtml})\`
                : 'The web build is not available',
          },
        },
        404,
      );
    }
    return c.html(html);
  });
}
`;
}
