import { createRequire } from 'node:module';
import { join } from 'node:path';

import nx from '@nx/eslint-plugin';

import { isRecord } from './unknown-values.ts';

// @nx/eslint-plugin (checked 24.0.2) requires eslint-plugin-import,
// eslint-plugin-jsx-a11y, eslint-plugin-react and eslint-plugin-react-hooks in
// flat/react, but declares none of them. This package declares them as optional
// peers, so npm writes the lockfile edges that Nx hashes for a lint input on
// @zukhruf/eslint. Delete the peers when @nx/eslint-plugin declares them.

// flat/react sets settings.react.version to 'detect'. eslint-plugin-react
// 7.37.5 lib/util/version.js:31 (resolveBasedir) then calls
// context.getFilename(), which ESLint 10 removed, so every rule crashes at load.
// No upstream fix as of 2026-10-31. The preset gives the version of the react
// package that resolves from the folder where ESLint runs: `nx lint` runs
// `eslint .` in the project root, and a hoisted react resolves from there.
// react is an optional peer for the reason above: its version changes the lint
// result, so the lockfile edge puts it in the hash of a lint input.
function installedReactVersion(): string {
  const workspace = createRequire(join(process.cwd(), 'package.json'));
  let manifest: unknown;
  try {
    manifest = workspace('react/package.json');
  } catch (error) {
    if (isRecord(error) && error['code'] === 'MODULE_NOT_FOUND') {
      throw new Error(
        `@zukhruf/eslint/react needs the react package, and react does not resolve from ${process.cwd()}. Install react in the workspace.`,
        { cause: error },
      );
    }
    throw error;
  }
  const version = isRecord(manifest) ? manifest['version'] : undefined;
  if (typeof version !== 'string') {
    throw new TypeError('The package.json of react has no version.');
  }
  return version;
}

const version = installedReactVersion();

export default nx.configs['flat/react'].map((config) => {
  const react = config.settings?.['react'];
  return isRecord(react)
    ? {
        ...config,
        settings: { ...config.settings, react: { ...react, version } },
      }
    : config;
});
