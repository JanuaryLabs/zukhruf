import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { posix } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { ContainerProcess } from './container-process.ts';
import type * as EngineApi from './engine-api.ts';
import {
  type EngineClient,
  type EngineResponse,
  isSuccess,
  parseBody,
} from './engine-client.ts';
import {
  BindSourceNotFoundError,
  ContainerNotFoundError,
  ContainerNotRunningError,
  ContainerRunningError,
  DockerEngineError,
  DockerError,
  ImageNotFoundError,
  NameConflictError,
  NetworkNotFoundError,
  NotAFileError,
  PathNotFoundError,
  ReadOnlyPathError,
} from './errors.ts';
import type { Images } from './images.ts';
import { type OutputChunk, outputChunks } from './multiplexed-stream.ts';
import type { CancelOptions, Filters } from './options.ts';
import { type ExecResult, type Output, readOutput } from './output.ts';
import { tarEntries } from './tar-reader.ts';
import { type TarWriterEntry, tarArchive } from './tar-writer.ts';

/** A file or a directory for writeFiles(). It belongs to uid:gid, or to 0:0. */
export type ContainerFile =
  | {
      path: string;
      data: string | Uint8Array;
      mode?: number;
      uid?: number;
      gid?: number;
    }
  | {
      path: string;
      directory: true;
      mode?: number;
      uid?: number;
      gid?: number;
    };

/** The path stat in the header of an archive answer: base64 of JSON. */
function pathStat(
  headers: IncomingHttpHeaders,
): EngineApi.ContainerPathStat | undefined {
  const header = headers['x-docker-container-path-stat'];
  if (typeof header !== 'string') return undefined;
  const stat: EngineApi.ContainerPathStat = JSON.parse(
    Buffer.from(header, 'base64').toString('utf8'),
  );
  return stat;
}

/** The deepest directory that holds each of the paths. */
function commonDirectory(paths: string[]): string {
  const [first = [], ...rest] = paths.map((path) =>
    path.split('/').filter(Boolean),
  );
  const common: string[] = [];
  for (const [index, part] of first.entries()) {
    if (!rest.every((other) => other[index] === part)) break;
    common.push(part);
  }
  return `/${common.join('/')}`;
}

/** True when the directory is in a read-only mount, or on a read-only root filesystem outside each mount. */
function isReadOnly(
  container: EngineApi.ContainerInspectResponse,
  directory: string,
): boolean {
  const holding = (container.Mounts ?? [])
    .filter(({ Destination }) => {
      if (Destination === undefined) return false;
      return (
        directory === Destination ||
        directory.startsWith(
          Destination.endsWith('/') ? Destination : `${Destination}/`,
        )
      );
    })
    .toSorted(
      (left, right) =>
        (right.Destination?.length ?? 0) - (left.Destination?.length ?? 0),
    )[0];
  if (holding !== undefined) return holding.RW === false;
  return container.HostConfig?.ReadonlyRootfs === true;
}

async function* bytesOf(response: IncomingMessage): AsyncGenerator<Uint8Array> {
  for await (const chunk of response) {
    if (chunk instanceof Uint8Array) yield chunk;
  }
}

/** The query of the logs, as the Engine API takes it. */
export interface LogQuery {
  tail?: number | 'all';
  /** Seconds since the Unix epoch. */
  since?: number;
  timestamps?: boolean;
}

/** The time between two inspects of an exec whose output ended while the engine still reports it running. */
const EXEC_EXIT_DELAY_MS = 10;

/** The result of createOrGet(): an owned handle when this call created the resource. */
export type Created<Key extends string, Owned, Found> =
  | ({ created: true } & Record<Key, Owned>)
  | ({ created: false } & Record<Key, Found>);

/** The time between two tries of createOrGet() while the name is taken but an inspect does not find it. */
const NAME_RACE_DELAY_MS = 20;

/** The fixed text of Moby for a missing bind source: errBindSourceDoesNotExist in daemon/volume/mounts/validate.go. */
const BIND_SOURCE_NOT_FOUND = /bind source path does not exist: (.+)$/;

/**
 * The BindSourceNotFoundError of an answer, or the DockerEngineError. The
 * engine gives a missing bind source the status of each bad parameter, so
 * only its text tells it apart.
 */
function bindSourceOr(error: DockerEngineError): DockerEngineError {
  const source = BIND_SOURCE_NOT_FOUND.exec(error.message)?.[1];
  if (source === undefined) return error;
  return new BindSourceNotFoundError(
    error.message,
    { status: error.status, method: error.method, path: error.path },
    source,
    { cause: error },
  );
}

/** The address of the loopback interface of the same family, for an address that binds each interface. */
function reachableHost(hostIp: string | undefined): string {
  if (hostIp === undefined || hostIp === '' || hostIp === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (hostIp === '::') return '::1';
  return hostIp;
}

/** The network modes that name no network of the caller. */
const PREDEFINED_NETWORK_MODES = new Set(['default', 'bridge', 'host', 'none']);

/**
 * The names of the networks of a container: its network mode, when it names a
 * network, and each network of its endpoints.
 */
function networksOf(container: EngineApi.ContainerInspectResponse): string[] {
  const mode = container.HostConfig?.NetworkMode;
  const networks = new Set<string>();
  if (
    mode !== undefined &&
    mode !== '' &&
    !PREDEFINED_NETWORK_MODES.has(mode) &&
    !mode.startsWith('container:')
  ) {
    networks.add(mode);
  }
  for (const name of Object.keys(container.NetworkSettings?.Networks ?? {})) {
    networks.add(name);
  }
  return [...networks];
}

/** A container, by the ID that the engine gave it. It has no disposal. */
export class Container {
  readonly id: string;
  readonly #client: EngineClient;

  constructor(client: EngineClient, id: string) {
    this.#client = client;
    this.id = id;
  }

  get #path(): string {
    return `/containers/${encodeURIComponent(this.id)}`;
  }

  async inspect(
    options: CancelOptions = {},
  ): Promise<EngineApi.ContainerInspectResponse> {
    const method = 'GET';
    const path = `${this.#path}/json`;
    const response = await this.#client.exchange(method, path, options);
    this.#throwUnless(response, method, path);
    return parseBody<EngineApi.ContainerInspectResponse>(response);
  }

  /**
   * Resolves for 304 (already running). A 404 is a missing container or a
   * missing network: an inspect of the container tells which, and a lookup of
   * each of its networks names the missing one. An engine in swarm mode
   * answers a missing network with 500 ("Could not attach to network", probed
   * at API 1.51), so a 500 gets the same lookup.
   */
  async start(options: CancelOptions = {}): Promise<void> {
    const { signal } = options;
    const method = 'POST';
    const path = `${this.#path}/start`;
    const response = await this.#client.exchange(method, path, { signal });
    if (response.status === 304 || isSuccess(response)) return;
    const error = this.#client.error(response, method, path);
    if (response.status !== 404 && response.status !== 500) {
      throw bindSourceOr(error);
    }
    const inspect = await this.#client.exchange('GET', `${this.#path}/json`, {
      signal,
    });
    if (inspect.status === 404 && response.status === 404) {
      this.#throwUnless(response, method, path);
    }
    if (!isSuccess(inspect)) throw bindSourceOr(error);
    const container = parseBody<EngineApi.ContainerInspectResponse>(inspect);
    for (const network of networksOf(container)) {
      const lookup = await this.#client.exchange(
        'GET',
        `/networks/${encodeURIComponent(network)}`,
        { signal },
      );
      if (lookup.status === 404) {
        throw new NetworkNotFoundError(
          error.message,
          { status: response.status, method, path },
          network,
          { cause: error },
        );
      }
    }
    throw bindSourceOr(error);
  }

  /** Resolves for 304 (already stopped). t: seconds before the engine kills the main process. */
  async stop(options: CancelOptions & { t?: number } = {}): Promise<void> {
    const method = 'POST';
    const path = `${this.#path}/stop`;
    const response = await this.#client.exchange(method, path, {
      query: { t: options.t },
      signal: options.signal,
    });
    if (response.status === 304) return;
    this.#throwUnless(response, method, path);
  }

  async restart(options: CancelOptions & { t?: number } = {}): Promise<void> {
    await this.#post('restart', { t: options.t }, options);
  }

  /** A 409 means that the container does not run: an inspect gives its state. */
  async kill(
    processSignal = 'SIGKILL',
    options: CancelOptions = {},
  ): Promise<void> {
    const method = 'POST';
    const path = `${this.#path}/kill`;
    const response = await this.#client.exchange(method, path, {
      query: { signal: processSignal },
      signal: options.signal,
    });
    if (response.status === 409) {
      throw await this.#notRunning(
        this.#client.error(response, method, path),
        options,
      );
    }
    this.#throwUnless(response, method, path);
  }

  async pause(options: CancelOptions = {}): Promise<void> {
    await this.#post('pause', {}, options);
  }

  async unpause(options: CancelOptions = {}): Promise<void> {
    await this.#post('unpause', {}, options);
  }

  async wait(
    options: CancelOptions & {
      condition?: 'not-running' | 'next-exit' | 'removed';
    } = {},
  ): Promise<EngineApi.ContainerWaitResponse> {
    const method = 'POST';
    const path = `${this.#path}/wait`;
    const response = await this.#client.exchange(method, path, {
      query: { condition: options.condition },
      signal: options.signal,
    });
    this.#throwUnless(response, method, path);
    return parseBody<EngineApi.ContainerWaitResponse>(response);
  }

  /**
   * Resolves for 404. A 409 is a removal that is already in progress, or,
   * without `force`, a container that runs: an inspect tells which. For a
   * removal in progress, it waits until the container is gone. A container
   * that runs or is paused rejects with ContainerRunningError. The engine
   * gives the state 'running' while it kills the container for a forced
   * removal, so with `force` the state alone does not tell: it waits.
   */
  async remove(
    options: CancelOptions & { force?: boolean; v?: boolean } = {},
  ): Promise<void> {
    const { force, signal } = options;
    const method = 'DELETE';
    const path = this.#path;
    const response = await this.#client.exchange(method, path, {
      query: { force, v: options.v },
      signal,
    });
    if (isSuccess(response) || response.status === 404) return;
    const error = this.#client.error(response, method, path);
    if (response.status !== 409) throw error;
    const inspect = await this.#client.exchange('GET', `${path}/json`, {
      signal,
    });
    if (inspect.status === 404) return;
    const state = parseBody<EngineApi.ContainerInspectResponse>(inspect).State;
    const runs = state?.Running === true || state?.Paused === true;
    if (force !== true && runs) {
      throw new ContainerRunningError(
        error.message,
        { status: 409, method, path },
        this.id,
        { cause: error },
      );
    }
    const gone = await this.#client.exchange('POST', `${path}/wait`, {
      query: { condition: 'removed' },
      signal,
    });
    if (isSuccess(gone) || gone.status === 404) return;
    throw error;
  }

  /** The published binding of a port of the container; undefined when it is not published. The IPv4 binding comes first. */
  async port(
    containerPort: number,
    protocol: 'tcp' | 'udp' = 'tcp',
    options: CancelOptions = {},
  ): Promise<{ host: string; port: number } | undefined> {
    const { NetworkSettings } = await this.inspect(options);
    const bindings = (
      NetworkSettings?.Ports?.[`${containerPort}/${protocol}`] ?? []
    ).filter((binding) => binding.HostPort);
    const binding =
      bindings.find((each) => !each.HostIp?.includes(':')) ?? bindings[0];
    if (binding === undefined) return undefined;
    return {
      host: reachableHost(binding.HostIp),
      port: Number(binding.HostPort),
    };
  }

  /** The logs until now. */
  async logs(options: CancelOptions & LogQuery = {}): Promise<Output> {
    return readOutput(this.#logs(false, options));
  }

  /** The logs as the container writes them. The iteration ends when the container stops. */
  followLogs(
    options: CancelOptions & LogQuery = {},
  ): AsyncIterable<OutputChunk> {
    return this.#logs(true, options);
  }

  async *#logs(
    follow: boolean,
    options: CancelOptions & LogQuery,
  ): AsyncGenerator<OutputChunk> {
    const { signal, tail, since, timestamps } = options;
    const method = 'GET';
    const path = `${this.#path}/logs`;
    const response = await this.#client
      .stream(method, path, {
        query: {
          stdout: 1,
          stderr: 1,
          follow: follow ? 1 : 0,
          tail,
          since,
          timestamps,
        },
        signal,
      })
      .catch((error: unknown) => {
        throw this.#notFoundOr(error, method, path);
      });
    yield* outputChunks(response, response.headers['content-type'] ?? '');
  }

  /** Runs a command in the container and reads its output to the end. stdin is sent, and then the input ends. */
  async exec(
    body: EngineApi.ExecConfig,
    options: CancelOptions & { stdin?: string | Uint8Array } = {},
  ): Promise<ExecResult> {
    const { stdin, signal } = options;
    const process = await this.spawn(body, {
      ...options,
      stdin: stdin !== undefined,
    });
    const input = process.stdin;
    if (input === undefined || stdin === undefined) return process.collect();
    const bytes =
      typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin;
    const writing = (async () => {
      const writer = input.getWriter();
      await writer.write(bytes);
      await writer.close();
    })();
    const [result] = await Promise.all([process.collect(), writing]);
    return result;
  }

  /** Runs a command in the container and gives its container process while it runs. */
  async spawn(
    body: EngineApi.ExecConfig,
    options: CancelOptions & { stdin?: boolean } = {},
  ): Promise<ContainerProcess> {
    const { signal } = options;
    const stdin = options.stdin === true;
    const method = 'POST';
    const path = `${this.#path}/exec`;
    const created = await this.#client.exchange(method, path, {
      body: {
        ...body,
        AttachStdin: stdin,
        AttachStdout: true,
        AttachStderr: true,
      },
      signal,
    });
    if (created.status === 409) {
      throw await this.#notRunning(
        this.#client.error(created, method, path),
        options,
      );
    }
    this.#throwUnless(created, method, path);
    const { Id } = parseBody<{ Id: string }>(created);
    const exec = `/exec/${encodeURIComponent(Id)}`;
    const connection = await this.#client.hijack('POST', `${exec}/start`, {
      body: { Detach: false, Tty: body.Tty ?? false },
      signal,
    });
    return new ContainerProcess(connection, {
      stdin,
      signal,
      exitCode: async (outputEnded) => {
        await outputEnded;
        for (;;) {
          const inspect =
            await this.#client.json<EngineApi.ExecInspectResponse>(
              'GET',
              `${exec}/json`,
              { signal },
            );
          if (!inspect.Running && inspect.ExitCode !== null) {
            return inspect.ExitCode;
          }
          await setTimeout(EXEC_EXIT_DELAY_MS, undefined, { signal });
        }
      },
    });
  }

  /**
   * Attaches to the output of the container. For a created container, the
   * exit code is the code of its next exit, so attach before start(). For a
   * running container, it is the code when the container stops. An exited or
   * a paused container rejects with ContainerNotRunningError: Moby gives no
   * 409 for an attach to an exited container, so the state of an inspect
   * decides.
   */
  async attach(
    options: CancelOptions & { stdin?: boolean } = {},
  ): Promise<ContainerProcess> {
    const { signal } = options;
    const stdin = options.stdin === true;
    const method = 'POST';
    const path = `${this.#path}/attach`;
    const state = (await this.inspect(options)).State?.Status ?? '';
    if (state !== 'created' && state !== 'running') {
      throw new ContainerNotRunningError(
        `The container ${this.id} is ${state}.`,
        { status: undefined, method, path },
        this.id,
        state,
      );
    }
    // The engine sends the headers of a wait when the wait is in place, so a
    // start() after attach() resolves cannot pass before it.
    const waiting = await this.#client
      .stream('POST', `${this.#path}/wait`, {
        query: { condition: state === 'created' ? 'next-exit' : 'not-running' },
        signal,
      })
      .catch((error: unknown) => {
        throw this.#notFoundOr(error, 'POST', `${this.#path}/wait`);
      });
    const connection = await this.#client
      .hijack(method, path, {
        query: { stream: 1, stdout: 1, stderr: 1, stdin: stdin ? 1 : 0 },
        signal,
      })
      .catch(async (error: unknown) => {
        waiting.destroy();
        if (error instanceof DockerEngineError && error.status === 409) {
          throw await this.#notRunning(error, options);
        }
        throw this.#notFoundOr(error, method, path);
      });
    return new ContainerProcess(connection, {
      stdin,
      signal,
      exitCode: async (outputEnded) => {
        outputEnded.catch(() => waiting.destroy());
        const chunks: Buffer[] = [];
        for await (const chunk of waiting) chunks.push(Buffer.from(chunk));
        const answer: EngineApi.ContainerWaitResponse = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        return answer.StatusCode;
      },
    });
  }

  /** The path stat of a path in the container: HEAD of the archive. undefined for 404 when the container exists. */
  async stat(
    path: string,
    options: CancelOptions = {},
  ): Promise<EngineApi.ContainerPathStat | undefined> {
    const method = 'HEAD';
    const requestPath = `${this.#path}/archive`;
    const response = await this.#client.exchange(method, requestPath, {
      query: { path },
      signal: options.signal,
    });
    const request = { status: response.status, method, path: requestPath };
    // An answer to HEAD has no body, so the message is written here.
    const message = `The engine answered ${response.status} to the stat of ${path} in the container ${this.id}.`;
    if (response.status === 404) {
      const error = await this.#fileNotFound(
        new DockerEngineError(message, request),
        path,
        options,
      );
      if (error instanceof PathNotFoundError) return undefined;
      throw error;
    }
    const stat = isSuccess(response) ? pathStat(response.headers) : undefined;
    if (stat === undefined) throw new DockerEngineError(message, request);
    return stat;
  }

  /** The bytes of one regular file. A directory, a link and each other kind of entry reject with NotAFileError. */
  async readFile(
    path: string,
    options: CancelOptions = {},
  ): Promise<Uint8Array> {
    const method = 'GET';
    const requestPath = `${this.#path}/archive`;
    const response = await this.#archive(path, options);
    // The first entry of the archive is the path itself, so a directory fails before its tree comes.
    for await (const entry of tarEntries(bytesOf(response))) {
      if (entry.type === 'file') return entry.data;
      throw new NotAFileError(
        `${path} in the container ${this.id} is a ${entry.type}, not a regular file.`,
        { status: response.statusCode, method, path: requestPath },
        this.id,
        path,
        entry.type,
      );
    }
    throw new DockerError(
      `The archive of ${path} in the container ${this.id} has no entry.`,
    );
  }

  /**
   * Sends one archive of the files. It extracts the archive in the deepest
   * directory that holds each entry and that exists, which stat() finds. The
   * engine creates each parent directory that an entry implies below it.
   */
  async writeFiles(
    files: ContainerFile[],
    options: CancelOptions = {},
  ): Promise<void> {
    if (files.length === 0) return;
    const mtime = Math.floor(Date.now() / 1000);
    const absolute = files.map((file) => ({
      file,
      path: posix.resolve('/', file.path),
    }));
    let directory = commonDirectory(
      absolute.map(({ path }) => posix.dirname(path)),
    );
    while (
      directory !== '/' &&
      (await this.stat(directory, options)) === undefined
    ) {
      directory = posix.dirname(directory);
    }
    const entries = absolute.map(({ file, path }): TarWriterEntry => {
      const isDirectory = 'directory' in file;
      return {
        path: posix.relative(directory, path),
        type: isDirectory ? 'directory' : 'file',
        data: isDirectory
          ? new Uint8Array(0)
          : typeof file.data === 'string'
            ? new TextEncoder().encode(file.data)
            : file.data,
        mode: file.mode ?? (isDirectory ? 0o755 : 0o644),
        uid: file.uid ?? 0,
        gid: file.gid ?? 0,
        mtime,
      };
    });
    await this.putArchive(directory, tarArchive(entries), options);
  }

  /** The tar stream of a path in the container: a file, or a directory with its tree. */
  async getArchive(
    path: string,
    options: CancelOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    return ReadableStream.from(bytesOf(await this.#archive(path, options)));
  }

  /**
   * Extracts a tar archive in a directory of the container. With copyUIDGID,
   * each entry belongs to the user of the container (Config.User), not to
   * the owner in the archive.
   */
  async putArchive(
    directory: string,
    archive: ReadableStream<Uint8Array> | Uint8Array,
    options: CancelOptions & { copyUIDGID?: boolean } = {},
  ): Promise<void> {
    const { signal } = options;
    const method = 'PUT';
    const requestPath = `${this.#path}/archive`;
    const response = await this.#client.exchange(method, requestPath, {
      query: {
        path: directory,
        copyUIDGID: options.copyUIDGID === true ? 1 : undefined,
      },
      content: { type: 'application/x-tar', data: archive },
      signal,
    });
    if (isSuccess(response)) return;
    const error = this.#client.error(response, method, requestPath);
    if (response.status === 404) {
      throw await this.#fileNotFound(error, directory, options);
    }
    // Moby answers a refused extraction with 400; the reference says 403.
    if (response.status !== 400 && response.status !== 403) throw error;
    const inspect = await this.#client.exchange('GET', `${this.#path}/json`, {
      signal,
    });
    if (inspect.status === 404) {
      throw new ContainerNotFoundError(error.message, error, this.id, {
        cause: error,
      });
    }
    if (
      isSuccess(inspect) &&
      isReadOnly(
        parseBody<EngineApi.ContainerInspectResponse>(inspect),
        directory,
      )
    ) {
      throw new ReadOnlyPathError(error.message, error, this.id, directory, {
        cause: error,
      });
    }
    throw error;
  }

  /** The answer of GET of the archive of a path, with 404 as ContainerNotFoundError or PathNotFoundError. */
  async #archive(
    path: string,
    options: CancelOptions,
  ): Promise<IncomingMessage> {
    try {
      return await this.#client.stream('GET', `${this.#path}/archive`, {
        query: { path },
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof DockerEngineError && error.status === 404) {
        throw await this.#fileNotFound(error, path, options);
      }
      throw error;
    }
  }

  /** A 404 of a file request: an inspect tells a missing container from a missing path. */
  async #fileNotFound(
    error: DockerEngineError,
    path: string,
    options: CancelOptions,
  ): Promise<DockerEngineError> {
    const inspect = await this.#client.exchange('GET', `${this.#path}/json`, {
      signal: options.signal,
    });
    const request = { status: 404, method: error.method, path: error.path };
    if (inspect.status === 404) {
      return new ContainerNotFoundError(error.message, request, this.id, {
        cause: error,
      });
    }
    return new PathNotFoundError(error.message, request, this.id, path, {
      cause: error,
    });
  }

  /** A DockerEngineError with 404 as a ContainerNotFoundError; each other error as it is. */
  #notFoundOr(error: unknown, method: string, path: string): unknown {
    if (!(error instanceof DockerEngineError) || error.status !== 404) {
      return error;
    }
    return new ContainerNotFoundError(
      error.message,
      { status: 404, method, path },
      this.id,
      { cause: error },
    );
  }

  /** The ContainerNotRunningError of a 409, with the state of an inspect. */
  async #notRunning(
    error: DockerEngineError,
    options: CancelOptions,
  ): Promise<ContainerNotRunningError> {
    const state = (await this.inspect(options)).State?.Status ?? '';
    const { method, path } = error;
    return new ContainerNotRunningError(
      error.message,
      { status: 409, method, path },
      this.id,
      state,
      { cause: error },
    );
  }

  async #post(
    action: string,
    query: Record<string, number | undefined>,
    options: CancelOptions,
  ): Promise<void> {
    const method = 'POST';
    const path = `${this.#path}/${action}`;
    const response = await this.#client.exchange(method, path, {
      query,
      signal: options.signal,
    });
    this.#throwUnless(response, method, path);
  }

  /** A 2xx passes; a 404 is a ContainerNotFoundError; each other status is a DockerEngineError. */
  #throwUnless(response: EngineResponse, method: string, path: string): void {
    if (isSuccess(response)) return;
    const error = this.#client.error(response, method, path);
    if (response.status === 404) {
      throw new ContainerNotFoundError(
        error.message,
        { status: 404, method, path },
        this.id,
        { cause: error },
      );
    }
    throw error;
  }
}

/** A container that this handle created. Disposal removes it with its anonymous volumes. */
export class OwnedContainer extends Container implements AsyncDisposable {
  /** remove({ force: true, v: true }) */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.remove({ force: true, v: true });
  }
}

/** The containers of one engine. */
export class Containers {
  readonly #client: EngineClient;
  readonly #images: Images;

  constructor(client: EngineClient, images: Images) {
    this.#client = client;
    this.#images = images;
  }

  async create(
    body: EngineApi.ContainerCreateRequest,
    options: CancelOptions & { name?: string; platform?: string } = {},
  ): Promise<OwnedContainer> {
    const { name, platform, signal } = options;
    const method = 'POST';
    const path = '/containers/create';
    const response = await this.#client.exchange(method, path, {
      query: { name, platform },
      body,
      signal,
    });
    if (isSuccess(response)) {
      const { Id } = parseBody<EngineApi.ContainerCreateResponse>(response);
      return new OwnedContainer(this.#client, Id);
    }
    const error = this.#client.error(response, method, path);
    const request = { status: response.status, method, path };
    if (response.status === 409 && name !== undefined) {
      throw new NameConflictError(error.message, request, 'container', name, {
        cause: error,
      });
    }
    if (response.status === 404 && body.Image !== undefined) {
      const image = await this.#images.inspect(body.Image, options);
      if (image === undefined) {
        throw new ImageNotFoundError(error.message, request, body.Image, {
          cause: error,
        });
      }
    }
    throw bindSourceOr(error);
  }

  /**
   * Creates the container, attaches to its output, starts it, waits for its
   * end, and removes it. A non-zero exit code is data. A failure and a cancel
   * also remove the container.
   */
  async run(
    body: EngineApi.ContainerCreateRequest,
    options: CancelOptions & { name?: string; platform?: string } = {},
  ): Promise<ExecResult> {
    const container = await this.create(body, options);
    try {
      const process = await container.attach(options);
      await container.start(options);
      return await process.collect();
    } finally {
      await container.remove({ force: true, v: true });
    }
  }

  /** Creates the container, or gives the one that has the name. The container that exists wins. */
  async createOrGet(
    body: EngineApi.ContainerCreateRequest,
    options: CancelOptions & { name: string; platform?: string },
  ): Promise<Created<'container', OwnedContainer, Container>> {
    const { signal } = options;
    for (;;) {
      try {
        return { created: true, container: await this.create(body, options) };
      } catch (error) {
        if (!(error instanceof NameConflictError)) throw error;
      }
      // A competing create reserves the name before an inspect finds it.
      const container = await this.find(options.name, options);
      if (container) return { created: false, container };
      await setTimeout(NAME_RACE_DELAY_MS, undefined, { signal });
    }
  }

  /** One inspect: a handle with the ID of the engine, or undefined for 404. */
  async find(
    nameOrId: string,
    options: CancelOptions = {},
  ): Promise<Container | undefined> {
    const method = 'GET';
    const path = `/containers/${encodeURIComponent(nameOrId)}/json`;
    const response = await this.#client.exchange(method, path, options);
    if (response.status === 404) return undefined;
    if (!isSuccess(response)) throw this.#client.error(response, method, path);
    const { Id } = parseBody<EngineApi.ContainerInspectResponse>(response);
    return new Container(this.#client, Id);
  }

  async list(
    options: CancelOptions & { all?: boolean; filters?: Filters } = {},
  ): Promise<EngineApi.ContainerSummary[]> {
    return this.#client.json<EngineApi.ContainerSummary[]>(
      'GET',
      '/containers/json',
      {
        query: { all: options.all, filters: options.filters },
        signal: options.signal,
      },
    );
  }
}
