import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

interface Blob {
  readonly mode: string;
  readonly object: string;
  readonly path: string;
}

// Writes the files of one commit into an empty folder, from the object store:
// `git ls-tree` names them and one `git cat-file --batch` gives their content.
// No filter applies (no autocrlf, no smudge, no LFS), and `export-ignore` does
// not apply. A submodule is not a file, so it is not written.
export async function writeCommitFiles(
  git: (...args: string[]) => Promise<string>,
  gitOptions: { cwd: string; env: NodeJS.ProcessEnv },
  sha: string,
  folder: string,
): Promise<void> {
  const blobs: Blob[] = (await git('ls-tree', '-r', '-z', '--full-tree', sha))
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode = '', type = '', object = ''] = line.slice(0, tab).split(' ');
      return { mode, type, object, path: line.slice(tab + 1) };
    })
    .filter(({ type }) => type === 'blob');

  const catFile = spawn('git', ['cat-file', '--batch'], {
    ...gitOptions,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(catFile, 'close');
  catFile.stdin.end(blobs.map(({ object }) => `${object}\n`).join(''));
  const records = new Records(catFile.stdout);
  const links: { blob: Blob; target: string }[] = [];
  for (const blob of blobs) {
    const header = (await records.line()).split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isInteger(size))
      throw new Error(
        `git cat-file gave "${header.join(' ')}" for ${blob.path}`,
      );
    const content = await records.bytes(size + 1);
    const path = join(folder, blob.path);
    await mkdir(dirname(path), { recursive: true });
    if (blob.mode === '120000')
      links.push({ blob, target: content.subarray(0, size).toString() });
    else {
      await writeFile(path, content.subarray(0, size));
      if (blob.mode === '100755') await chmod(path, 0o755);
    }
  }
  await exited;
  // The files come first: on Windows, a link becomes a junction when its
  // target is a folder of the commit, or else a text file that holds the
  // target, as git does with core.symlinks=false.
  for (const { blob, target } of links) {
    const path = join(folder, blob.path);
    if (process.platform !== 'win32') await symlink(target, path);
    else {
      const absolute = resolve(dirname(path), target);
      const isFolder = await stat(absolute).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      if (isFolder) await symlink(absolute, path, 'junction');
      else await writeFile(path, target);
    }
  }
}

// Reads the records of `git cat-file --batch`: a header line, then the
// content and a newline.
class Records {
  readonly #chunks: AsyncIterator<Buffer>;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.#chunks = stream[Symbol.asyncIterator]();
  }

  async line(): Promise<string> {
    let end = this.#buffer.indexOf(0x0a);
    while (end === -1) {
      this.#buffer = Buffer.concat([this.#buffer, await this.#next()]);
      end = this.#buffer.indexOf(0x0a);
    }
    const line = this.#buffer.subarray(0, end).toString();
    this.#buffer = this.#buffer.subarray(end + 1);
    return line;
  }

  async bytes(count: number): Promise<Buffer> {
    if (this.#buffer.length < count) {
      const parts: Buffer[] = [this.#buffer];
      let length = this.#buffer.length;
      while (length < count) {
        const chunk = await this.#next();
        parts.push(chunk);
        length += chunk.length;
      }
      this.#buffer = Buffer.concat(parts, length);
    }
    const bytes = this.#buffer.subarray(0, count);
    this.#buffer = this.#buffer.subarray(count);
    return bytes;
  }

  async #next(): Promise<Buffer> {
    const { done, value } = await this.#chunks.next();
    if (done === true)
      throw new Error('git cat-file ended before it gave each file');
    return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  }
}
