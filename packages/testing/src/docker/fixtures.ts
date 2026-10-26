import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pMemoize from 'p-memoize';

import {
  ConnectionFailedError,
  type Container,
  Docker,
  type EngineApi,
  type Environment,
  type ExecResult,
  ImageNotFoundError,
  type OwnedContainer,
  type OwnedVolume,
} from '@zukhruf/docker';

import { DockerDirectory } from './directory.ts';
import { DockerHost } from './host.ts';
import { ServiceContainer } from './service-container.ts';
import { TestRun } from './test-run.ts';

/** Marks a server that `reuse()` shares across processes and runs. */
export const SHARED_SERVER_LABEL = 'dev.zukhruf.testing.shared';
/** The fingerprint of a shared server's configuration. */
export const CONFIG_LABEL = 'dev.zukhruf.testing.config';
/** The version of this package that a shared server belongs to (ADR 0012). */
export const VERSION_LABEL = 'dev.zukhruf.testing.version';

/** The version of this package: `../../package.json` from `src/docker` and from `dist/docker`. */
export const { version: PACKAGE_VERSION }: { version: string } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

/** A volume or a path on the engine's host, mounted into a container. */
export interface Mount {
  /** A volume's name, or an absolute path on the engine's host. */
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface ContainerOptions {
  image: string;
  /** Replaces the image's command. */
  command?: string[];
  /** A dedicated container gets a generated name; a reused server's name comes from its configuration. */
  name?: string;
  hostname?: string;
  env?: Record<string, string>;
  labels?: Record<string, string> | undefined;
  mounts?: Mount[];
  /** `<path>[:<options>]`, as `docker run --tmpfs` takes it. */
  tmpfs?: string[];
  ipcHost?: boolean;
  /** A size in the Docker CLI's binary units, such as `512m` or `1g`. */
  memory?: string;
  cpus?: number;
  memorySwappiness?: number;
}

export interface ServiceOptions extends ContainerOptions {
  /** The container's port that answers on 127.0.0.1 of this machine. */
  internalPort: number;
  /** Runs on every acquisition. Throw until ready, using timebox for polling. */
  healthy?: (service: ServiceContainer) => unknown;
}

export interface DockerFixturesOptions {
  /** The environment of this process, such as `process.env`: it selects the engine and the run. */
  environment: Environment;
}

/** The engine of this instance: the client, and its host for SSH shells and forwards. */
interface Engine {
  client: Docker;
  host: DockerHost;
}

const units: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};

/** Bytes of a size such as `1g`, in the binary units of the Docker CLI's `--memory`. */
function bytes(size: string): number {
  const match = /^(\d+(?:\.\d+)?)\s?([bkmgtp])?i?b?$/i.exec(size);
  if (!match?.[1]) throw new Error(`Invalid memory size: ${size}`);
  return Math.trunc(
    Number(match[1]) * (units[match[2]?.toLowerCase() ?? 'b'] ?? 1),
  );
}

const byKey = ([a]: [string, string], [b]: [string, string]): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const generatedName = (image: string): string =>
  `test-${image.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomUUID()}`;

/**
 * Container fixtures on the engine that `environment` selects. The engine is
 * connected on the first acquisition and kept: handles keep the engine they
 * were made on. Docker owns cross-process coordination; this instance holds
 * no server cache.
 */
export class DockerFixtures {
  readonly #environment: Environment;
  readonly #run: TestRun | undefined;
  readonly #engine = pMemoize(async (): Promise<Engine> => {
    this.#run?.recordThisProcess();
    const client = await Docker.connect({
      environment: this.#environment,
    }).catch((error: unknown) => {
      if (error instanceof ConnectionFailedError)
        throw new Error('Docker is required for container-backed tests', {
          cause: error,
        });
      throw error;
    });
    try {
      return { client, host: new DockerHost(client.host, this.#run) };
    } catch (error) {
      await client[Symbol.asyncDispose]();
      throw error;
    }
  });

  constructor({ environment }: DockerFixturesOptions) {
    this.#environment = environment;
    this.#run = TestRun.fromEnvironment(environment);
  }

  /**
   * Defaults for disposable test containers, including external launchers.
   * A launcher creates with these labels and no acquisition of this class:
   * the read records this process, so the global teardown sweeps the run.
   */
  get defaults(): {
    resources: { memory: string; cpus: number };
    labels: Record<string, string>;
  } {
    this.#run?.recordThisProcess();
    return {
      resources: { memory: '1g', cpus: 1 },
      labels: this.#run?.labels ?? {},
    };
  }

  /** The client of the engine that this instance's handles are on. */
  async client(): Promise<Docker> {
    return (await this.#engine()).client;
  }

  /** A fixture directory on the engine's host. */
  async directory(): Promise<DockerDirectory> {
    return DockerDirectory.create((await this.#engine()).host, this.#run);
  }

  /** Creates a named volume. Its run's cleanup removes it if this process dies first. */
  async volume(): Promise<OwnedVolume> {
    const { client } = await this.#engine();
    return client.volumes.create({
      Name: `zukhruf-testing-${randomUUID()}`,
      Labels: this.defaults.labels,
    });
  }

  /** Starts a container this process owns. It stays after it stops, until disposal removes it. */
  async start(options: ContainerOptions): Promise<OwnedContainer> {
    const engine = await this.#engine();
    const container = await this.#create(engine, this.#owned(options), {
      name: options.name ?? generatedName(options.image),
    });
    await this.#startOrRemove(container);
    return container;
  }

  /** Starts a dedicated server. Failure or disposal removes it. */
  async serve(options: ServiceOptions): Promise<ServiceContainer> {
    const engine = await this.#engine();
    const owned = this.#owned(options);
    const container = await this.#create(
      engine,
      this.#published(owned, options.internalPort),
      { name: options.name ?? generatedName(options.image) },
    );
    const remove = () => container.remove({ force: true, v: true });
    await this.#startOrRemove(container);
    try {
      return await this.#ready(engine, container, options, remove);
    } catch (error) {
      await remove().catch(() => {});
      throw error;
    }
  }

  /**
   * Reuse one server per configuration on this engine, across processes and
   * runs. Docker reserves the name atomically. Readiness failure leaves it
   * running. Disposal closes only the forward; the server keeps running for
   * its other users.
   */
  async reuse(options: ServiceOptions): Promise<ServiceContainer> {
    const engine = await this.#engine();
    const fingerprint = this.#fingerprint(options);
    const name = options.name ?? `zukhruf-testing-${fingerprint}`;
    const body = this.#published(
      this.#body({
        ...options,
        labels: {
          ...options.labels,
          [SHARED_SERVER_LABEL]: '1',
          [CONFIG_LABEL]: fingerprint,
          [VERSION_LABEL]: PACKAGE_VERSION,
        },
      }),
      options.internalPort,
    );
    const { container } = await this.#creating(engine, () =>
      engine.client.containers.createOrGet(body, { name }),
    );
    const inspected = await container.inspect();
    const labels = inspected.Config?.Labels;
    if (
      labels?.[SHARED_SERVER_LABEL] !== '1' ||
      labels[CONFIG_LABEL] !== fingerprint
    )
      throw new Error(
        `Container ${name} does not match the shared test configuration`,
      );
    if (inspected.State?.Status !== 'running') await container.start();
    return this.#ready(engine, container, options, undefined);
  }

  /** Runs a container to completion and gives its output and exit code. The container is removed afterwards. */
  async run(options: ContainerOptions): Promise<ExecResult> {
    const engine = await this.#engine();
    const body = this.#owned(options);
    return this.#creating(engine, () =>
      engine.client.containers.run(body, {
        name: options.name ?? generatedName(options.image),
      }),
    );
  }

  async #create(
    engine: Engine,
    body: EngineApi.ContainerCreateRequest,
    { name }: { name: string },
  ): Promise<OwnedContainer> {
    return this.#creating(engine, () =>
      engine.client.containers.create(body, { name }),
    );
  }

  /**
   * Runs `create` under a creating record, and pulls a missing image before
   * a second try, as `docker run` does.
   */
  async #creating<T>(engine: Engine, create: () => Promise<T>): Promise<T> {
    await using _creating = await this.#run?.recordCreating();
    try {
      return await create();
    } catch (error) {
      if (!(error instanceof ImageNotFoundError)) throw error;
      await engine.client.images.pull(error.image);
      return await create();
    }
  }

  async #startOrRemove(container: OwnedContainer): Promise<void> {
    try {
      await container.start();
    } catch (error) {
      await container.remove({ force: true, v: true }).catch(() => {});
      throw error;
    }
  }

  async #ready(
    engine: Engine,
    container: Container,
    { internalPort, healthy }: ServiceOptions,
    remove: (() => Promise<void>) | undefined,
  ): Promise<ServiceContainer> {
    const published = await container.port(internalPort);
    if (!published)
      throw new Error(
        `Container ${container.id} publishes no port for ${internalPort}`,
      );
    const connection = await engine.host.forward(published.port);
    const service = new ServiceContainer(
      container,
      connection.port,
      connection.close,
      remove,
    );
    try {
      await healthy?.(service);
      return service;
    } catch (error) {
      await service.disconnect();
      throw error;
    }
  }

  /** The body of a container this process owns: it carries the run's labels. */
  #owned(options: ContainerOptions): EngineApi.ContainerCreateRequest {
    return this.#body({
      ...options,
      labels: { ...options.labels, ...this.defaults.labels },
    });
  }

  /** Publishes `internalPort` on 127.0.0.1 of the engine's host; the engine removes the container when it stops. */
  #published(
    body: EngineApi.ContainerCreateRequest,
    internalPort: number,
  ): EngineApi.ContainerCreateRequest {
    const port = `${internalPort}/tcp`;
    return {
      ...body,
      ExposedPorts: { [port]: {} },
      HostConfig: {
        ...body.HostConfig,
        AutoRemove: true,
        PortBindings: { [port]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
      },
    };
  }

  #body(options: ContainerOptions): EngineApi.ContainerCreateRequest {
    const { resources } = this.defaults;
    const hostConfig: EngineApi.HostConfig = {
      Binds: (options.mounts ?? []).map(
        ({ source, target, readOnly }) =>
          `${source}:${target}${readOnly ? ':ro' : ''}`,
      ),
      Tmpfs: Object.fromEntries(
        (options.tmpfs ?? []).map((spec) => {
          const separator = spec.indexOf(':');
          return separator === -1
            ? [spec, '']
            : [spec.slice(0, separator), spec.slice(separator + 1)];
        }),
      ),
      Memory: bytes(options.memory ?? resources.memory),
      NanoCpus: Math.round((options.cpus ?? resources.cpus) * 1e9),
      ...(options.ipcHost ? { IpcMode: 'host' } : {}),
      ...(options.memorySwappiness === undefined
        ? {}
        : { MemorySwappiness: options.memorySwappiness }),
    };
    return {
      Image: options.image,
      ...(options.command ? { Cmd: options.command } : {}),
      ...(options.hostname ? { Hostname: options.hostname } : {}),
      Labels: options.labels ?? {},
      Env: Object.entries(options.env ?? {}).map(
        ([key, value]) => `${key}=${value}`,
      ),
      HostConfig: hostConfig,
    };
  }

  #fingerprint(options: ServiceOptions): string {
    const { resources } = this.defaults;
    return createHash('sha256')
      .update(
        JSON.stringify({
          version: PACKAGE_VERSION,
          memory: options.memory ?? resources.memory,
          cpus: options.cpus ?? resources.cpus,
          image: options.image,
          command: options.command ?? [],
          hostname: options.hostname,
          internalPort: options.internalPort,
          env: Object.entries(options.env ?? {}).sort(byKey),
          labels: Object.entries(options.labels ?? {}).sort(byKey),
          mounts: options.mounts ?? [],
          tmpfs: options.tmpfs ?? [],
          ipcHost: Boolean(options.ipcHost),
          memorySwappiness: options.memorySwappiness,
        }),
      )
      .digest('hex');
  }
}
