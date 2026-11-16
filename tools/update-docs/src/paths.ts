import { sep } from 'node:path';

/** Whether path is prefix itself or a path inside it. */
export function under(path: string, prefix: string): boolean {
  return (
    path === prefix ||
    path.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep)
  );
}
