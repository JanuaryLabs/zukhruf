import { readFileSync } from 'node:fs';

/**
 * The one exact version of `nx` and each `@nx/*` that a generator writes. A
 * generator sets it also over another version, so npm installs one `nx`
 * (#4532). An update is a release of @zukhruf/nx.
 */
export const nxVersion = '24.0.6';

/** The Nx packages that the root files load: `@nx/js/typescript`, `@nx/eslint/plugin`, the root ESLint config, and the peers of @zukhruf/nx. */
export const nxFamily = [
  'nx',
  '@nx/devkit',
  '@nx/eslint',
  '@nx/eslint-plugin',
  '@nx/js',
];

/**
 * The other root tools, at exact versions. A generator adds a missing one and
 * keeps a version that is there. TypeScript 7 compiles and TypeScript 6 gives
 * its API to typescript-eslint and `@nx/js` (README, monorepo standard). The ESLint
 * packages are the peers of @zukhruf/eslint that the root config loads, with
 * the 2 of `@zukhruf/eslint/modern-node`.
 */
export const rootToolVersions: Record<string, string> = {
  '@e18e/eslint-plugin': '0.8.1',
  '@eslint/js': '10.0.1',
  '@trivago/prettier-plugin-sort-imports': '6.0.2',
  '@typescript/native': 'npm:typescript@7.0.2',
  eslint: '10.15.0',
  'eslint-plugin-functional': '10.0.1',
  'eslint-plugin-import-x': '4.18.1',
  // @zukhruf/eslint peers on ^79.0.0.
  'eslint-plugin-unicorn': '79.0.0',
  'jsonc-eslint-parser': '3.3.0',
  prettier: '3.10.1',
  typescript: 'npm:@typescript/typescript6@6.0.2',
  'typescript-eslint': '8.73.0',
};

/**
 * The packages of the app generators, at exact versions, each the latest on
 * 2026-11-18 (#3338). A generator adds a missing package, and keeps a version
 * that was there before it ran. Each `@nx/*` plugin gets `nxVersion`.
 */
export const appPackageVersions = {
  // node-app: the runtime of the backend, and its build tools.
  '@godaddy/terminus': '4.12.1',
  '@hono/node-server': '2.1.9',
  '@sdk-it/cli': '0.46.11',
  '@sdk-it/hono': '0.46.11',
  esbuild: '0.28.2',
  // The Nx generators add these two with a range.
  '@types/node': '26.6.6',
  tslib: '2.9.1',
  evlog: '2.35.1',
  hono: '4.13.19',
  zod: '4.6.7',
  // pair: the generated client imports it. sdk-it writes ^3.0.0 in the client
  // manifest, so the web app takes the latest 3.x, not 4.
  'fast-content-type-parse': '3.0.0',
  // react-app and ui-package: React, Vite, Tailwind and the React lint plugins
  // that @zukhruf/eslint/react loads.
  '@eslint-react/eslint-plugin': '5.30.4',
  '@juristr/nx-tailwind-sync': '0.0.9',
  '@rolldown/plugin-babel': '0.3.1',
  '@tailwindcss/vite': '4.3.5',
  '@types/react': '19.3.0',
  '@types/react-dom': '19.3.0',
  '@vitejs/plugin-react': '6.3.0',
  'babel-plugin-react-compiler': '1.0.0',
  'eslint-plugin-jsx-a11y-x': '0.2.0',
  'eslint-plugin-react-hooks': '7.1.1',
  'eslint-plugin-react-you-might-not-need-an-effect': '1.2.0',
  'prettier-plugin-tailwindcss': '0.8.1',
  react: '19.3.1',
  'react-dom': '19.3.1',
  // @zukhruf/authentication peers on ^8.5.2, and npm refuses a lower one
  // (ERESOLVE), so auth --web raises a lower version to this one.
  'react-router': '8.5.2',
  tailwindcss: '4.3.5',
  vite: '8.3.8',
  'vite-plugin-compression2': '2.5.4',
  'vite-plugin-dts': '5.1.2',
  // react-app: component tests.
  '@testing-library/dom': '10.4.2',
  '@testing-library/jest-dom': '7.0.1',
  '@testing-library/react': '16.3.3',
  '@vitest/coverage-v8': '5.1.1',
  'happy-dom': '21.0.4',
  vitest: '5.1.1',
  // ui-package: the component test registers happy-dom's DOM in node:test.
  // It releases with happy-dom.
  '@happy-dom/global-registrator': '21.0.4',
  // prisma: the CLI, the client and its Postgres adapter release together and
  // must have one version. The `latest` tag of `prisma` is a release candidate
  // of 8 (8.0.0-rc.34 on 2026-11-18), so the three are pinned to the last
  // stable version, and a test checks that they are equal (#4604).
  prisma: '7.10.1',
  '@prisma/client': '7.10.1',
  '@prisma/adapter-pg': '7.10.1',
  // The test helper of a db package replays the migrations with pg.
  pg: '8.23.1',
  '@types/pg': '8.23.1',
  // auth: better-auth and its CLI release together and must have one version.
  // The CLI writes the models of the plugins of one better-auth.
  'better-auth': '1.7.26',
  auth: '1.7.26',
} as const satisfies Record<string, string>;

/** The zukhruf packages that the root files load. */
export const zukhrufPackages = [
  '@zukhruf/eslint',
  '@zukhruf/git-hooks',
  '@zukhruf/nx',
];

const ownPackageJson: { version: string } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
);

/**
 * The version of this package. nx release gives each public package of zukhruf
 * the same version, so it is also the version of each zukhruf package.
 */
export const zukhrufVersion = ownPackageJson.version;
