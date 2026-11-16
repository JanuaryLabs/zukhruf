import { posix } from 'node:path';

/** An absolute path. launchd expands no `~` and no `$HOME`. */
export type AbsolutePath = `/${string}`;

/** Whether a path, such as one from `path.resolve()`, is an `AbsolutePath`, after `path.isAbsolute` of `node:path`. */
export function isAbsolutePath(path: string): path is AbsolutePath {
  return posix.isAbsolute(path);
}
