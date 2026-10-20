# @zukhruf/docker

> **Status: design for review.** This README is the API on paper. No code exists yet. The decisions are in [ADR 0001](./docs/adr/0001-the-client-speaks-the-engine-api-not-the-docker-cli.md) and [ADR 0002](./docs/adr/0002-the-engine-is-the-one-that-the-docker-cli-selects.md).

A client for the Docker Engine API on Node.js. It selects the engine that the Docker CLI selects, and it sends HTTP requests to that engine with `node:http`: through a Unix socket, a Windows named pipe, or SSH. It needs no Docker CLI on the `PATH`, and it has no dependencies. Thus a desktop app that starts from the macOS Dock can use it, and so can a test, a sandbox or a deploy tool.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Connect to the engine

`Docker.connect()` selects the engine in the order of the Docker CLI:

1. `DOCKER_HOST`.
2. `DOCKER_CONTEXT`.
3. `currentContext` in `config.json` of `DOCKER_CONFIG`, or of `~/.docker`.
4. The `default` context: `unix:///var/run/docker.sock`, or `npipe:////./pipe/docker_engine` on Windows.

Then it sends `GET /_ping` and negotiates the API version. Dispose the client to close its connections. An idle connection does not keep the process running.

```ts
import { Docker } from '@zukhruf/docker';

await using docker = await Docker.connect({
  signal: AbortSignal.timeout(5_000),
});
console.log(docker.context, docker.host, docker.apiVersion);
// desktop-linux unix:///Users/me/.docker/run/docker.sock 1.51
```

A client keeps its engine. To use another engine, connect again with a context name or a host. Then the client ignores `DOCKER_HOST` and `DOCKER_CONTEXT`:

```ts
await using remote = await Docker.connect({ context: 'limerence-dokploy' });
await using local = await Docker.connect({
  host: 'unix:///var/run/docker.sock',
});
```

The package accepts `unix://`, `npipe://` and `ssh://` hosts. It refuses `tcp://`, because an engine on TCP needs TLS files, and no consumer uses one.

## List the contexts

`Docker.contexts()` reads the context store and gives each context with its host. The `default` context is in the list too. `current` marks the context that `Docker.connect()` selects with no options.

```ts
const local = (await Docker.contexts()).filter(
  ({ host }) => !host.startsWith('ssh://'),
);
// [{ name: 'default', host: 'unix:///var/run/docker.sock', current: false },
//  { name: 'desktop-linux', host: 'unix:///Users/me/.docker/run/docker.sock', current: true }]
```

A product with its own rule selects from this list. For example, a scan for databases on this machine connects to each local context and skips SSH engines: a container's published port on an SSH engine is on another machine.

## Tell a connection failure from an error of the engine

The package gives two error classes:

- `ConnectionFailedError`: the engine did not accept the connection. Its socket does not exist, it refuses the connection, or `ssh` cannot log in. A stopped Docker Desktop leaves its socket file behind and refuses each connection. `host` names the engine, and `cause` is the error of the socket or of `ssh`.
- `DockerEngineError`: the engine answered with an error. `status` is the HTTP status, and `message` is the message of the engine.

```ts
import { ConnectionFailedError, Docker } from '@zukhruf/docker';

try {
  await using docker = await Docker.connect({ context: 'desktop-linux' });
  return await docker.containers.list();
} catch (error) {
  if (error instanceof ConnectionFailedError) return [];
  throw error;
}
```

Some answers of the engine are not errors here:

| Call                                                            | Engine answer | Result      |
| --------------------------------------------------------------- | ------------- | ----------- |
| `containers.inspect()`, `volumes.inspect()`, `images.inspect()` | 404           | `undefined` |
| `container.start()` of a running container                      | 304           | resolves    |
| `container.stop()` of a stopped container                       | 304           | resolves    |
| `container.remove()`, `volume.remove()` of a missing one        | 404           | resolves    |

Other answers reject with `DockerEngineError`. For example, `containers.create()` with a name that another container has rejects with status 409, and `volume.remove()` of a volume in use rejects with status 409.

## Start a container

The first argument of a request is the body that the [Engine API reference](https://docs.docker.com/reference/api/engine/) documents, with its field names. The second argument holds what the client adds: the query, such as `name`, and a `signal`. The types of the bodies are in the type namespace `EngineApi`, with the names of the reference.

`containers.create()` gives a handle. Disposal of the handle removes the container with its anonymous volumes.

```ts
await using postgres = await docker.containers.create(
  {
    Image: 'postgres:18',
    Env: ['POSTGRES_PASSWORD=postgres'],
    Labels: { 'com.example.owner': 'tests' },
    ExposedPorts: { '5432/tcp': {} },
    HostConfig: {
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Memory: 1024 ** 3,
    },
  },
  { name: 'example-postgres' },
);
await postgres.start();
const published = await postgres.port(5432);
// { host: '127.0.0.1', port: 55012 }
```

`container.port()` reads the binding of the container's port from an inspect. It gives `undefined` when the port is not published. An address that binds each interface (`0.0.0.0`, `::` or empty) gives the loopback address of the same family. On an SSH engine, the port is on the remote machine. `@zukhruf/testing` forwards it to this machine.

## Find a container

`containers.inspect()` sends one request and gives `undefined` for a missing container. `containers.get()` sends no request: it gives a handle for a name or an ID, and a later call on a missing container rejects with status 404. `containers.list()` takes the `filters` of the Engine API.

```ts
const state = await docker.containers.inspect('example-postgres');
if (state?.State?.Running === false)
  await docker.containers.get(state.Id).start();

const owned = await docker.containers.list({
  all: true,
  filters: { label: ['com.example.owner=tests'] },
});
```

## Run a container to its end

`containers.run()` creates the container, attaches to its output, starts it, waits for its end, and removes it. It gives the exit code and the output. A non-zero exit code is data, not an error. A cancel through the signal also removes the container.

```ts
const { exitCode, stdout } = await docker.containers.run(
  {
    Image: 'alpine:3',
    Cmd: ['sh', '-c', 'uname -m'],
    WorkingDir: '/work',
    HostConfig: { Binds: [`${process.cwd()}:/work:ro`] },
  },
  { signal: AbortSignal.timeout(60_000) },
);
```

For output while the container runs, use `container.attach()` before `container.start()`:

```ts
import { Writable } from 'node:stream';

await using build = await docker.containers.create({
  Image: 'node:lts-alpine',
  Cmd: ['npm', 'test'],
  WorkingDir: '/app',
  HostConfig: { Binds: [`${process.cwd()}:/app`] },
});
const output = await build.attach();
await build.start();
await Promise.all([
  output.stdout.pipeTo(Writable.toWeb(process.stdout)),
  output.stderr.pipeTo(Writable.toWeb(process.stderr)),
]);
if ((await output.exitCode) !== 0) throw new Error('The tests failed');
```

## Run a command in a container

`container.exec()` runs a command next to the main process of a running container. It gives the exit code, standard output, standard error, and `output`, the two in the order of the engine. The package does not remove the last newline.

```ts
const result = await postgres.exec({
  Cmd: ['psql', '-U', 'postgres', '-tAc', 'select 1'],
  Env: ['PGCONNECT_TIMEOUT=5'],
});
// { exitCode: 0, stdout: '1\n', stderr: '', output: '1\n' }
```

`stdin` sends input to the command. The package closes the write side of the hijacked connection after the input, so the command reads the end of its input:

```ts
import { readFile } from 'node:fs/promises';

const bytes = await readFile('report.bin');
await postgres.exec(
  { Cmd: ['sh', '-c', 'cat > /tmp/report.bin'] },
  { stdin: bytes },
);
```

The close depends on the host:

- On a Unix socket, the package shuts down the write side of the socket.
- Over SSH, the package closes the standard input of `ssh`. Then `docker system dial-stdio` closes the write side to the engine.
- On a Windows named pipe, the package writes a message of zero bytes. A pipe has no shutdown of one side, and `end()` of Node.js only flushes it. The engine listens on its pipe in message mode, and it reads a message of zero bytes as the end of the input. `CloseWrite` of go-winio, which the Docker CLI uses, sends the same message.

`container.spawn()` gives the streams of the command while it runs, as a container process. With `stdin: true`, the container process has a writable `stdin`. Close it to end the input.

```ts
const tail = await postgres.spawn({
  Cmd: ['tail', '-f', '/var/lib/postgresql/data/log/postgresql.log'],
});
for await (const chunk of tail.stdout) process.stdout.write(chunk);
```

A signal cancels the wait. It does not stop the command: the Engine API has no request that stops an exec. To stop a command, kill the container, or run the command under `timeout` in the container.

A container with a TTY (`Tty: true`) gives a raw stream. Then all output is on `stdout`, and `stderr` is empty.

## Read the logs

`container.logs()` gives standard output, standard error and `output`, as `exec()` does. It takes the query of the Engine API: `tail`, `since` and `timestamps`.

```ts
const { output } = await postgres.logs({ tail: 50 });
```

## Stop, kill, wait, remove

```ts
await postgres.stop({ t: 10 }); // SIGTERM, then SIGKILL after 10 seconds
await postgres.kill('SIGINT');
const { StatusCode } = await postgres.wait({ condition: 'not-running' });
await postgres.remove({ force: true, v: true });
```

## Volumes

`volumes.create()` gives a handle. Disposal of the handle removes the volume. The engine gives the volume a name when the body has none.

```ts
await using data = await docker.volumes.create({
  Name: 'example-data',
  Labels: { 'com.example.owner': 'tests' },
});
await docker.containers.run({
  Image: 'alpine:3',
  Cmd: ['touch', '/data/ready'],
  HostConfig: {
    Mounts: [{ Type: 'volume', Source: data.name, Target: '/data' }],
  },
});
```

`volumes.inspect()`, `volumes.get()` and `volumes.list()` work as they do for containers.

## Images

```ts
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';

if (!(await docker.images.inspect('alpine:3')))
  await docker.images.pull('alpine:3', { platform: 'linux/amd64' });

const archive = await docker.images.save(['alpine:3']);
await archive.pipeTo(Writable.toWeb(createWriteStream('alpine.tar')));
```

`images.pull()` reads the progress of the engine until the end. It rejects with `DockerEngineError` when the engine reports an error in the progress. Then `status` is `undefined`, because the HTTP status was 200. A pull sends no registry credentials, so it pulls public images only.

## Send the Docker CLI to the same engine

Image builds and Compose stay with the Docker CLI. `docker.cliEnvironment` gives the variables that send the CLI to the engine of the client, whatever context is current:

```ts
import spawn from 'nano-spawn';

await spawn(
  'docker',
  ['buildx', 'build', '--platform', 'linux/amd64', '-t', 'app', '.'],
  { env: docker.cliEnvironment },
);
// docker.cliEnvironment is { DOCKER_HOST: docker.host, DOCKER_CONTEXT: undefined }
```

## SSH engines

For an `ssh://` host, the connection helper is `ssh -T -o BatchMode=yes <machine> docker system dial-stdio`, as the Docker CLI uses it. `ssh` reads `~/.ssh/config`, so jump hosts, keys, agents and connection sharing work as they work for the CLI. The remote machine must have `docker` on the `PATH` of its SSH shell.

Each connection of the client is one `ssh` process. The client keeps idle connections for the next request. An attach and an exec each use their own connection, because the engine hijacks it. Disposal of the client ends the `ssh` processes.

## The API version

The path of each request starts with the API version, as in `/v1.51/containers/json`. `Docker.connect()` reads the highest version of the engine from `GET /_ping`. The client then uses the lower of that version and its own highest version. It refuses an engine that is older than its own lowest version. `docker.apiVersion` gives the version that the client uses.

## What the package does not do

Each of these gets a request in the package when a consumer needs it, together with that consumer:

- Image builds and Compose. Use the CLI with `docker.cliEnvironment`.
- Engines on TCP, and TLS.
- Registry credentials and credential helpers.
- Networks, events, and copies of files in and out of a container (`/containers/{id}/archive`).
- Logs that follow a running container.
- A selection of the engine by its own rule. `Docker.contexts()` gives the list, and the product chooses.

## The same concepts in other systems

| Concept                     | Other systems                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A client of the Engine API  | [moby/moby/client](https://github.com/moby/moby/tree/master/client) (Go), [bollard](https://github.com/fussybeaver/bollard) (Rust), [dockerode](https://github.com/apocas/dockerode) (Node.js) |
| The selection of the engine | `resolveContextName` of [docker/cli](https://github.com/docker/cli/blob/master/cli/command/cli.go); the master branch of bollard                                                               |
| Fixed socket paths          | The client strategies of Testcontainers, and docker-modem. They do not read contexts.                                                                                                          |
| The connection helper       | [connhelper of docker/cli](https://github.com/docker/cli/blob/master/cli/connhelper/connhelper.go)                                                                                             |
| The multiplexed stream      | "Stream format" in the Engine API reference; `stdcopy.StdCopy` of Moby; `demuxStream` of docker-modem                                                                                          |
| Errors by HTTP status       | `errdefs` of Moby: `NotFound` for 404, `Conflict` for 409, `NotModified` for 304                                                                                                               |
| API version negotiation     | The Go client of Moby, which negotiates by default                                                                                                                                             |

## API

```ts
export class Docker implements AsyncDisposable {
  /** Selects the engine in the order of the Docker CLI, pings it and negotiates the API version. */
  static connect(options?: ConnectOptions): Promise<Docker>;
  /** Each context of the context store, and the default context. */
  static contexts(): Promise<DockerContext[]>;

  /** The context that selected the engine: 'default' for DOCKER_HOST or a host option. */
  readonly context: string;
  readonly host: string;
  readonly apiVersion: string;
  /** Sends the Docker CLI to this engine: { DOCKER_HOST, DOCKER_CONTEXT: undefined }. */
  readonly cliEnvironment: Readonly<Record<string, string | undefined>>;
  readonly containers: Containers;
  readonly volumes: Volumes;
  readonly images: Images;

  info(options?: Signal): Promise<EngineApi.SystemInfo>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** A context or a host, never both. */
export type ConnectOptions = Signal &
  ({ context?: string; host?: never } | { host?: string; context?: never });

export interface DockerContext {
  name: string;
  host: string;
  /** The context that connect() selects with no options. */
  current: boolean;
}

export interface Signal {
  /** Cancels the wait for the engine. */
  signal?: AbortSignal;
}

export interface Containers {
  create(
    body: EngineApi.ContainerCreateRequest,
    options?: Signal & { name?: string; platform?: string },
  ): Promise<Container>;
  /** Create, attach, start, wait, remove. A cancel also removes the container. */
  run(
    body: EngineApi.ContainerCreateRequest,
    options?: Signal & { name?: string; platform?: string },
  ): Promise<ExecResult>;
  /** No request: a handle for a name or an ID. */
  get(nameOrId: string): Container;
  /** undefined for 404. */
  inspect(
    nameOrId: string,
    options?: Signal,
  ): Promise<EngineApi.ContainerInspectResponse | undefined>;
  list(
    options?: Signal & { all?: boolean; filters?: Record<string, string[]> },
  ): Promise<EngineApi.ContainerSummary[]>;
}

export class Container implements AsyncDisposable {
  /** The ID that the engine gave, or the name or ID that get() took. */
  readonly id: string;
  inspect(options?: Signal): Promise<EngineApi.ContainerInspectResponse>;
  /** Resolves for 304 (already running). */
  start(options?: Signal): Promise<void>;
  /** Resolves for 304 (already stopped). t: seconds before SIGKILL. */
  stop(options?: Signal & { t?: number }): Promise<void>;
  kill(
    processSignal?: string /* default 'SIGKILL' */,
    options?: Signal,
  ): Promise<void>;
  wait(
    options?: Signal & { condition?: 'not-running' | 'next-exit' | 'removed' },
  ): Promise<EngineApi.ContainerWaitResponse>;
  /** Resolves for 404. */
  remove(options?: Signal & { force?: boolean; v?: boolean }): Promise<void>;
  /** The published binding of a port of the container; undefined when it is not published. */
  port(
    containerPort: number,
    protocol?: 'tcp' | 'udp',
    options?: Signal,
  ): Promise<{ host: string; port: number } | undefined>;
  logs(
    options?: Signal & {
      tail?: number | 'all';
      since?: number;
      timestamps?: boolean;
    },
  ): Promise<Output>;
  exec(
    body: EngineApi.ExecConfig,
    options?: Signal & { stdin?: string | Uint8Array },
  ): Promise<ExecResult>;
  spawn(
    body: EngineApi.ExecConfig,
    options?: Signal & { stdin?: boolean },
  ): Promise<ContainerProcess>;
  /** Attach before start() to get all output. */
  attach(options?: Signal & { stdin?: boolean }): Promise<ContainerProcess>;
  /** remove({ force: true, v: true }) */
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Output {
  stdout: string;
  stderr: string;
  /** Standard output and standard error, in the order of the engine. */
  output: string;
}

export interface ExecResult extends Output {
  exitCode: number;
}

/** The streams of an exec or of an attached container. */
export interface ContainerProcess {
  /** Present with { stdin: true }. Close it to end the input. */
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  /** Empty for a container or an exec with a TTY. */
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exitCode: Promise<number>;
}

export interface Volumes {
  create(
    body?: EngineApi.VolumeCreateOptions,
    options?: Signal,
  ): Promise<Volume>;
  get(name: string): Volume;
  /** undefined for 404. */
  inspect(
    name: string,
    options?: Signal,
  ): Promise<EngineApi.Volume | undefined>;
  list(
    options?: Signal & { filters?: Record<string, string[]> },
  ): Promise<EngineApi.Volume[]>;
}

export class Volume implements AsyncDisposable {
  readonly name: string;
  /** Resolves for 404. Rejects with status 409 while a container uses the volume. */
  remove(options?: Signal & { force?: boolean }): Promise<void>;
  /** remove() */
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Images {
  /** undefined for 404. */
  inspect(
    reference: string,
    options?: Signal,
  ): Promise<EngineApi.ImageInspect | undefined>;
  /** Public images only: the pull sends no credentials. */
  pull(
    reference: string,
    options?: Signal & { platform?: string },
  ): Promise<void>;
  /** A tar archive of the images, as `docker save` writes it. */
  save(
    references: string[],
    options?: Signal,
  ): Promise<ReadableStream<Uint8Array>>;
}

export class ConnectionFailedError extends Error {
  readonly host: string;
}

export class DockerEngineError extends Error {
  /** The HTTP status; undefined for an error in the progress of a pull. */
  readonly status: number | undefined;
  readonly method: string;
  readonly path: string;
}

/** The bodies and answers of the Engine API, with the names of its reference. Types only. */
export type * as EngineApi from './engine-api.ts';
```

The table below maps each call to its request of the Engine API:

| Call                                                              | Request                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Docker.connect()`                                                | `GET /_ping`                                                                            |
| `docker.info()`                                                   | `GET /info`                                                                             |
| `containers.create()`                                             | `POST /containers/create`                                                               |
| `containers.run()`                                                | `create`, `attach`, `start`, `wait`, `DELETE /containers/{id}`                          |
| `containers.inspect()`, `container.inspect()`, `container.port()` | `GET /containers/{id}/json`                                                             |
| `containers.list()`                                               | `GET /containers/json`                                                                  |
| `container.start()`, `stop()`, `kill()`, `wait()`                 | `POST /containers/{id}/start`, `/stop`, `/kill`, `/wait`                                |
| `container.remove()`                                              | `DELETE /containers/{id}`                                                               |
| `container.logs()`                                                | `GET /containers/{id}/logs`                                                             |
| `container.attach()`                                              | `POST /containers/{id}/attach` (hijacked)                                               |
| `container.exec()`, `container.spawn()`                           | `POST /containers/{id}/exec`, `POST /exec/{id}/start` (hijacked), `GET /exec/{id}/json` |
| `volumes.create()`, `inspect()`, `list()`, `volume.remove()`      | `POST /volumes/create`, `GET /volumes/{name}`, `GET /volumes`, `DELETE /volumes/{name}` |
| `images.inspect()`, `pull()`, `save()`                            | `GET /images/{name}/json`, `POST /images/create`, `GET /images/get`                     |

## Who uses each part

The consumers below come from the search of 2026-10-20. Each part ships with its first consumer.

| Consumer                                 | Uses                                                                                                  | Backlog             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| `@zukhruf/testing/docker`                | connect, create, run, inspect, list, start, kill, remove, port, exec, logs, volumes, `cliEnvironment` | #2752               |
| text2sql finders                         | contexts, connect, list, inspect, `ConnectionFailedError`                                             | #2754               |
| text2sql desktop tests                   | images inspect, pull, save                                                                            | #2756               |
| text2sql artifacts volume adapter        | inspect, start, exec with `stdin`, spawn                                                              | #2757               |
| `@deepagents/context` sandbox            | create, start, stop, inspect, exec, spawn, volumes, images inspect, `cliEnvironment`                  | #2760               |
| `@deepagents/toolbox`, `convert-to-gguf` | exec, run                                                                                             | #2761               |
| sdk-it `e2e/docker.ts`                   | create, attach, start                                                                                 | #2764               |
| finetuning, april, serverize             | create, start, port, logs, inspect, remove, exec                                                      | #2765, #2766, #2769 |
