import { createHash, randomUUID } from 'node:crypto';

import { SubprocessError } from 'nano-spawn';
import pMemoize from 'p-memoize';

import { timebox } from '../async/timebox.ts';
import {
  Container,
  type DockerCommand,
  ServiceContainer,
} from './container.ts';
import { DockerDirectory } from './directory.ts';
import { DockerHost } from './host.ts';
import type { TestRun } from './test-run.ts';
import { DockerVolume } from './volume.ts';

/** Marks a server that `reuse()` shares across processes and runs. */
export const SHARED_SERVER_LABEL = 'dev.zukhruf.testing.shared';
const CONFIG_LABEL = 'dev.zukhruf.testing.config';

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
  tmpfs?: string[];
  ipcHost?: boolean;
  memory?: string;
  cpus?: number;
  memorySwappiness?: number;
}

export interface ServiceOptions extends ContainerOptions {
  /** The container's port that answers on 127.0.0.1 of this machine. */
  internalPort: number;
  /** Runs on every acquisition. Throw until ready, using timebox for polling. */
  healthy?: (container: ServiceContainer) => unknown;
}

export interface DockerOptions {
  /** The supervised run that owns what this process creates: `TestRun.fromEnvironment(process.env)`. */
  testRun?: TestRun | undefined;
}

interface InspectedContainer {
  Id: string;
  Config: { Labels: Record<string, string> | null };
  State: { Status: string };
}

type Probe = { available: true } | { available: false; cause: unknown };

const labelArgs = (labels: Record<string, string>): string[] =>
  Object.entries(labels).flatMap(([key, value]) => [
    '--label',
    `${key}=${value}`,
  ]);

const publish = (internalPort: number): string[] => [
  '-p',
  `127.0.0.1::${internalPort}`,
];

const byKey = ([a]: [string, string], [b]: [string, string]): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/** The engine the Docker CLI selects. Docker owns cross-process coordination; this instance holds no server cache. */
export class Docker {
  readonly #testRun: TestRun | undefined;
  // The first resolution pins the engine: handles keep the engine they were made on.
  readonly #connection = pMemoize(() => DockerHost.resolve());
  readonly #probe = pMemoize(async (): Promise<Probe> => {
    try {
      await this.command(['info']);
      return { available: true };
    } catch (cause) {
      return { available: false, cause };
    }
  });

  constructor({ testRun }: DockerOptions = {}) {
    this.#testRun = testRun;
  }

  /** Defaults for disposable test containers, including external launchers. */
  get defaults(): {
    resources: { memory: string; cpus: number };
    labels: Record<string, string>;
  } {
    return {
      resources: { memory: '1g', cpus: 1 },
      labels: this.#testRun?.labels ?? {},
    };
  }

  async info(): Promise<{ architecture: string; endpoint: string }> {
    const host = await this.#connection();
    const { stdout } = await host.command([
      'info',
      '--format',
      '{{.Architecture}}',
    ]);
    return { architecture: stdout.trim(), endpoint: host.endpoint };
  }

  async directory(): Promise<DockerDirectory> {
    return DockerDirectory.create(await this.#connection(), this.#testRun);
  }

  /** Creates a named volume. The supervisor removes it with its run if this process dies first. */
  async volume(): Promise<DockerVolume> {
    const host = await this.#require();
    const name = `zukhruf-testing-${randomUUID()}`;
    await host.command([
      'volume',
      'create',
      ...labelArgs(this.defaults.labels),
      name,
    ]);
    return new DockerVolume(name, host.command);
  }

  readonly command: DockerCommand = async (args) =>
    (await this.#connection()).command(args);

  async isAvailable(): Promise<boolean> {
    return (await this.#probe()).available;
  }

  async #require(): Promise<DockerHost> {
    const probe = await this.#probe();
    if (!probe.available)
      throw new Error('Docker is required for container-backed tests', {
        cause: probe.cause,
      });
    return this.#connection();
  }

  /** Starts a container this process owns. It stays after it stops, until disposal removes it. */
  async start(options: ContainerOptions): Promise<Container> {
    const host = await this.#require();
    return new Container(await this.#detach(host, [], options), host.command);
  }

  /** Starts a dedicated server. Failure or disposal stops it, and a stopped server is removed. */
  async serve(options: ServiceOptions): Promise<ServiceContainer> {
    const host = await this.#require();
    const id = await this.#detach(
      host,
      ['--rm', ...publish(options.internalPort)],
      options,
    );
    try {
      return await this.#ready(host, id, options);
    } catch (error) {
      await host.command(['stop', id]).catch(() => {});
      throw error;
    }
  }

  /**
   * Reuse one server per configuration on this daemon, across processes/runs.
   * Docker reserves the name atomically. Readiness failure leaves it running.
   * Only explicitly dispose the returned container after all its users finish.
   */
  async reuse(options: ServiceOptions): Promise<ServiceContainer> {
    const host = await this.#require();
    const fingerprint = this.#fingerprint(options);
    const name = options.name ?? `zukhruf-testing-${fingerprint}`;
    const inspected =
      (await this.#inspect(host, name)) ??
      (await this.#create(host, name, fingerprint, options));
    if (
      inspected.Config.Labels?.[SHARED_SERVER_LABEL] !== '1' ||
      inspected.Config.Labels[CONFIG_LABEL] !== fingerprint
    ) {
      throw new Error(
        `Container ${name} does not match the shared test configuration`,
      );
    }
    if (inspected.State.Status !== 'running') {
      await host.command(['start', inspected.Id]);
    }
    return this.#ready(host, inspected.Id, options);
  }

  /** Runs a container to completion and returns its standard output. The container is removed afterwards. */
  async run(options: ContainerOptions): Promise<string> {
    const host = await this.#require();
    return this.#launch(host, ['run', '--rm'], options);
  }

  async #create(
    host: DockerHost,
    name: string,
    fingerprint: string,
    options: ServiceOptions,
  ): Promise<InspectedContainer> {
    try {
      await host.command([
        'create',
        '--rm',
        ...publish(options.internalPort),
        ...this.#args({
          ...options,
          name,
          labels: {
            ...options.labels,
            [SHARED_SERVER_LABEL]: '1',
            [CONFIG_LABEL]: fingerprint,
          },
        }),
        options.image,
        ...(options.command ?? []),
      ]);
    } catch (error) {
      if (
        !(error instanceof SubprocessError) ||
        !error.stderr.includes('is already in use by container')
      )
        throw error;
    }
    // A competing create reserves the name before Docker registers it for
    // inspection. Retry only that absence, not daemon or permission errors.
    const pending = new Error(`Container ${name} is not visible yet`);
    return timebox(
      async () => {
        const container = await this.#inspect(host, name);
        if (!container) throw pending;
        return container;
      },
      { shouldRetry: ({ error }) => error === pending },
    );
  }

  async #detach(
    host: DockerHost,
    flags: string[],
    options: ContainerOptions,
  ): Promise<string> {
    const id = (
      await this.#launch(host, ['run', '--detach', ...flags], options)
    ).trim();
    if (!id)
      throw new Error(`Docker started no container from ${options.image}`);
    return id;
  }

  async #launch(
    host: DockerHost,
    verb: string[],
    options: ContainerOptions,
  ): Promise<string> {
    const name =
      options.name ??
      `test-${options.image.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomUUID()}`;
    const labels = { ...options.labels, ...this.defaults.labels };
    const { stdout } = await host.command([
      ...verb,
      ...this.#args({ ...options, name, labels }),
      options.image,
      ...(options.command ?? []),
    ]);
    return stdout;
  }

  #fingerprint(options: ServiceOptions): string {
    const { resources } = this.defaults;
    return createHash('sha256')
      .update(
        JSON.stringify({
          transportVersion: 2,
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

  #args(options: ContainerOptions & { name: string }): string[] {
    const { resources } = this.defaults;
    return [
      '--name',
      options.name,
      ...(options.hostname ? ['--hostname', options.hostname] : []),
      ...labelArgs(options.labels ?? {}),
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => [
        '-e',
        `${key}=${value}`,
      ]),
      ...(options.mounts ?? []).flatMap(({ source, target, readOnly }) => [
        '--volume',
        `${source}:${target}${readOnly ? ':ro' : ''}`,
      ]),
      ...(options.tmpfs ?? []).flatMap((spec) => ['--tmpfs', spec]),
      ...(options.ipcHost ? ['--ipc=host'] : []),
      ...(options.memorySwappiness === undefined
        ? []
        : [`--memory-swappiness=${options.memorySwappiness}`]),
      '--memory',
      options.memory ?? resources.memory,
      '--cpus',
      String(options.cpus ?? resources.cpus),
    ];
  }

  async #inspect(
    host: DockerHost,
    name: string,
  ): Promise<InspectedContainer | undefined> {
    try {
      const { stdout } = await host.command(['container', 'inspect', name]);
      const [container]: InspectedContainer[] = JSON.parse(stdout);
      return container;
    } catch (error) {
      if (
        error instanceof SubprocessError &&
        /No such (object|container):/i.test(error.stderr)
      )
        return undefined;
      throw error;
    }
  }

  async #ready(
    host: DockerHost,
    id: string,
    { internalPort, healthy }: ServiceOptions,
  ): Promise<ServiceContainer> {
    const { stdout } = await host.command(['port', id, String(internalPort)]);
    const port = /:(\d+)$/.exec(stdout.trim())?.[1];
    if (!port)
      throw new Error(
        `Failed to get mapped port for container ${id}: ${stdout}`,
      );
    const connection = await host.forward(
      Number.parseInt(port, 10),
      this.#testRun,
    );
    const container = new ServiceContainer(
      id,
      connection.port,
      host.command,
      connection.close,
    );
    try {
      await healthy?.(container);
      return container;
    } catch (error) {
      await container.disconnect();
      throw error;
    }
  }
}
