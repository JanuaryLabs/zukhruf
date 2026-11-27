import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import type { Environment } from './end.ts';

/**
 * The path that the process starts from: a name without a slash on the `PATH`
 * of `env`, any other name at its path from `cwd`.
 *
 * This predicts the start instead of trying it (ADR 0002). Under the keeper,
 * `sh` always starts, and a failed `exec` ends with 126 or 127, the codes that
 * a process can also give itself, so the trial cannot tell a missing file from
 * an exit. A file that goes away between this check and the start ends with
 * 127.
 */
export async function findFile(
  file: string,
  env: Environment,
  cwd: string,
): Promise<string> {
  if (file.includes('/')) {
    const path = resolve(cwd, file);
    await executable(path);
    return path;
  }
  let refused: Error | undefined;
  for (const folder of (env['PATH'] ?? '').split(delimiter)) {
    if (folder === '') continue;
    const path = join(folder, file);
    try {
      await executable(path);
      return path;
    } catch (error) {
      if (code(error) === 'EACCES' && Error.isError(error)) refused ??= error;
      else if (code(error) !== 'ENOENT' && code(error) !== 'ENOTDIR')
        throw error;
    }
  }
  throw (
    refused ??
    Object.assign(new Error(`${file} is not on the PATH of the environment`), {
      code: 'ENOENT',
    })
  );
}

async function executable(path: string): Promise<void> {
  await access(path, constants.X_OK);
  if (!(await stat(path)).isFile())
    throw Object.assign(new Error(`${path} is not a file`), {
      code: 'EACCES',
    });
}

function code(error: unknown): unknown {
  return Reflect.get(Object(error), 'code');
}
