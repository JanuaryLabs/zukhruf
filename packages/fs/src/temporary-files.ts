import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  /**
   * The files to write into the new directory: a relative path, with `/`
   * between its folders, to its content. A path is valid as `fs.ValidPath` of
   * Go says, and on Windows it has no `\\` and no `:`.
   */
  files?: Readonly<Record<string, string | Uint8Array>>;
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
    { parent = tmpdir(), files = {} }: TemporaryDirectoryOptions = {},
  ): Promise<TemporaryDirectory> {
    const tree = validFiles(files);
    await using resources = new AsyncDisposableStack();
    const created = await mkdtemp(join(parent, prefix));
    resources.defer(() => rm(created, removal));
    const path = await realpath(created);
    for (const [file, content] of tree) {
      const target = join(path, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return { path, cleanup, [Symbol.asyncDispose]: cleanup };
  }

  /** For code that cannot wait, such as a synchronous `Symbol.dispose`. */
  directorySync(
    prefix: string,
    { parent = tmpdir(), files = {} }: TemporaryDirectoryOptions = {},
  ): TemporaryDirectorySync {
    const tree = validFiles(files);
    using resources = new DisposableStack();
    const created = mkdtempSync(join(parent, prefix));
    resources.defer(() => rmSync(created, removal));
    const path = realpathSync(created);
    for (const [file, content] of tree) {
      const target = join(path, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const owned = resources.move();
    const cleanup = () => owned.dispose();

    return { path, cleanup, [Symbol.dispose]: cleanup };
  }
}

/**
 * The entries of `files`, each checked before anything is made, so a refused
 * path leaves no folder, also not in the parent. A path is valid as
 * `fs.ValidPath` of Go: relative, with no empty, `.` or `..` element. On
 * Windows a `\\` or a `:` is refused too, as `filepath.Localize` of Go does.
 */
function validFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
): [string, string | Uint8Array][] {
  const entries = Object.entries(files);
  for (const [file] of entries) {
    const elements = file.split('/');
    const valid =
      elements.every((part) => part !== '' && part !== '.' && part !== '..') &&
      !(process.platform === 'win32' && /[\\:]/.test(file));
    if (!valid)
      throw Object.assign(
        new TypeError(
          `The path ${JSON.stringify(file)} of files is not a valid path inside the folder`,
        ),
        { code: 'ERR_INVALID_ARG_VALUE' },
      );
  }
  return entries;
}
