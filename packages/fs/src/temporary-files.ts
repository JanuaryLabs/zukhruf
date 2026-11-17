import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TemporaryDirectory extends AsyncDisposable {
  /** The real path: symbolic links are resolved. */
  path: string;
  /** Remove the directory and its contents, with retries for a file that is held open. */
  cleanup: () => Promise<void>;
}

export interface TemporaryDirectorySync extends Disposable {
  /** The real path: symbolic links are resolved. */
  path: string;
  /** Remove the directory and its contents, with retries for a file that is held open. */
  cleanup: () => void;
}

export interface TemporaryDirectoryOptions {
  /** The directory that holds the new directory. Default: `os.tmpdir()`. */
  parent?: string;
}

// Windows refuses to remove a file that another process still holds open, for
// a short time. rm retries those refusals; Node's own mkdtempDisposable does not.
const removal = {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 50,
} as const;

/** Each acquisition owns an empty directory, removed with all that it holds. */
export class TemporaryFiles {
  async directory(
    prefix: string,
    { parent = tmpdir() }: TemporaryDirectoryOptions = {},
  ): Promise<TemporaryDirectory> {
    await using resources = new AsyncDisposableStack();
    const created = await mkdtemp(join(parent, prefix));
    resources.defer(() => rm(created, removal));
    const path = await realpath(created);
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return { path, cleanup, [Symbol.asyncDispose]: cleanup };
  }

  /** For code that cannot wait, such as a synchronous `Symbol.dispose`. */
  directorySync(
    prefix: string,
    { parent = tmpdir() }: TemporaryDirectoryOptions = {},
  ): TemporaryDirectorySync {
    using resources = new DisposableStack();
    const created = mkdtempSync(join(parent, prefix));
    resources.defer(() => rmSync(created, removal));
    const path = realpathSync(created);
    const owned = resources.move();
    const cleanup = () => owned.dispose();

    return { path, cleanup, [Symbol.dispose]: cleanup };
  }
}
