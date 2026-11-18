// The content of each file that react-app writes into the project. Each is a
// string in a .ts module, so tsc puts it in dist with no copy step (ADR 0009).
// The brand of a product (fonts, colors, favicons) is the product's own. The
// theme script and the `dark` variant are not brand: the monorepo standard §10
// puts them in every web app, and the owner kept them (ADR 0010, decision 1).

export function indexHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${name}</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script>
      // Sets the light or dark class before the first paint: the stored
      // choice, or the system's when the choice is "system" or missing.
      (function () {
        try {
          var stored = localStorage.getItem('theme');
          var theme =
            stored === 'light' || stored === 'dark' || stored === 'system'
              ? stored
              : 'system';
          var dark =
            theme === 'dark' ||
            (theme === 'system' &&
              window.matchMedia('(prefers-color-scheme: dark)').matches);
          document.documentElement.classList.add(dark ? 'dark' : 'light');
        } catch (e) {}
      })();
    </script>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

export const stylesCss = `@import "tailwindcss";

/* nx-tailwind-sources:start */
/* nx-tailwind-sources:end */

/* The theme script in index.html sets .dark; dark: utilities follow it. */
@custom-variant dark (&:is(.dark, .dark *));
`;

export function appTsx(name: string): string {
  return `export function App() {
  return <h1>Welcome to ${name}</h1>;
}

export default App;
`;
}

export const appTestTsx = `import { cleanup, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import App from './app.tsx';

test('renders the welcome heading', () => {
  try {
    render(<App />);
    expect(screen.getByRole('heading')).toHaveTextContent(/welcome/i);
  } finally {
    cleanup();
  }
});
`;

export const mainTsx = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import App from './app/app.tsx';
import './styles.css';

const router = createBrowserRouter([{ path: '/', Component: App }]);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing root element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
`;

export function viteConfig(
  name: string,
  projectRoot: string,
  rootOffset: string,
): string {
  return `/// <reference types='vitest' />
import { constants as zlibConstants } from 'node:zlib';

import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { compression, defineAlgorithm } from 'vite-plugin-compression2';

export default defineConfig(({ mode }) => {
  const enableSourceMaps =
    process.env.VITE_SOURCEMAP === 'true' || process.env.SOURCEMAP === 'true';
  const isVitest = mode === 'test' || process.env.VITEST === 'true';
  // Set by portless only when it launches the dev server; unlike PORT it
  // cannot be set by a stray shell env.
  const underPortless = Boolean(process.env.PORTLESS_URL);

  return {
    root: import.meta.dirname,
    cacheDir: '${rootOffset}node_modules/.vite/${projectRoot}',
    server: {
      port: underPortless && process.env.PORT ? Number(process.env.PORT) : 5173,
      // portless dials 127.0.0.1; 'localhost' binds ::1-only on macOS (IPv6
      // first) so the proxy can't reach it. Bind IPv4 explicitly under
      // portless.
      host: underPortless ? '127.0.0.1' : 'localhost',
      allowedHosts: ['.localhost', '.trycloudflare.com'],
      hmr: underPortless ? { clientPort: 443, protocol: 'wss' } : undefined,
      // Forward browser console output and uncaught errors over the HMR socket
      // into this process's stdout, so a transcript of the dev server (see the
      // portless target) is enough to read what the page logged. Vite's default
      // only turns this on when it detects an agent in the environment.
      forwardConsole: {
        logLevels: ['error', 'warn', 'info', 'log'],
      },
      // Development reaches the API through the dev server, so cookies and
      // relative URLs behave as in production, where the paired node app
      // serves this SPA from its own origin. Override when the API listens
      // elsewhere.
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
          ws: true,
        },
      },
    },
    plugins: [
      react({
        // Passing \`exclude\` replaces plugin-react's default /\\/node_modules\\//
        // filter, so it must be restated alongside the workspace dist exclude.
        exclude: [/\\/dist\\//, /\\/node_modules\\//],
      }),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      !isVitest &&
        compression({
          threshold: 1024,
          skipIfLargerOrEqual: true,
          algorithms: [
            defineAlgorithm('brotliCompress', {
              params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
            }),
            defineAlgorithm('gzip', { level: 9 }),
          ],
        }),
    ],
    base: './',
    build: {
      outDir: './dist',
      emptyOutDir: true,
      reportCompressedSize: true,
      sourcemap: enableSourceMaps,
      commonjsOptions: { transformMixedEsModules: true },
    },
    test: {
      name: '${name}',
      watch: false,
      globals: false,
      environment: 'happy-dom',
      pool: 'forks',
      execArgv: ['--no-experimental-webstorage'],
      include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
      setupFiles: ['@testing-library/jest-dom/vitest'],
      reporters: ['default', 'junit'],
      outputFile: { junit: './test-results.xml' },
      coverage: {
        reportsDirectory: '${rootOffset}coverage/${projectRoot}',
        provider: 'v8' as const,
      },
    },
  };
});
`;
}
