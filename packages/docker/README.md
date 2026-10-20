# @zukhruf/docker

> **Status: design for review.** This README is the API on paper. No code exists yet. The decisions are in the [ADRs](./docs/adr/). The package leads, and the repositories that use Docker change to fit it ([ADR 0003](./docs/adr/0003-the-package-leads-and-the-repositories-change.md)).

A client for the Docker Engine API on Node.js. It selects the engine that the Docker CLI selects, and it sends HTTP requests to that engine with `node:http`: through a Unix socket, a Windows named pipe, or SSH. It needs no Docker CLI on the `PATH`, and it has no dependencies. Thus a desktop app that starts from the macOS Dock can use it, and so can a test, a sandbox or a deploy tool.

The package covers the containers of one engine and the resources around them: their images, volumes, networks, files, processes, output and events.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Connect to the engine

`Docker.connect()` selects the engine in the order of the Docker CLI ([ADR 0002](./docs/adr/0002-the-engine-is-the-one-that-the-docker-cli-selects.md)):

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

The package accepts `unix://`, `npipe://` and `ssh://` hosts. It refuses `tcp://` ([ADR 0003](./docs/adr/0003-the-package-leads-and-the-repositories-change.md) gives the reason).

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

## Catch the errors that change what you do next

An error has its own class when a caller does something different after it: start the engine, pull the image, start the container, pick another name ([ADR 0007](./docs/adr/0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md)). Each class comes from the request and its HTTP status. When one status has two meanings, the package sends one more request to tell them apart.

| Class                      | When                                                                                                                                          | What the caller does next                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ConnectionFailedError`    | The socket does not exist, the engine refuses the connection, or `ssh` cannot log in                                                          | Treat the engine as absent, or ask to start Docker |
| `UnsupportedEngineError`   | The engine's highest API version is lower than the lowest one that the package supports                                                       | Ask to update Docker                               |
| `UnsupportedHostError`     | The host is not `unix://`, `npipe://` or `ssh://`, for example `tcp://`                                                                       | Skip that context, or give another host            |
| `ContextNotFoundError`     | `Docker.connect({ context })` names a context that the context store does not have                                                            | Pick another context from `Docker.contexts()`      |
| `ContainerNotFoundError`   | A request about a container gets 404                                                                                                          | Create the container again                         |
| `ContainerNotRunningError` | An exec or a kill gets 409, or an attach finds the container exited or paused. `state` comes from an inspect: `created`, `exited`, `paused` … | Start or unpause it, then try again                |
| `NameConflictError`        | A create of a container, network or volume finds the name taken                                                                               | Use `createOrGet()`, or another name               |
| `ImageNotFoundError`       | A create gets 404 and the image is not on the engine; a pull or a push gets 404                                                               | Pull or build the image; check the name or `auth`  |
| `NetworkNotFoundError`     | A create gets 404 and the image is on the engine; a request about a network gets 404                                                          | Create the network first                           |
| `VolumeNotFoundError`      | A request about a volume gets 404                                                                                                             | Create the volume again                            |
| `BindSourceNotFoundError`  | A create or a start refuses a bind mount whose `source` does not exist on the engine's host                                                   | Tell the user which host path is missing           |
| `VolumeInUseError`         | A volume removal gets 409                                                                                                                     | Remove its containers first, or wait and try again |
| `NetworkInUseError`        | A network removal gets 403 while containers are connected                                                                                     | Disconnect them first                              |
| `ImageInUseError`          | An image removal gets 409                                                                                                                     | Remove its containers first, or use `force`        |
| `PathNotFoundError`        | A file request gets 404 and the container exists                                                                                              | Use a default, or create the file                  |
| `NotAFileError`            | `readFile()` finds a directory, a link or another kind of entry. `kind` names it                                                              | Use `getArchive()` for the tree                    |
| `ReadOnlyPathError`        | The engine refuses an extraction, and an inspect shows that the directory is on a read-only root filesystem or in a read-only mount           | Write under a writable mount, or use `exec()`      |

Each class extends a base class, so a broad catch still works. `DockerError` is the base of every error of the package. `DockerEngineError` is the base of every answer of the engine that is an error. It has `status`, `method` and `path`, and its `message` is the message of the engine. An error with no class of its own, such as an error in the progress of a pull, is a `DockerEngineError`.

```ts
import {
  ConnectionFailedError,
  ContainerNotRunningError,
  Docker,
  ImageNotFoundError,
} from '@zukhruf/docker';

try {
  await using docker = await Docker.connect({ context: 'desktop-linux' });
  return await docker.containers.list();
} catch (error) {
  if (error instanceof ConnectionFailedError) return [];
  throw error;
}

const create = () => docker.containers.create({ Image: 'postgres:18' });
await using postgres = await create().catch(async (error) => {
  if (!(error instanceof ImageNotFoundError)) throw error;
  await docker.images.pull('postgres:18');
  return create();
});

await postgres.exec({ Cmd: ['pg_isready'] }).catch(async (error) => {
  if (!(error instanceof ContainerNotRunningError)) throw error;
  if (error.state === 'paused') await postgres.unpause();
  else await postgres.start();
  return postgres.exec({ Cmd: ['pg_isready'] });
});
```

Some answers of the engine are not errors here:

| Call                                                                            | Engine answer | Result      |
| ------------------------------------------------------------------------------- | ------------- | ----------- |
| `containers.find()`, `volumes.find()`, `networks.find()`, `images.inspect()`    | 404           | `undefined` |
| `container.stat()` of a missing path, when the container exists                 | 404           | `undefined` |
| `container.start()` of a running container, `container.stop()` of a stopped one | 304           | resolves    |
| `remove()` of a missing container, volume, network or image                     | 404           | resolves    |

A removal of a container whose removal is already in progress (409) waits until the container is gone, and then resolves.

## Create a container that you own

The first argument of a request is the body that the [Engine API reference](https://docs.docker.com/reference/api/engine/) documents, with its field names. The second argument holds what the client adds: the query, such as `name`, and a `signal`. The types of the bodies are in the type namespace `EngineApi`, with the names of the reference.

`containers.create()` gives an `OwnedContainer`. Disposal of an owned container removes it with its anonymous volumes ([ADR 0004](./docs/adr/0004-a-handle-owns-its-container-only-when-it-created-it.md)).

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

`containers.find()` sends one inspect. It gives a `Container` with the ID of the engine, or `undefined`. A `Container` names its container by that ID, never by a name: when another container takes the name later, the handle still acts on the first one. A `Container` has no disposal, so `await using` on it is a type error. A found container belongs to whoever created it.

```ts
const db = await docker.containers.find('shared-db');
if (db && !(await db.inspect()).State?.Running) await db.start();

const owned = await docker.containers.list({
  all: true,
  filters: { label: ['com.example.owner=tests'] },
});
```

## Create a container, or get the one that has the name

`containers.createOrGet()` creates the container. When another container has the name, it gives that container. It handles the 409 of the engine and the short time in which the name is taken but an inspect does not find it yet.

The container that exists wins: the package does not compare its configuration. A product that needs the same configuration compares it itself, for example with a label that holds a fingerprint.

```ts
const result = await docker.containers.createOrGet(
  { Image: 'postgres:18', Env: ['POSTGRES_PASSWORD=postgres'] },
  { name: 'shared-db' },
);
if (result.created) console.log('created', result.container.id);
await result.container.start();
// result.created === true:  result.container is an OwnedContainer
// result.created === false: result.container is a Container
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

For output while the container runs, attach before the start. A container process is one stream of chunks, in the order of the engine. Each chunk names its stream ([ADR 0005](./docs/adr/0005-output-is-one-stream-of-chunks-and-only-a-close-ends-the-input.md)):

```ts
await using tests = await docker.containers.create({
  Image: 'node:lts-alpine',
  Cmd: ['npm', 'test'],
  WorkingDir: '/app',
  HostConfig: { Binds: [`${process.cwd()}:/app`] },
});
const output = await tests.attach();
await tests.start();
for await (const { stream, data } of output) {
  (stream === 'stdout' ? process.stdout : process.stderr).write(data);
}
if ((await output.exitCode) !== 0) throw new Error('The tests failed');
```

`attach()` reads the state of the container first. For a created container, the exit code is the code of its next exit, so attach before `start()`. For a running container, it is the code when the container stops. An exited or a paused container makes `attach()` reject with `ContainerNotRunningError`.

## Run a command in a container

`container.exec()` runs a command next to the main process of a running container. It gives the exit code, standard output, standard error, and `output`, the two in the order of the engine. The package does not remove the last newline.

```ts
const result = await postgres.exec({
  Cmd: ['psql', '-U', 'postgres', '-tAc', 'select 1'],
  Env: ['PGCONNECT_TIMEOUT=5'],
});
// { exitCode: 0, stdout: '1\n', stderr: '', output: '1\n' }
```

`stdin` sends input to the command, and the package then ends the input:

```ts
await postgres.exec(
  { Cmd: ['psql', '-U', 'postgres'] },
  { stdin: 'create table notes (body text);' },
);
```

`container.spawn()` gives the container process while the command runs. With `stdin: true`, the container process has a writable `stdin`. Only `stdin.close()` ends the input. The package drops an empty write, so an empty write never ends the input.

```ts
const psql = await postgres.spawn(
  { Cmd: ['psql', '-U', 'postgres', '-tA'] },
  { stdin: true },
);
const input = psql.stdin!.getWriter();
await input.write(new TextEncoder().encode('select now();\n'));
await input.close();
const { stdout } = await psql.collect();
```

The end of the input depends on the host. On a Unix socket, the package shuts down the write side of the socket. Over SSH, it closes the standard input of `ssh`, and `docker system dial-stdio` then closes the write side to the engine. On a Windows named pipe, it writes a message of zero bytes, because a pipe has no shutdown of one side: the engine listens on its pipe in message mode and reads that message as the end. `CloseWrite` of go-winio, which the Docker CLI uses, sends the same message.

A signal cancels the wait. It does not stop the command: the Engine API has no request that stops an exec. To stop a command, kill the container, or run the command under `timeout` in the container. A signal also cancels an iteration of a container process: the iteration rejects with the reason of the signal, as each cancel does ([the async glossary](../async/CONTEXT.md)).

A container or an exec with a TTY (`Tty: true`) gives a raw stream. Then each chunk is `stdout`.

## Read the logs

`container.logs()` gives the logs until now: standard output, standard error and `output`, as `exec()` does. `container.followLogs()` gives chunks as the container writes them. The iteration ends when the container stops. When the signal aborts first, the iteration rejects with the reason of the signal. Both take the query of the Engine API: `tail`, `since` and `timestamps`.

```ts
const { output } = await postgres.logs({ tail: 50 });

for await (const { data } of postgres.followLogs({
  signal: AbortSignal.timeout(30_000),
})) {
  if (new TextDecoder().decode(data).includes('ready to accept connections'))
    break;
}
```

## Read and write files

The package moves files through the archive requests of the engine, not through exec ([ADR 0006](./docs/adr/0006-files-move-through-the-archive-requests-not-through-exec.md)). Thus the requests work on a stopped container, and on an image with no shell.

```ts
await postgres.writeFiles([
  {
    path: '/docker-entrypoint-initdb.d/schema.sql',
    data: 'create table notes (body text);',
  },
  {
    path: '/srv/run.sh',
    data: '#!/bin/sh\npg_isready\n',
    mode: 0o755,
    uid: 999,
    gid: 999,
  },
  { path: '/srv/cache', directory: true },
]);

const config = await postgres.readFile(
  '/var/lib/postgresql/data/postgresql.conf',
);
const stat = await postgres.stat('/srv/run.sh');
// { name: 'run.sh', size: 120, mode: 493, mtime: '…', linkTarget: '' }
```

- `writeFiles()` sends one archive. It extracts the archive in the deepest directory that holds each entry and that already exists, which it finds with `stat()`. The engine creates each parent directory that an entry implies below that directory. Thus a container with a read-only root filesystem can still get files in a writable volume: the engine checks only the directory of the extraction.
- A written entry belongs to its `uid` and `gid`, or to root (0:0) when it has none. The package puts them in the archive, and the engine keeps the owner of each entry in the archive.
- `putArchive(directory, archive, { copyUIDGID: true })` gives each extracted entry to the user of the container (`Config.User`) in place of the owner in the archive.
- `readFile()` gives the bytes of one regular file. A missing path makes it reject with `PathNotFoundError`, and a directory, a link or another kind of entry with `NotAFileError`.
- `stat()` gives `undefined` for a missing path. A missing container makes each file request reject with `ContainerNotFoundError`.
- `getArchive(path)` and `putArchive(directory, archive)` give the tar streams themselves, for a directory or a large tree.
- The engine cannot reach `/proc`, `/sys`, `/dev`, a tmpfs mount, or a mount made inside the container. For such a path, use `exec()`.
- When the directory of the extraction is on a read-only root filesystem or in a read-only mount, `writeFiles()` and `putArchive()` reject with `ReadOnlyPathError`.

## Control a container

```ts
await postgres.stop({ t: 10 }); // SIGTERM, then the engine sends SIGKILL after 10 seconds
await postgres.restart({ t: 10 });
await postgres.kill('SIGINT');
await postgres.pause();
await postgres.unpause();
const { StatusCode } = await postgres.wait({ condition: 'not-running' });
await postgres.remove({ force: true, v: true });
```

`stop()` and `restart()` keep the meaning of the engine: after `t` seconds, the engine kills the main process.

## Volumes

`volumes.create()` gives an `OwnedVolume`. Disposal of an owned volume removes it. A volume has no ID, so its name names it.

```ts
await using data = await docker.volumes.create({
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

The engine gives the volume a name when the body has none. The Engine API answers a create with a taken name with the existing volume, not with an error. Thus the package adds a creation label with a random value, and it compares the label of the answer: `volumes.create()` rejects with `NameConflictError` for a taken name, and `volumes.createOrGet()` gives `{ created: false, volume }`. `volumes.find()` and `volumes.list()` work as they do for containers.

## Networks

`networks.create()` gives an `OwnedNetwork`. Disposal removes the network. `networks.find()`, `networks.createOrGet()` and `networks.list()` work as they do for containers.

```ts
await using network = await docker.networks.create({ Name: 'example-net' });
await network.connect(postgres, { Aliases: ['db'] });
await network.disconnect(postgres);
```

## Images

Images have no owner: an image is a cache that each container on the engine shares, so no handle removes one on disposal.

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';

if (!(await docker.images.inspect('alpine:3')))
  await docker.images.pull('alpine:3', { platform: 'linux/amd64' });

const ghcr = {
  username: 'me',
  password: process.env.GHCR_TOKEN!,
  serveraddress: 'ghcr.io',
};
await docker.images.pull('ghcr.io/example/private:1', { auth: ghcr });
await docker.images.tag('app:1', 'ghcr.io/example/app:1');
await docker.images.push('ghcr.io/example/app:1', { auth: ghcr });

const archive = await docker.images.save(['alpine:3']);
await archive.pipeTo(Writable.toWeb(createWriteStream('alpine.tar')));
await docker.images.load(Readable.toWeb(createReadStream('alpine.tar')));
await docker.images.remove('alpine:3');
```

`pull()`, `push()` and `load()` read the progress of the engine until the end. They reject with `DockerEngineError` when the engine reports an error in the progress. Then `status` is `undefined`, because the HTTP status was 200. `auth` holds explicit credentials. The package runs no credential helper, because a helper is a program on the `PATH`.

## Events

`docker.events()` gives the events of the engine as they happen. The iteration ends only when the signal aborts, and then it rejects with the reason of the signal. It takes the `since` and `filters` of the Engine API.

```ts
for await (const event of docker.events({
  filters: { container: [postgres.id], event: ['health_status'] },
  signal: AbortSignal.timeout(60_000),
})) {
  if (event.Action === 'health_status: healthy') break;
}
```

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

Each connection of the client is one `ssh` process. The client keeps idle connections for the next request. An attach, an exec, followed logs and events each use their own connection. Disposal of the client ends the `ssh` processes.

## The API version

The path of each request starts with the API version, as in `/v1.51/containers/json`. `Docker.connect()` reads the highest version of the engine from `GET /_ping`. The client then uses the lower of that version and its own highest version. It refuses an engine that is older than its own lowest version with `UnsupportedEngineError`. `docker.apiVersion` gives the version that the client uses.

The lowest version is 1.44. From that version on, "`POST /networks/create` with a duplicated name now fails systematically" ([Engine API version history](https://docs.docker.com/reference/api/engine/version-history/)), and `networks.createOrGet()` needs that refusal. The highest version is the highest one that the tests of the package run on.

## What the package does not do

[ADR 0003](./docs/adr/0003-the-package-leads-and-the-repositories-change.md) gives the reason for each:

- Image builds and Compose. Use the CLI with `docker.cliEnvironment`.
- Engines on TCP.
- Credential helpers. Give `auth` instead.
- A stop or a time limit for one exec.
- The output of an exec after a detach.
- Swarm: services, tasks, nodes, secrets and configs.

## The same concepts in other systems

| Concept                     | Other systems                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A client of the Engine API  | [moby/moby/client](https://github.com/moby/moby/tree/master/client) (Go), [bollard](https://github.com/fussybeaver/bollard) (Rust), [dockerode](https://github.com/apocas/dockerode) (Node.js) |
| The selection of the engine | `resolveContextName` of [docker/cli](https://github.com/docker/cli/blob/master/cli/command/cli.go); the master branch of bollard                                                               |
| Fixed socket paths          | The client strategies of Testcontainers, and docker-modem. They do not read contexts.                                                                                                          |
| The connection helper       | [connhelper of docker/cli](https://github.com/docker/cli/blob/master/cli/connhelper/connhelper.go)                                                                                             |
| An owned handle             | `ownsLifecycle` of microsandbox, which stops a sandbox on disposal only when the handle owns it                                                                                                |
| A handle by its ID          | The stable `id` of a microsandbox handle, which refuses to act on a replacement that reused the name                                                                                           |
| Create, or get by name      | `connectOrCreate` of microsandbox: the existing sandbox wins                                                                                                                                   |
| One stream of chunks        | `ExecEvent` of microsandbox; "Stream format" in the Engine API reference; `stdcopy.StdCopy` of Moby                                                                                            |
| Files through archives      | `docker cp`; `copyFilesToContainer` of Testcontainers; `fs()` of microsandbox                                                                                                                  |
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
  readonly networks: Networks;
  readonly images: Images;

  info(options?: CancelOptions): Promise<EngineApi.SystemInfo>;
  /** The events of the engine as they happen. An abort of the signal rejects the iteration with its reason. */
  events(
    options?: CancelOptions & { since?: number; filters?: Filters },
  ): AsyncIterable<EngineApi.EventMessage>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** A context or a host, never both. */
export type ConnectOptions = CancelOptions &
  ({ context?: string; host?: never } | { host?: string; context?: never });

export interface DockerContext {
  name: string;
  host: string;
  /** The context that connect() selects with no options. */
  current: boolean;
}

export interface CancelOptions {
  /** Cancels the wait for the engine. */
  signal?: AbortSignal;
}

/** The filters of a list or of the events, as the Engine API takes them. */
export type Filters = Record<string, string[]>;

/** The result of createOrGet(): an owned handle when this call created the resource. */
export type Created<Key extends string, Owned, Found> =
  | ({ created: true } & Record<Key, Owned>)
  | ({ created: false } & Record<Key, Found>);

export interface Containers {
  create(
    body: EngineApi.ContainerCreateRequest,
    options?: CancelOptions & { name?: string; platform?: string },
  ): Promise<OwnedContainer>;
  /** Creates the container, or gives the one that has the name. The container that exists wins. */
  createOrGet(
    body: EngineApi.ContainerCreateRequest,
    options: CancelOptions & { name: string; platform?: string },
  ): Promise<Created<'container', OwnedContainer, Container>>;
  /** Create, attach, start, wait, remove. A cancel also removes the container. */
  run(
    body: EngineApi.ContainerCreateRequest,
    options?: CancelOptions & { name?: string; platform?: string },
  ): Promise<ExecResult>;
  /** One inspect: a handle with the ID of the engine, or undefined for 404. */
  find(
    nameOrId: string,
    options?: CancelOptions,
  ): Promise<Container | undefined>;
  list(
    options?: CancelOptions & { all?: boolean; filters?: Filters },
  ): Promise<EngineApi.ContainerSummary[]>;
}

/** A container, by the ID that the engine gave it. It has no disposal. */
export class Container {
  readonly id: string;
  inspect(options?: CancelOptions): Promise<EngineApi.ContainerInspectResponse>;
  /** Resolves for 304 (already running). */
  start(options?: CancelOptions): Promise<void>;
  /** Resolves for 304 (already stopped). t: seconds before the engine kills the main process. */
  stop(options?: CancelOptions & { t?: number }): Promise<void>;
  restart(options?: CancelOptions & { t?: number }): Promise<void>;
  kill(
    processSignal?: string /* default 'SIGKILL' */,
    options?: CancelOptions,
  ): Promise<void>;
  pause(options?: CancelOptions): Promise<void>;
  unpause(options?: CancelOptions): Promise<void>;
  wait(
    options?: CancelOptions & {
      condition?: 'not-running' | 'next-exit' | 'removed';
    },
  ): Promise<EngineApi.ContainerWaitResponse>;
  /** Resolves for 404. */
  remove(
    options?: CancelOptions & { force?: boolean; v?: boolean },
  ): Promise<void>;
  /** The published binding of a port of the container; undefined when it is not published. */
  port(
    containerPort: number,
    protocol?: 'tcp' | 'udp',
    options?: CancelOptions,
  ): Promise<{ host: string; port: number } | undefined>;

  logs(options?: CancelOptions & LogQuery): Promise<Output>;
  followLogs(options?: CancelOptions & LogQuery): AsyncIterable<OutputChunk>;
  exec(
    body: EngineApi.ExecConfig,
    options?: CancelOptions & { stdin?: string | Uint8Array },
  ): Promise<ExecResult>;
  spawn(
    body: EngineApi.ExecConfig,
    options?: CancelOptions & { stdin?: boolean },
  ): Promise<ContainerProcess>;
  /** Attach before start() to get all output. */
  attach(
    options?: CancelOptions & { stdin?: boolean },
  ): Promise<ContainerProcess>;

  /** undefined for 404. */
  stat(
    path: string,
    options?: CancelOptions,
  ): Promise<EngineApi.ContainerPathStat | undefined>;
  /** The bytes of one regular file. */
  readFile(path: string, options?: CancelOptions): Promise<Uint8Array>;
  /** One archive, extracted at '/'. */
  writeFiles(files: ContainerFile[], options?: CancelOptions): Promise<void>;
  getArchive(
    path: string,
    options?: CancelOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  putArchive(
    directory: string,
    archive: ReadableStream<Uint8Array> | Uint8Array,
    options?: CancelOptions & { copyUIDGID?: boolean },
  ): Promise<void>;
}

/** A container that this handle created. Disposal removes it with its anonymous volumes. */
export class OwnedContainer extends Container implements AsyncDisposable {
  /** remove({ force: true, v: true }) */
  [Symbol.asyncDispose](): Promise<void>;
}

export interface LogQuery {
  tail?: number | 'all';
  since?: number;
  timestamps?: boolean;
}

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

export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  data: Uint8Array;
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

/** The output of an exec or of an attached container: chunks in the order of the engine, given once. */
export interface ContainerProcess extends AsyncIterable<OutputChunk> {
  /** Present with { stdin: true }. Only close() ends the input; an empty write is dropped. */
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly exitCode: Promise<number>;
  /** Reads each chunk and gives the result. */
  collect(): Promise<ExecResult>;
}

export interface Volumes {
  /** Rejects with NameConflictError when the name is taken. */
  create(
    body?: EngineApi.VolumeCreateRequest,
    options?: CancelOptions,
  ): Promise<OwnedVolume>;
  createOrGet(
    body: EngineApi.VolumeCreateRequest & { Name: string },
    options?: CancelOptions,
  ): Promise<Created<'volume', OwnedVolume, Volume>>;
  find(name: string, options?: CancelOptions): Promise<Volume | undefined>;
  list(
    options?: CancelOptions & { filters?: Filters },
  ): Promise<EngineApi.Volume[]>;
}

export class Volume {
  readonly name: string;
  inspect(options?: CancelOptions): Promise<EngineApi.Volume>;
  /** Resolves for 404. Rejects with VolumeInUseError while a container uses the volume. */
  remove(options?: CancelOptions & { force?: boolean }): Promise<void>;
}

export class OwnedVolume extends Volume implements AsyncDisposable {
  /** remove() */
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Networks {
  create(
    body: EngineApi.NetworkCreateRequest,
    options?: CancelOptions,
  ): Promise<OwnedNetwork>;
  createOrGet(
    body: EngineApi.NetworkCreateRequest,
    options?: CancelOptions,
  ): Promise<Created<'network', OwnedNetwork, Network>>;
  find(nameOrId: string, options?: CancelOptions): Promise<Network | undefined>;
  list(
    options?: CancelOptions & { filters?: Filters },
  ): Promise<EngineApi.NetworkSummary[]>;
}

export class Network {
  readonly id: string;
  inspect(options?: CancelOptions): Promise<EngineApi.NetworkInspect>;
  connect(
    container: Container,
    endpoint?: EngineApi.NetworkConnectRequest['EndpointConfig'],
    options?: CancelOptions,
  ): Promise<void>;
  disconnect(
    container: Container,
    options?: CancelOptions & { force?: boolean },
  ): Promise<void>;
  /** Resolves for 404. */
  remove(options?: CancelOptions): Promise<void>;
}

export class OwnedNetwork extends Network implements AsyncDisposable {
  /** remove() */
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Images {
  /** undefined for 404. */
  inspect(
    reference: string,
    options?: CancelOptions,
  ): Promise<EngineApi.ImageInspect | undefined>;
  list(
    options?: CancelOptions & { all?: boolean; filters?: Filters },
  ): Promise<EngineApi.ImageSummary[]>;
  pull(
    reference: string,
    options?: CancelOptions & {
      platform?: string;
      auth?: EngineApi.AuthConfig;
    },
  ): Promise<void>;
  /** Gives the image a second name, such as a registry name before a push. target: 'repository:tag'. */
  tag(
    reference: string,
    target: string,
    options?: CancelOptions,
  ): Promise<void>;
  push(
    reference: string,
    options: CancelOptions & { auth: EngineApi.AuthConfig },
  ): Promise<void>;
  /** A tar archive of the images, as `docker save` writes it. */
  save(
    references: string[],
    options?: CancelOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  load(
    archive: ReadableStream<Uint8Array> | Uint8Array,
    options?: CancelOptions,
  ): Promise<void>;
  /** Resolves for 404. */
  remove(
    reference: string,
    options?: CancelOptions & { force?: boolean; noprune?: boolean },
  ): Promise<void>;
}

/** The base of every error of the package. */
export class DockerError extends Error {}

export class ConnectionFailedError extends DockerError {
  readonly host: string;
}

export class UnsupportedHostError extends DockerError {
  readonly host: string;
}

export class ContextNotFoundError extends DockerError {
  readonly context: string;
}

export class UnsupportedEngineError extends DockerError {
  readonly host: string;
  /** The highest API version of the engine. */
  readonly engineVersion: string;
  /** The lowest API version that the package supports. */
  readonly minimumVersion: string;
}

/** The base of every answer of the engine that is an error. */
export class DockerEngineError extends DockerError {
  /** The HTTP status; undefined for an error in the progress of a pull, a push or a load. */
  readonly status: number | undefined;
  readonly method: string;
  readonly path: string;
}

export class ContainerNotFoundError extends DockerEngineError {
  readonly container: string;
}
export class ContainerNotRunningError extends DockerEngineError {
  readonly container: string;
  /** From an inspect after the 409: 'created', 'exited', 'paused', 'restarting', 'removing' or 'dead'. */
  readonly state: string;
}
export class NameConflictError extends DockerEngineError {
  readonly kind: 'container' | 'network' | 'volume';
  readonly name: string;
}
export class ImageNotFoundError extends DockerEngineError {
  readonly image: string;
}
export class NetworkNotFoundError extends DockerEngineError {
  readonly network: string;
}
export class VolumeNotFoundError extends DockerEngineError {
  readonly volume: string;
}
export class BindSourceNotFoundError extends DockerEngineError {
  /** The path on the engine's host. */
  readonly source: string;
}
export class VolumeInUseError extends DockerEngineError {
  readonly volume: string;
}
export class NetworkInUseError extends DockerEngineError {
  readonly network: string;
  /** The IDs of the connected containers, from an inspect after the 403. */
  readonly containers: string[];
}
export class ImageInUseError extends DockerEngineError {
  readonly image: string;
}
export class PathNotFoundError extends DockerEngineError {
  readonly container: string;
  readonly path: string;
}
export class NotAFileError extends DockerEngineError {
  readonly container: string;
  readonly path: string;
  /** The kind of the entry: 'directory', 'symlink', 'link' or 'other'. */
  readonly kind: 'directory' | 'symlink' | 'link' | 'other';
}
export class ReadOnlyPathError extends DockerEngineError {
  readonly container: string;
  readonly path: string;
}

/** The bodies and answers of the Engine API, with the names of its reference. Types only. */
export type * as EngineApi from './engine-api.ts';
```

`EngineApi.ContainerCreateRequest` is the body of `POST /containers/create`: `ContainerConfig` with `HostConfig` and `NetworkingConfig`, as `container.CreateRequest` of Moby names it. `EngineApi.ContainerPathStat` is the JSON of the header `X-Docker-Container-Path-Stat`, as `container.PathStat` of Moby names it.

Each call sends these requests of the Engine API:

| Call                                                                         | Request                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Docker.connect()`                                                           | `GET /_ping`                                                                                                                                                                                 |
| `docker.info()`, `docker.events()`                                           | `GET /info`, `GET /events`                                                                                                                                                                   |
| `containers.create()`, `createOrGet()`                                       | `POST /containers/create`, and `GET /containers/{id}/json` after a 409                                                                                                                       |
| `containers.run()`                                                           | `create`, `attach`, `start`, `wait`, `DELETE /containers/{id}`                                                                                                                               |
| `containers.find()`, `container.inspect()`, `container.port()`               | `GET /containers/{id}/json`                                                                                                                                                                  |
| `containers.list()`                                                          | `GET /containers/json`                                                                                                                                                                       |
| `start()`, `stop()`, `restart()`, `kill()`, `pause()`, `unpause()`, `wait()` | `POST /containers/{id}/start`, `/stop`, `/restart`, `/kill`, `/pause`, `/unpause`, `/wait`                                                                                                   |
| `container.remove()`                                                         | `DELETE /containers/{id}`                                                                                                                                                                    |
| `container.logs()`, `followLogs()`                                           | `GET /containers/{id}/logs`                                                                                                                                                                  |
| `container.attach()`                                                         | `POST /containers/{id}/attach` (hijacked)                                                                                                                                                    |
| `container.exec()`, `spawn()`                                                | `POST /containers/{id}/exec`, `POST /exec/{id}/start` (hijacked), `GET /exec/{id}/json`                                                                                                      |
| `container.stat()`, `readFile()`, `getArchive()`                             | `HEAD`, `GET /containers/{id}/archive`                                                                                                                                                       |
| `container.writeFiles()`, `putArchive()`                                     | `PUT /containers/{id}/archive`                                                                                                                                                               |
| `volumes.*`, `volume.*`                                                      | `POST /volumes/create`, `GET /volumes/{name}`, `GET /volumes`, `DELETE /volumes/{name}`                                                                                                      |
| `networks.*`, `network.*`                                                    | `POST /networks/create`, `GET /networks/{id}`, `GET /networks`, `POST /networks/{id}/connect`, `/disconnect`, `DELETE /networks/{id}`                                                        |
| `images.*`                                                                   | `GET /images/{name}/json`, `GET /images/json`, `POST /images/create`, `POST /images/{name}/tag`, `POST /images/{name}/push`, `GET /images/get`, `POST /images/load`, `DELETE /images/{name}` |

## What each repository changes

The package leads. Each repository below changes to fit it, with no adapter. Each change is a backlog item in that repository.

| Repository                               | Change                                                                                                                                                                  | Backlog |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `@zukhruf/testing/docker`                | Rebuilt on the package. `reuse()` uses `createOrGet()` and compares its fingerprint label. Handles become owned or found.                                               | #2752   |
| text2sql finders                         | `Docker.contexts()`, `containers.list()` and `find()`, `ConnectionFailedError` in place of the fixed sockets                                                            | #2754   |
| text2sql daemon tests                    | `@zukhruf/testing/docker` in place of the CLI by hand                                                                                                                   | #2755   |
| text2sql desktop tests                   | `images.inspect()`, `pull()`, `save()`                                                                                                                                  | #2756   |
| text2sql artifacts volume adapter        | `writeFiles()`, `readFile()` and `stat()` in place of base64 through exec                                                                                               | #2757   |
| `@deepagents/context` sandbox            | `createOrGet()` for named sandboxes, the files API in place of base64 in arguments, container processes in place of two streams, status codes in place of stderr checks | #2760   |
| `@deepagents/toolbox`, `convert-to-gguf` | `find()` and `exec()`, `containers.run()`                                                                                                                               | #2761   |
| sdk-it `e2e/docker.ts`                   | `attach()` and its chunks, or removal                                                                                                                                   | #2764   |
| finetuning                               | `create()`, `port()`, `logs()`; test cleanup through `@zukhruf/testing`                                                                                                 | #2765   |
| april                                    | `createOrGet()` and `docker.events()` for the health of the container                                                                                                   | #2766   |
| serverize                                | Networks, `images.load()`, `pull()` and `push()` with `auth`, `writeFiles()`, `followLogs()`                                                                            | #2769   |
