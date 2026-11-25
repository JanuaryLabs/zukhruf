import { createRequire } from 'node:module';

import type { ProjectFileMap } from '@nx/devkit';

import { isRecord } from '../unknown-values.ts';

type Internal = typeof import('@nx/devkit/internal');

/**
 * The functions of `@nx/devkit/internal` that read Nx's file map and filter a
 * project's files by a target's inputs, as Nx's own dependency-checks does.
 */
export type FileMapReader = Pick<
  Internal,
  | 'readFileMapCache'
  | 'filterUsingGlobPatterns'
  | 'getTargetInputs'
  | 'readNxJsonFromDisk'
  | 'fileDataDepTarget'
>;

const FUNCTIONS = [
  'readFileMapCache',
  'filterUsingGlobPatterns',
  'getTargetInputs',
  'readNxJsonFromDisk',
  'fileDataDepTarget',
] as const satisfies readonly (keyof FileMapReader)[];

const require = createRequire(import.meta.url);
const INTERNAL = '@nx/devkit/internal';

/** `@nx/devkit/internal`, or `undefined` where the installed Nx has none (Nx 21). */
function loadInternal(): unknown {
  try {
    return require(INTERNAL);
  } catch (error) {
    const code = isRecord(error) ? error['code'] : undefined;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      return undefined;
    throw error;
  }
}

function isReader(internal: unknown): internal is FileMapReader {
  return (
    isRecord(internal) &&
    FUNCTIONS.every((name) => typeof internal[name] === 'function')
  );
}

const readerByModule = new Map<string, FileMapReader | undefined>();

/**
 * The installed Nx's file map functions, read once. Only Nx 23.2 and later
 * export them: Nx 21 has no `@nx/devkit/internal`, and Nx 22 and 23.1 have
 * one without them.
 */
export function fileMapReader(): FileMapReader | undefined {
  if (!readerByModule.has(INTERNAL)) {
    const internal = loadInternal();
    readerByModule.set(INTERNAL, isReader(internal) ? internal : undefined);
  }
  return readerByModule.get(INTERNAL);
}

/** The file map that `nx` caches with the project graph, or none. */
export function cachedFileMap(): ProjectFileMap {
  return fileMapReader()?.readFileMapCache()?.fileMap.projectFileMap ?? {};
}
