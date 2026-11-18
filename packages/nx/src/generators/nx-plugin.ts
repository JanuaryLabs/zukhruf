import { createRequire } from 'node:module';

import { ensurePackage } from '@nx/devkit';

import { nxVersion } from './versions.ts';

const require = createRequire(import.meta.url);

/** The entry points of the Nx plugins that the app generators call, by the package that holds each. */
interface NxPlugins {
  '@nx/node': typeof import('@nx/node');
  '@nx/react': typeof import('@nx/react');
  '@nx/vitest/generators': typeof import('@nx/vitest/generators');
}

function isModuleNotFound(error: unknown): boolean {
  return (
    Error.isError(error) && 'code' in error && error.code === 'MODULE_NOT_FOUND'
  );
}

/**
 * Loads an Nx plugin that an app generator calls, for example `@nx/node`. It
 * takes the copy that resolves from this package, and else installs the plugin
 * at `nxVersion` into a temporary folder, as an Nx generator does for its own
 * plugins (`ensurePackage` of @nx/devkit). The plugin's own generator adds it
 * to the root package.json.
 */
export function nxPlugin<Entry extends keyof NxPlugins>(
  entry: Entry,
): NxPlugins[Entry] {
  try {
    return require(entry);
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
  }
  // ensurePackage adds the temporary folder to the paths that require reads.
  ensurePackage(entry.split('/').slice(0, 2).join('/'), nxVersion);
  return require(entry);
}
