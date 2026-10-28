import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  type Container,
  ContainerNotFoundError,
  Docker,
  ImageNotFoundError,
} from '@zukhruf/docker';

import {
  type Collector,
  KIND_LABEL,
  type Kind,
  ownedBy,
} from '../databases/collector.ts';
import {
  EngineLease,
  LEASE_IMAGE,
  LEASE_LABEL,
  sweepLeaseName,
} from '../docker/engine-lease.ts';
import { DockerHost, SHELL_TIMEOUT, quote } from '../docker/host.ts';
import {
  TEST_RUN_LABEL,
  directoryPrefix,
  forwardPrefix,
} from '../docker/run-records.ts';
import {
  PACKAGE_VERSION,
  SHARED_SERVER_LABEL,
  VERSION_LABEL,
} from '../docker/testbed.ts';

/** How long one Engine API call of the cleanup may take. */
export const ENGINE_CALL_TIMEOUT = 240_000;

/** What the global setup writes to run.json. */
export interface Run {
  id: string;
  endpoint: string;
  pid: number;
}

const execute = promisify(execFile);

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

/**
 * The collector of each kind, loaded when a server of the kind runs. A
 * driver is an optional peer dependency: without it, the run's test
 * processes could not create a database of the kind.
 */
const collectors: Record<
  Kind,
  { driver?: string; load: () => Promise<Collector<unknown>> }
> = {
  postgres: {
    load: async () =>
      (await import('../databases/postgres-collector.ts')).postgres,
  },
  mysql: {
    load: async () =>
      (await import('../databases/mysql-family-collector.ts')).mysql,
  },
  mariadb: {
    load: async () =>
      (await import('../databases/mysql-family-collector.ts')).mariadb,
  },
  sqlserver: {
    driver: 'mssql',
    load: async () =>
      (await import('../databases/sqlserver-collector.ts')).sqlserver,
  },
};

const isKind = (value: string | undefined): value is Kind =>
  value !== undefined && Object.hasOwn(collectors, value);

/** The collector of `kind`, or undefined when its driver is not installed. */
async function collectorOf(
  kind: Kind,
): Promise<Collector<unknown> | undefined> {
  const { driver, load } = collectors[kind];
  if (driver !== undefined)
    try {
      await import(driver);
    } catch (error) {
      if (codeOf(error) === 'ERR_MODULE_NOT_FOUND') return undefined;
      throw error;
    }
  return load();
}

const running = async (container: Container): Promise<boolean> =>
  (await container.inspect().catch(() => undefined))?.State?.Running === true;

/**
 * Drops the run's databases on each running shared server of a database
 * fixture. A server that stops takes its databases with it. A server that
 * does not answer yet holds none: a fixture creates a database only after
 * the server answered its readiness check. Each list and drop has the
 * deadline of one engine call.
 */
async function dropDatabases(
  engine: Docker,
  host: DockerHost,
  runId: string,
  signal: () => AbortSignal,
): Promise<void> {
  for (const summary of await engine.containers.list({
    filters: { label: [`${SHARED_SERVER_LABEL}=1`, KIND_LABEL] },
    signal: signal(),
  })) {
    const kind = summary.Labels?.[KIND_LABEL];
    if (!isKind(kind)) continue;
    const collector = await collectorOf(kind);
    if (!collector) continue;
    const container = await engine.containers.find(summary.Id, {
      signal: signal(),
    });
    if (!container) continue;
    // Another run's teardown can remove it after the find.
    const inspected = await container
      .inspect({ signal: signal() })
      .catch((error: unknown) => {
        if (error instanceof ContainerNotFoundError) return undefined;
        throw error;
      });
    if (!inspected?.State?.Running) continue;
    const environment = Object.fromEntries(
      (inspected.Config?.Env ?? []).map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    await using connection = new AsyncDisposableStack();
    let server: unknown;
    let names: string[];
    try {
      server = connection.use(
        await collector.open(container, environment, host),
      );
      names = await collector.list(server, { signal: signal() });
    } catch {
      continue;
    }
    for (const name of names.filter(ownedBy(runId))) {
      const deadline = signal();
      try {
        await collector.drop(server, name, { signal: deadline });
      } catch (error) {
        // A server that does not answer within the deadline keeps the run's
        // databases, as one whose list fails: a hung shared server neither
        // fails nor hangs this cleanup.
        if (deadline.aborted) break;
        if (await running(container)) throw error;
      }
    }
  }
}

async function readRecordedPath(file: string): Promise<string> {
  const { path }: { path: string } = JSON.parse(await readFile(file, 'utf8'));
  return path;
}

/**
 * Removes what carries the run's label and what its records name, on the
 * engine that `engine` is connected to.
 */
export async function cleanup(
  engine: Docker,
  previous: Run,
  directory: string,
): Promise<void> {
  const host = new DockerHost(previous.endpoint, undefined);
  const signal = () => AbortSignal.timeout(ENGINE_CALL_TIMEOUT);
  // Labels are attached atomically at creation. Never prune an engine,
  // remove a shared server here, or trust names alone as proof of ownership.
  const filters = { label: [`${TEST_RUN_LABEL}=${previous.id}`] };
  for (const summary of await engine.containers.list({
    all: true,
    filters,
    signal: signal(),
  })) {
    if (summary.Labels?.[SHARED_SERVER_LABEL] === '1') continue;
    const container = await engine.containers.find(summary.Id, {
      signal: signal(),
    });
    await container?.remove({ force: true, v: true, signal: signal() });
  }
  for (const { Name } of await engine.volumes.list({
    filters,
    signal: signal(),
  })) {
    const volume = await engine.volumes.find(Name, { signal: signal() });
    await volume?.remove({ signal: signal() });
  }
  for (const file of await readdir(directory)) {
    if (file.startsWith('forward-')) {
      const path = await readRecordedPath(join(directory, file));
      if (
        !path.startsWith(forwardPrefix(previous.id)) ||
        path.slice(5).includes('/')
      )
        throw new Error(`Invalid SSH forwarding cleanup record: ${path}`);
      await rm(path, { recursive: true, force: true });
    } else if (file.startsWith('directory-')) {
      const path = await readRecordedPath(join(directory, file));
      if (
        !path.includes(`/${directoryPrefix(previous.id)}`) ||
        path.includes('/../')
      )
        throw new Error(`Invalid fixture cleanup record: ${path}`);
      if (host.remote)
        await execute('ssh', [...host.sshArgs(), `rm -rf -- ${quote(path)}`], {
          timeout: SHELL_TIMEOUT,
        });
      else await rm(path, { recursive: true, force: true });
    }
  }
  await dropDatabases(engine, host, previous.id, signal);
}

/** The tries of a teardown to take a sweep lease that another holder has. */
const SWEEP_LEASE_TRIES = 3;

/** How long a teardown waits for the sweep lease of one version that another holder has. */
const SWEEP_LEASE_WAIT = 30_000;

/**
 * Takes the sweep lease of `version`, and pulls its image when the engine
 * does not have it. When the name is taken, it waits until that lease is
 * gone, as a test process does, and tries again: a teardown killed before
 * the start of its lease leaves it created, and the wait removes it. Gives
 * undefined when each try found the name taken, or when the wait took
 * longer than SWEEP_LEASE_WAIT: the servers of the version stay for a
 * later teardown, and another teardown's sweep never fails this run.
 */
async function takeSweepLease(
  engine: Docker,
  version: string,
  signal: () => AbortSignal,
): Promise<EngineLease | undefined> {
  const name = sweepLeaseName(version);
  const take = () =>
    EngineLease.take(
      engine,
      { [LEASE_LABEL]: 'sweep', [VERSION_LABEL]: version },
      { name, signal: signal() },
    );
  const wait = AbortSignal.timeout(SWEEP_LEASE_WAIT);
  for (let tries = 0; tries < SWEEP_LEASE_TRIES; tries += 1) {
    let lease: EngineLease | undefined;
    try {
      lease = await take();
    } catch (error) {
      if (!(error instanceof ImageNotFoundError)) throw error;
      await engine.images.pull(LEASE_IMAGE, { signal: signal() });
      lease = await take();
    }
    if (lease !== undefined) return lease;
    try {
      await EngineLease.gone(engine, name, { signal: wait });
    } catch (error) {
      if (wait.aborted) return undefined;
      throw error;
    }
  }
  return undefined;
}

/**
 * Removes each shared server whose version label is not this package's
 * version (ADR 0012), unless a test process of that version holds a process
 * lease (ADR 0014). The sweep lease of the version comes first, and the look
 * for process leases after it. A server with no version label has no lease.
 */
async function removeOtherVersions(engine: Docker): Promise<void> {
  const signal = () => AbortSignal.timeout(ENGINE_CALL_TIMEOUT);
  const versions = Map.groupBy(
    (
      await engine.containers.list({
        all: true,
        filters: { label: [`${SHARED_SERVER_LABEL}=1`] },
        signal: signal(),
      })
    ).filter(({ Labels }) => Labels?.[VERSION_LABEL] !== PACKAGE_VERSION),
    ({ Labels }) => Labels?.[VERSION_LABEL],
  );
  for (const [version, servers] of versions) {
    await using lease =
      version === undefined
        ? undefined
        : await takeSweepLease(engine, version, signal);
    if (version !== undefined) {
      // Other teardowns held the sweep lease on each try.
      if (lease === undefined) continue;
      const holders = await engine.containers.list({
        filters: {
          label: [`${LEASE_LABEL}=process`, `${VERSION_LABEL}=${version}`],
        },
        signal: signal(),
      });
      if (holders.length > 0) continue;
    }
    for (const { Id } of servers) {
      // Another run's teardown can remove it first.
      const container = await engine.containers.find(Id, { signal: signal() });
      await container?.remove({ force: true, v: true, signal: signal() });
    }
  }
}

/**
 * Connects to the run's engine, cleans the run, removes the shared servers
 * of other versions, and ends the connection. Only the global teardown
 * calls it, for a run that used Docker.
 */
export async function connectAndCleanup(
  previous: Run,
  directory: string,
): Promise<void> {
  // Disposal ends the connection, and with it the ssh child of an SSH engine.
  await using engine = await Docker.connect({
    host: previous.endpoint,
    signal: AbortSignal.timeout(ENGINE_CALL_TIMEOUT),
  });
  await cleanup(engine, previous, directory);
  await removeOtherVersions(engine);
}
