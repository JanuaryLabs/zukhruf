import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TemporaryDirectory extends AsyncDisposable {
  /** The real path: symbolic links are resolved. */
  path: string;
  /** Remove the directory and its contents, with retries for a file that is held open. */
  cleanup: () => Promise<void>;
}

export interface TemporaryDirectoryOptions {
  /** The directory that holds the new directory. Default: `os.tmpdir()`. */
  parent?: string;
}

/** Each acquisition owns an empty directory, removed with all that it holds. */
export class TemporaryFiles {
  async directory(
    prefix: string,
    { parent = tmpdir() }: TemporaryDirectoryOptions = {},
  ): Promise<TemporaryDirectory> {
    await using resources = new AsyncDisposableStack();
    const created = await mkdtemp(join(parent, prefix));
    resources.defer(() =>
      rm(created, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 50,
      }),
    );
    const path = await realpath(created);
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return { path, cleanup, [Symbol.asyncDispose]: cleanup };
  }
}
