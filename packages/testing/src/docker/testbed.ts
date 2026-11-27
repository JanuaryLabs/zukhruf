import { hash, randomUUID } from 'node:crypto';

import pMemoize from 'p-memoize';

import {
  ConnectionFailedError,
  type Container,
  ContainerNotFoundError,
  Docker,
  type EngineApi,
  type Environment,
  type ExecResult,
  ImageNotFoundError,
  type OwnedContainer,
  type OwnedVolume,
} from '@zukhruf/docker';

import { DockerDirectory } from './directory.ts';
import {
  EngineLease,
  LEASED_SERVER_LABEL,
  LEASE_LABEL,
  sweepLeaseName,
} from './engine-lease.ts';
import { DockerHost } from './host.ts';
import { REAPER_DEFAULTS, ReaperHold, SERVER_LABEL } from './reaper.ts';
import {
  type ProcessRun,
  TEST_RUN_LABEL,
  readRun,
  servedConnection,
} from './run-records.ts';
import { ServiceContainer } from './service-container.ts';

export interface ServiceOptions {
  /** The container's port that answers on 127.0.0.1 of this machine. */
  internalPort: number;
  /** Without it, the engine names a dedicated server; a shared server's name comes from its request. */
  name?: string;
  /**
   * Runs on every acquisition, and resolves when the server is ready. Wait for
   * the server's ready line in `followLogs()` and then send one query
   * (ADR 0035); poll with retryUntilReady only for a server that writes no
   * ready line. `signal` aborts when the container exits first: pass it on.
   */
  healthy?: (service: ServiceContainer, signal: AbortSignal) => unknown;
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

/** The run's labels and the default resources, in the shape of a body. */
interface Defaults {
  Labels: Record<string, string>;
  HostConfig: { Memory: number; NanoCpus: number };
}

/**
 * The process lease of this process for each shared server, by the engine's
 * host and the server's fingerprint. One process builds many testbeds, so the
 * lease belongs to the module. A lease whose attach ended is taken again by
 * the next reuse() of that server.
 */
const processLeases = new Map<string, Promise<EngineLease>>();

/**
 * The hold of this process on the reaper of its run, by the engine's host
 * (ADR 0020). A hold that ends while this process lives takes itself again at
 * once, and each create waits for it. A first hold that failed is taken again
 * by the next create.
 */
const reapers = new Map<string, Promise<ReaperHold>>();

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/** The name of the build lease of the image `tag` on an engine: a tag has characters that a container name cannot have. */
function buildLeaseName(tag: string): string {
  return `zukhruf-testing-build-${hash('sha256', tag)}`;
}

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
    const client = await Docker.connect({
      clock: globalThis,
      environment: this.#environment,
    }).catch((error: unknown) => {
      if (error instanceof ConnectionFailedError)
        throw new Error('Docker is required for container-backed tests', {
          cause: error,
        });
      throw error;
    });
    try {
      const served = await servedConnection(client.host);
      return {
        client,
        host:
          served === undefined
            ? new DockerHost(client.host, { environment: this.#environment })
            : new DockerHost(served.endpoint, { master: served.master }),
      };
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
   * In a run, this process holds the run's reaper on the testbed's engine
   * before the labels exist, as a create does (ADR 0020, item 11). A
   * launcher that creates with these labels thus leaves nothing behind.
   */
  async defaults(): Promise<{
    Labels: Record<string, string>;
    HostConfig: { Memory: number; NanoCpus: number };
  }> {
    if (this.#run !== undefined) await this.#reaper(await this.#engine());
    return this.#defaults();
  }

  /** The client of the engine that this instance's handles are on. */
  async client(): Promise<Docker> {
    return (await this.#engine()).client;
  }

  /** A fixture directory on the engine's host. The reaper of its run removes it if this process dies first. */
  async directory(): Promise<DockerDirectory> {
    const engine = await this.#engine();
    await this.#reaper(engine);
    return DockerDirectory.create(engine.host, this.#run?.id);
  }

  /** Creates a named volume. The reaper of its run removes it if this process dies first. */
  async volume(): Promise<OwnedVolume> {
    const engine = await this.#engine();
    return this.#creating(engine, () =>
      engine.client.volumes.create({
        Name: `zukhruf-testing-${randomUUID()}`,
        Labels: this.#defaults().Labels,
      }),
    );
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
    try {
      return await this.#ready(engine, container, options, remove, () =>
        this.#startOrRemove(container),
      );
    } catch (error) {
      await using removal = new AsyncDisposableStack();
      removal.defer(remove);
      const output = await container.logs().then(
        (logs) => logs.output,
        (reading: unknown) => {
          // #startOrRemove removed a container that did not start.
          if (reading instanceof ContainerNotFoundError) return undefined;
          throw reading;
        },
      );
      if (output === undefined) throw error;
      throw new Error(`Container ${container.id} was not ready:\n${output}`, {
        cause: error,
      });
    }
  }

  /**
   * Reuse one server per request on this engine, across processes, runs and
   * versions of this package. Docker reserves the name atomically. Readiness
   * failure leaves it running. Disposal closes only the forward; the server
   * keeps running for its other users. The engine removes the server when it
   * stops.
   */
  async reuse(
    body: EngineApi.ContainerCreateRequest,
    options: ServiceOptions,
  ): Promise<ServiceContainer> {
    const engine = await this.#engine();
    const published = this.#published(
      { ...body, HostConfig: { ...RESOURCES, ...body.HostConfig } },
      options.internalPort,
    );
    const request: EngineApi.ContainerCreateRequest = {
      ...published,
      HostConfig: { ...published.HostConfig, AutoRemove: true },
    };
    const fingerprint = hash(
      'sha256',
      JSON.stringify(
        canonical({ internalPort: options.internalPort, request }),
      ),
    );
    // Publish this process's lease, then read the sweep lease (ADR 0014).
    await this.#processLease(engine, fingerprint);
    await EngineLease.gone(engine.client, sweepLeaseName(fingerprint), {
      clock: globalThis,
    });
    const name = options.name ?? `zukhruf-testing-${fingerprint}`;
    const shared: EngineApi.ContainerCreateRequest = {
      ...request,
      Labels: { ...request.Labels, [SERVER_LABEL]: fingerprint },
    };
    const { container } = await this.#creating(engine, () =>
      engine.client.containers.createOrGet(shared, { name }),
    );
    const inspected = await container.inspect();
    if (inspected.Config?.Labels?.[SERVER_LABEL] !== fingerprint)
      throw new Error(
        `Container ${name} does not match the shared test configuration`,
      );
    return this.#ready(engine, container, options, undefined, async () => {
      if (inspected.State?.Status !== 'running') await container.start();
    });
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
   * Makes sure that the engine has the image `tag`, and builds it once across
   * processes when it has none. The builder holds the build lease of the tag,
   * as a reaper holds the sweep lease of a server; another process waits until
   * that lease is gone, and looks again. `build` must tag the image `tag`.
   */
  async image(
    tag: string,
    build: (docker: Docker) => Promise<unknown>,
  ): Promise<void> {
    const engine = await this.#engine();
    const name = buildLeaseName(tag);
    for (;;) {
      if ((await engine.client.images.inspect(tag)) !== undefined) return;
      const lease = await this.#creating(engine, () =>
        EngineLease.take(
          engine.client,
          { ...this.#defaults().Labels, [LEASE_LABEL]: 'build' },
          { name },
        ),
      );
      if (lease === undefined) {
        await EngineLease.gone(engine.client, name, { clock: globalThis });
        continue;
      }
      try {
        // Another process can have built it between the look and the lease.
        if ((await engine.client.images.inspect(tag)) === undefined)
          await build(engine.client);
        return;
      } finally {
        await lease[Symbol.asyncDispose]();
      }
    }
  }

  /** The process lease of this process for the shared server of `fingerprint`: a sweep keeps that server while it runs. */
  async #processLease(
    engine: Engine,
    fingerprint: string,
  ): Promise<EngineLease> {
    const key = `${engine.client.host} ${fingerprint}`;
    const taken = processLeases.get(key);
    if (taken !== undefined) return taken;
    const taking = this.#creating(engine, async () => {
      const lease = await EngineLease.take(engine.client, {
        ...this.#defaults().Labels,
        [LEASE_LABEL]: 'process',
        [LEASED_SERVER_LABEL]: fingerprint,
      });
      if (lease === undefined)
        throw new Error(
          'The engine removed the process lease before its start',
        );
      return lease;
    });
    processLeases.set(key, taking);
    const forget = () => {
      if (processLeases.get(key) === taking) processLeases.delete(key);
    };
    taking.then((lease) => lease.closed().then(forget), forget);
    return taking;
  }

  /**
   * Runs `create` after this process holds the reaper of its run, and pulls
   * a missing image before a second try, as `docker run` does.
   */
  async #creating<T>(engine: Engine, create: () => Promise<T>): Promise<T> {
    await this.#reaper(engine);
    try {
      return await create();
    } catch (error) {
      if (!(error instanceof ImageNotFoundError)) throw error;
      await engine.client.images.pull(error.image);
      return await create();
    }
  }

  /** Holds the reaper of this process's run on the engine, before this process creates anything there. */
  async #reaper(engine: Engine): Promise<void> {
    const run = this.#run;
    if (run === undefined) return;
    const key = `${engine.client.host} ${run.id}`;
    const taken = reapers.get(key);
    if (taken !== undefined) {
      await (await taken).held();
      return;
    }
    const taking = ReaperHold.take(
      engine.client,
      engine.host.endpoint,
      run.id,
      REAPER_DEFAULTS,
      globalThis,
    );
    reapers.set(key, taking);
    taking.catch(() => {
      if (reapers.get(key) === taking) reapers.delete(key);
    });
    await taking;
  }

  async #startOrRemove(container: OwnedContainer): Promise<void> {
    try {
      await container.start();
    } catch (error) {
      await using removal = new AsyncDisposableStack();
      removal.defer(() => container.remove({ force: true, v: true }));
      throw error;
    }
  }

  /**
   * Starts the container with `start` and waits until it answers. The attach
   * comes before the start, so the exit and the output of a container that
   * dies at once are not lost, also when AutoRemove removes it. A container
   * that exits first ends the wait and rejects with its exit code and output.
   */
  async #ready(
    engine: Engine,
    container: Container,
    options: ServiceOptions,
    remove: (() => Promise<void>) | undefined,
    start: () => Promise<void>,
  ): Promise<ServiceContainer> {
    const watching = new AbortController();
    const attached = await container.attach({ signal: watching.signal });
    const exited = attached.collect().then(({ exitCode, output }) => {
      throw new Error(
        `Container ${container.id} exited with code ${exitCode} before it was ready:\n${output}`,
      );
    });
    try {
      return await Promise.race([
        exited,
        this.#answering(engine, container, options, remove, {
          start,
          exited,
          signal: watching.signal,
        }),
      ]);
    } finally {
      watching.abort();
    }
  }

  /** The service of `container` once `healthy` passes. An abort of `signal` disconnects it. */
  async #answering(
    engine: Engine,
    container: Container,
    { internalPort, healthy }: ServiceOptions,
    remove: (() => Promise<void>) | undefined,
    {
      start,
      exited,
      signal,
    }: {
      start: () => Promise<void>;
      exited: Promise<never>;
      signal: AbortSignal;
    },
  ): Promise<ServiceContainer> {
    await start();
    const published = await container
      .port(internalPort, 'tcp', { signal })
      .catch((error: unknown) => {
        if (error instanceof ContainerNotFoundError) return undefined;
        throw error;
      });
    // #published binds the port, so only a container that stopped has none.
    if (published === undefined) return exited;
    const connection = await engine.host.forward(published.port);
    const service = new ServiceContainer(
      container,
      connection.port,
      connection.close,
      remove,
    );
    try {
      await healthy?.(service, signal);
      signal.throwIfAborted();
      return service;
    } catch (error) {
      await service.disconnect();
      throw error;
    }
  }

  /** The run's labels and the default resources. */
  #defaults(): Defaults {
    return {
      Labels: this.#run ? { [TEST_RUN_LABEL]: this.#run.id } : {},
      HostConfig: { ...RESOURCES },
    };
  }

  /** The body of a container this process owns: the run's labels win, and the body's resources win over the defaults. */
  #owned(
    body: EngineApi.ContainerCreateRequest,
  ): EngineApi.ContainerCreateRequest {
    const { Labels, HostConfig } = this.#defaults();
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
