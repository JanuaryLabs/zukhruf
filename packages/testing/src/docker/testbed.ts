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
import { type ProcessRun, TEST_RUN_LABEL, readRun } from './run-records.ts';
import { ServiceContainer } from './service-container.ts';

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

export interface ServiceOptions {
  /** The container's port that answers on 127.0.0.1 of this machine. */
  internalPort: number;
  /** Without it, the engine names a dedicated server; a shared server's name comes from its configuration. */
  name?: string;
  /** Runs on every acquisition. Throw until ready, using timebox for polling. */
  healthy?: (service: ServiceContainer) => unknown;
}

export interface DockerTestbedOptions {
  /** The environment of this process, such as `process.env`: it selects the engine and the run. */
  environment: Environment;
}

/** The engine of this instance: the client, and its host for SSH shells and forwards. */
interface Engine {
  client: Docker;
  host: DockerHost;
}

/** The default resources: they protect a shared engine, such as an SSH engine that runs real applications. */
const RESOURCES = { Memory: 1024 ** 3, NanoCpus: 1e9 };

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/** The value with its object keys sorted and its `Env` entries sorted; every other array keeps its order. */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item: unknown) => canonical(item));
    return key === 'Env' ? items.toSorted() : items;
  }
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(byKey)
        .map(([name, item]) => [name, canonical(item, name)]),
    );
  return value;
}

/**
 * A testbed of containers on the engine that `environment` selects. The engine is
 * connected on the first acquisition and kept: handles keep the engine they
 * were made on. Docker owns cross-process coordination; this instance holds
 * no server cache.
 */
export class DockerTestbed {
  readonly #environment: Environment;
  readonly #run: ProcessRun | undefined;
  readonly #engine = pMemoize(async (): Promise<Engine> => {
    this.#run?.records.recordThisProcess();
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

  constructor({ environment }: DockerTestbedOptions) {
    this.#environment = environment;
    this.#run = readRun(environment);
  }

  /**
   * Defaults for disposable test containers, including external launchers.
   * A launcher creates with these labels and no acquisition of this class:
   * the read records this process, so the global teardown sweeps the run.
   */
  get defaults(): {
    Labels: Record<string, string>;
    HostConfig: { Memory: number; NanoCpus: number };
  } {
    this.#run?.records.recordThisProcess();
    return {
      Labels: this.#run ? { [TEST_RUN_LABEL]: this.#run.id } : {},
      HostConfig: { ...RESOURCES },
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
      Labels: this.defaults.Labels,
    });
  }

  /** Starts a container this process owns. It stays after it stops, until disposal removes it. */
  async start(
    body: EngineApi.ContainerCreateRequest,
    options?: { name?: string },
  ): Promise<OwnedContainer> {
    const engine = await this.#engine();
    const container = await this.#creating(engine, () =>
      engine.client.containers.create(this.#owned(body), options),
    );
    await this.#startOrRemove(container);
    return container;
  }

  /**
   * Starts a dedicated server. Failure or disposal removes it. A server that
   * is not ready rejects with its container's output, read before the removal.
   */
  async serve(
    body: EngineApi.ContainerCreateRequest,
    options: ServiceOptions,
  ): Promise<ServiceContainer> {
    const engine = await this.#engine();
    const published = this.#published(this.#owned(body), options.internalPort);
    const container = await this.#creating(engine, () =>
      engine.client.containers.create(published, options),
    );
    const remove = () => container.remove({ force: true, v: true });
    await this.#startOrRemove(container);
    try {
      return await this.#ready(engine, container, options, remove);
    } catch (error) {
      const output = await container.logs().then(
        (logs) => logs.output,
        () => undefined,
      );
      await remove().catch(() => {});
      if (output === undefined) throw error;
      throw new Error(`Container ${container.id} was not ready:\n${output}`, {
        cause: error,
      });
    }
  }

  /**
   * Reuse one server per configuration on this engine, across processes and
   * runs. Docker reserves the name atomically. Readiness failure leaves it
   * running. Disposal closes only the forward; the server keeps running for
   * its other users. The engine removes the server when it stops.
   */
  async reuse(
    body: EngineApi.ContainerCreateRequest,
    options: ServiceOptions,
  ): Promise<ServiceContainer> {
    const engine = await this.#engine();
    const configured: EngineApi.ContainerCreateRequest = {
      ...body,
      HostConfig: { ...RESOURCES, ...body.HostConfig },
    };
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          canonical({
            version: PACKAGE_VERSION,
            internalPort: options.internalPort,
            body: configured,
          }),
        ),
      )
      .digest('hex');
    const name = options.name ?? `zukhruf-testing-${fingerprint}`;
    const published = this.#published(
      {
        ...configured,
        Labels: {
          ...configured.Labels,
          [SHARED_SERVER_LABEL]: '1',
          [CONFIG_LABEL]: fingerprint,
          [VERSION_LABEL]: PACKAGE_VERSION,
        },
      },
      options.internalPort,
    );
    const shared: EngineApi.ContainerCreateRequest = {
      ...published,
      HostConfig: { ...published.HostConfig, AutoRemove: true },
    };
    const { container } = await this.#creating(engine, () =>
      engine.client.containers.createOrGet(shared, { name }),
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
  async run(
    body: EngineApi.ContainerCreateRequest,
    options?: { name?: string },
  ): Promise<ExecResult> {
    const engine = await this.#engine();
    const owned = this.#owned(body);
    return this.#creating(engine, () =>
      engine.client.containers.run(owned, options),
    );
  }

  /**
   * Runs `create` under a creating record, and pulls a missing image before
   * a second try, as `docker run` does.
   */
  async #creating<T>(engine: Engine, create: () => Promise<T>): Promise<T> {
    await using _creating = await this.#run?.records.recordCreating();
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

  /** The body of a container this process owns: the run's labels win, and the body's resources win over the defaults. */
  #owned(
    body: EngineApi.ContainerCreateRequest,
  ): EngineApi.ContainerCreateRequest {
    const { Labels, HostConfig } = this.defaults;
    return {
      ...body,
      Labels: { ...body.Labels, ...Labels },
      HostConfig: { ...HostConfig, ...body.HostConfig },
    };
  }

  /** Publishes `internalPort` on 127.0.0.1 of the engine's host. */
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
        PortBindings: { [port]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
      },
    };
  }
}
