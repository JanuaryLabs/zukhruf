import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * The `typeRoots` that point a typed fixture's tsconfig at the workspace's
 * real @types/node, so the fixture sees `net.Socket`, `process` and the
 * modules of Node as a consumer's code does.
 */
export const nodeTypeRoots = [
  dirname(
    dirname(createRequire(import.meta.url).resolve('@types/node/package.json')),
  ),
];
