import { hash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { type Socket, createServer } from 'node:net';
import { isAbsolute, win32 } from 'node:path';

import { PipeAddress } from './pipe-address.ts';
import { PipeServer, ownServer } from './pipe-server.ts';
import { UnsafeFolderError } from './unsafe-folder-error.ts';

export interface PipeEndpointOptions {
  /** Names the default folder, `/tmp/<prefix>-<uid>`, and starts each pipe name on Windows. */
  prefix: string;
}

/** An endpoint that this program owns: it may listen on it. Made from a name (a rooted name is the full path; any other name goes into /tmp/<prefix>-<uid>). */
export class PipeEndpoint {
  /** Where other programs connect; publish `address.path` for them. */
  readonly address: PipeAddress;
  readonly #placement: Placement;

  constructor(name: string, { prefix }: PipeEndpointOptions) {
    assertPlainName(prefix, 'prefix');
    if (!isAbsolute(name)) assertPlainName(name, 'name');
    this.#placement = placementOf(name, prefix);
    this.address = new PipeAddress(this.#placement.path);
  }

  /** Removes the file at the path (ADR 0003), listens, and resolves when listening. */
  async listen(
    connectionListener: (socket: Socket) => void,
  ): Promise<PipeServer> {
    await this.#placement.prepare();
    const server = createServer(connectionListener);
    try {
      server.listen(this.address.path);
      await once(server, 'listening');
    } catch (error) {
      server.close();
      throw error;
    }
    return PipeServer[ownServer](this, server);
  }
}

/** Where the path of an endpoint is, and what a listen does before it binds there. */
interface Placement {
  readonly path: string;
  prepare(): Promise<void>;
}

function placementOf(name: string, prefix: string): Placement {
  if (process.platform === 'win32') return new WindowsPipe(name, prefix);
  if (isAbsolute(name)) return new RootedSocket(name);
  return new DefaultFolderSocket(name, prefix);
}

/** A named pipe; Windows removes it when its program exits, so nothing is left to remove (ADR 0005). */
class WindowsPipe implements Placement {
  readonly path: string;

  constructor(name: string, prefix: string) {
    const id = isAbsolute(name)
      ? hash('sha256', win32.resolve(name).toLowerCase()).slice(0, 32)
      : name;
    this.path = `\\\\.\\pipe\\${prefix}-${id}`;
  }

  async prepare(): Promise<void> {}
}

/** The socket path is the rooted name as it is, in the caller's folder. */
class RootedSocket implements Placement {
  readonly path: string;

  constructor(path: string) {
    this.path = checkedSocketPath(path);
  }

  prepare(): Promise<void> {
    return rm(this.path, { force: true });
  }
}

/** The file `<name>` in `/tmp/<prefix>-<uid>`, a folder of this user only (ADR 0002). */
class DefaultFolderSocket implements Placement {
  readonly path: string;
  readonly #folder: string;
  readonly #uid: number;

  constructor(name: string, prefix: string) {
    this.#uid = process.getuid!();
    this.#folder = `/tmp/${prefix}-${this.#uid}`;
    this.path = checkedSocketPath(`${this.#folder}/${name}`);
  }

  async prepare(): Promise<void> {
    await mkdir(this.#folder, { mode: 0o700 }).catch((error: unknown) => {
      if (Reflect.get(Object(error), 'code') !== 'EEXIST') throw error;
    });
    const folder = await lstat(this.#folder);
    if (!folder.isDirectory()) {
      throw new UnsafeFolderError(this.#folder, 'is not a folder');
    }
    if (folder.uid !== this.#uid || (folder.mode & 0o077) !== 0) {
      throw new UnsafeFolderError(this.#folder, 'has unsafe permissions');
    }
    await rm(this.path, { force: true });
  }
}

/** One byte less than `sun_path`, for its ending zero byte, as .NET and Go (ADR 0004). */
const SOCKET_PATH_LIMIT = process.platform === 'linux' ? 107 : 103;

function checkedSocketPath(path: string): string {
  const bytes = Buffer.byteLength(path);
  if (bytes > SOCKET_PATH_LIMIT) {
    throw new RangeError(
      `The socket path ${path} is ${bytes} bytes, more than ${SOCKET_PATH_LIMIT}; choose a shorter folder or name.`,
    );
  }
  return path;
}

/** One file name: not empty, not `.` or `..`, with no `/`, no `\`, and no zero byte. */
function assertPlainName(value: string, role: 'name' | 'prefix'): void {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    /[/\\\0]/.test(value)
  ) {
    throw new TypeError(
      `The ${role} ${JSON.stringify(value)} is not one file name: it must not be empty, "." or "..", and must have no "/", no "\\" and no zero byte.`,
    );
  }
}
