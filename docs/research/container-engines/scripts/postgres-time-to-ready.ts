// Experiment 2, postgres-time-to-ready: one slot of runs on one engine, through @zukhruf/docker.
// postgres-time-to-ready.zsh calls it once per slot; run it through that wrapper.
//
// Usage: node --conditions=@zukhruf/source postgres-time-to-ready.ts --engine <name>
//          --host <unix://socket> --slot <slot> --image <ref> --label <key=value>
//          --name-prefix <prefix> --out <slot.json> [--ip-path] [--runs N] [--cpus N] [--memory 1g]
//          [--dry-run]
// --engine is the label of the engine table in lib.zsh; --host is the socket that reaches it.
//
// Each run creates the container with the body of packages/testing/src/databases/postgres.ts
// (its Env and MemorySwappiness 0) plus the shared limits, starts it, and polls until Postgres
// answers, then removes it. The data folder is on tmpfs through HostConfig.Mounts on every engine:
// socktainer ignores HostConfig.Tmpfs (backlog #4434) but honours a tmpfs mount.
//
// Three independent loops poll every --interval-ms until each succeeds or --cap-ms passes:
//   oracle     exec `pg_isready -h 127.0.0.1` in the container, as packages/testing does (TCP,
//              so the socket-only init server of the entrypoint does not count)
//   published  a TCP connect to the published 127.0.0.1 port, then a Postgres SSLRequest; only
//              the server itself answers it with 'S' or 'N', so a port forwarder that accepts
//              the connect before Postgres listens does not count
//   ip         the same probe on <container IP>:5432; only with --ip-path, which the wrapper
//              passes where the Mac reaches container IPs (Apple; not Docker Desktop or Colima)
// ready_published_ms = max(oracle, published answer); ready_ip_ms = max(oracle, ip answer).
// Every time is in ms from t0, taken just before the create, except start_ms and remove_ms.
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { Docker, type EngineApi, type OwnedContainer } from '@zukhruf/docker';

const { values } = parseArgs({
  options: {
    engine: { type: 'string' },
    host: { type: 'string' },
    slot: { type: 'string' },
    image: { type: 'string' },
    label: { type: 'string' },
    'name-prefix': { type: 'string' },
    out: { type: 'string' },
    runs: { type: 'string', default: '10' },
    cpus: { type: 'string', default: '2' },
    memory: { type: 'string', default: '1g' },
    'interval-ms': { type: 'string', default: '50' },
    'cap-ms': { type: 'string', default: '60000' },
    'ip-path': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '')
    throw new Error(`--${name} is required`);
  return value;
}

function positive(name: keyof typeof values): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} takes a positive whole number`);
  return value;
}

function bytes(text: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(text);
  if (!match) throw new Error(`--memory takes a size such as 1g, not ${text}`);
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    match[2]!.toLowerCase() as '' | 'k' | 'm' | 'g'
  ];
  return Number(match[1]) * unit;
}

const engine = required('engine');
if (!/^[a-z][a-z0-9-]*$/.test(engine))
  throw new Error('--engine takes an engine name such as docker or colima');
const ipPath = values['ip-path']!;
const host = required('host');
const slot = required('slot');
const image = required('image');
const [labelKey, labelValue] = required('label').split('=');
if (!labelKey || labelValue === undefined)
  throw new Error('--label takes key=value');
const namePrefix = required('name-prefix');
const out = required('out');
const runs = positive('runs');
const cpus = positive('cpus');
const intervalMs = positive('interval-ms');
const capMs = positive('cap-ms');
const user = 'postgres';

const body: EngineApi.ContainerCreateRequest = {
  Image: image,
  Labels: { [labelKey]: labelValue },
  Env: [
    'POSTGRES_PASSWORD=testpassword',
    'POSTGRES_DB=testdb',
    `POSTGRES_USER=${user}`,
  ],
  ExposedPorts: { '5432/tcp': {} },
  HostConfig: {
    PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    Mounts: [
      {
        Type: 'tmpfs',
        Target: '/var/lib/postgresql',
        TmpfsOptions: { SizeBytes: 512 * 1024 ** 2, Mode: 0o1777 },
      },
    ],
    MemorySwappiness: 0,
    NanoCpus: cpus * 1e9,
    Memory: bytes(values.memory!),
  },
};
const oracleCmd = ['pg_isready', '-h', '127.0.0.1', '-U', user, '-t', '1'];

if (values['dry-run']) {
  console.log(
    [
      `slot ${slot} on ${engine} (${host}): 1 first run, then ${runs} runs; each:`,
      `  create ${namePrefix}-pg-${slot}-<n> with ${JSON.stringify(body)}`,
      '  start; read container.port(5432)' +
        (ipPath ? ' and the container IP from an inspect' : ''),
      `  poll every ${intervalMs} ms, cap ${capMs} ms: exec ${oracleCmd.join(' ')}; SSLRequest to 127.0.0.1:<port>` +
        (ipPath ? '; SSLRequest to <ip>:5432' : ''),
      '  remove { force: true, v: true }',
      `  write ${out}`,
    ].join('\n'),
  );
  process.exit(0);
}

type Metric = number | null;
type MetricName =
  | 'create_ms'
  | 'start_ms'
  | 'oracle_ms'
  | `${'published' | 'ip'}_${'tcp' | 'answer'}_ms`
  | `ready_${'published' | 'ip'}_ms`
  | 'remove_ms'
  | 'total_ms';

interface Run {
  index: number;
  startedUtc: string;
  name: string;
  id?: string;
  published?: { host: string; port: number };
  ip?: string;
  attempts: Record<string, number>;
  lastProbeErrors: Record<string, string>;
  metrics: Record<MetricName, Metric>;
  error?: string;
}

interface Probe {
  connected: boolean;
  answered: boolean;
  connectedAt?: number;
  error?: string;
}

/** A TCP connect and a Postgres SSLRequest; it never half-closes (Apple's forwarder drops a half-closed connection). */
function sslRequest(
  hostname: string,
  port: number,
  now: () => number,
): Promise<Probe> {
  return new Promise((resolve) => {
    const result: Probe = { connected: false, answered: false };
    const socket = connect({ host: hostname, port });
    const finish = (error?: Error) => {
      if (error) result.error = error.message;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => finish(new Error('timeout')));
    socket.once('error', finish);
    socket.once('close', () => finish());
    socket.once('connect', () => {
      result.connected = true;
      result.connectedAt = now();
      socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));
    });
    socket.once('data', (data) => {
      result.answered = data[0] === 0x53 || data[0] === 0x4e;
      if (!result.answered) result.error = `answer byte ${data[0]}`;
      finish();
    });
  });
}

async function measure(docker: Docker, index: number): Promise<Run> {
  const name = `${namePrefix}-pg-${slot}-${index}`;
  const run: Run = {
    index,
    startedUtc: new Date().toISOString(),
    name,
    attempts: {},
    lastProbeErrors: {},
    metrics: {
      create_ms: null,
      start_ms: null,
      oracle_ms: null,
      published_tcp_ms: null,
      published_answer_ms: null,
      ready_published_ms: null,
      ip_tcp_ms: null,
      ip_answer_ms: null,
      ready_ip_ms: null,
      remove_ms: null,
      total_ms: null,
    },
  };
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  let container: OwnedContainer | undefined;
  // Set when the run ends early, so that no loop goes on polling a removed container.
  let stopped = false;
  try {
    container = await docker.containers.create(body, { name });
    run.id = container.id;
    const created = now();
    run.metrics.create_ms = created;
    await container.start();
    const started = now();
    run.metrics.start_ms = started - created;
    const deadline = started + capMs;

    const poll = async (
      key: string,
      attempt: () => Promise<boolean>,
    ): Promise<void> => {
      run.attempts[key] = 0;
      while (!stopped && now() < deadline) {
        run.attempts[key] += 1;
        if (await attempt()) return;
        await sleep(intervalMs);
      }
    };
    const owned = container;
    const oracle = poll('oracle', async () => {
      try {
        const { exitCode } = await owned.exec(
          { Cmd: oracleCmd },
          { signal: AbortSignal.timeout(5000) },
        );
        if (exitCode !== 0) return false;
        run.metrics.oracle_ms = now();
        return true;
      } catch (error) {
        run.lastProbeErrors.oracle = String(error);
        return false;
      }
    });
    const endpoint = (
      prefix: 'published' | 'ip',
      hostname: string,
      port: number,
    ) =>
      poll(prefix, async () => {
        const probe = await sslRequest(hostname, port, now);
        if (probe.connected)
          run.metrics[`${prefix}_tcp_ms`] ??= probe.connectedAt!;
        if (probe.error) run.lastProbeErrors[prefix] = probe.error;
        if (!probe.answered) return false;
        run.metrics[`${prefix}_answer_ms`] = now();
        return true;
      });

    const [published, inspect] = await Promise.all([
      owned.port(5432),
      ipPath ? owned.inspect() : undefined,
    ]);
    if (!published) throw new Error('5432/tcp is not published');
    run.published = published;
    const loops = [
      oracle,
      endpoint('published', published.host, published.port),
    ];
    if (inspect) {
      const ip = Object.values(inspect.NetworkSettings?.Networks ?? {})
        .map((network) => network.IPAddress)
        .find((address) => address);
      if (ip) {
        run.ip = ip;
        loops.push(endpoint('ip', ip, 5432));
      } else {
        run.lastProbeErrors.ip = 'the inspect gives no IPAddress';
      }
    }
    await Promise.all(loops);

    const latestOf = (a: Metric, b: Metric) =>
      a === null || b === null ? null : Math.max(a, b);
    run.metrics.ready_published_ms = latestOf(
      run.metrics.oracle_ms,
      run.metrics.published_answer_ms,
    );
    if (ipPath)
      run.metrics.ready_ip_ms = latestOf(
        run.metrics.oracle_ms,
        run.metrics.ip_answer_ms,
      );
    if (run.metrics.ready_published_ms === null)
      throw new Error(`not ready within ${capMs} ms`);
    if (ipPath && run.metrics.ready_ip_ms === null)
      throw new Error(`not ready on the container IP within ${capMs} ms`);
  } catch (error) {
    run.error = String(error);
  } finally {
    stopped = true;
    if (container) {
      const removing = now();
      try {
        await container.remove({ force: true, v: true });
        run.metrics.remove_ms = now() - removing;
        run.metrics.total_ms = now();
      } catch (error) {
        run.error = `${run.error ?? ''} remove: ${String(error)}`.trim();
      }
    }
  }
  return run;
}

const startedUtc = new Date().toISOString();
await using docker = await Docker.connect({ clock: globalThis, host });
const results: Run[] = [];
for (let index = 0; index <= runs; index += 1) {
  const run = await measure(docker, index);
  results.push(run);
  const ready = run.metrics.ready_published_ms;
  console.log(
    `   ${index === 0 ? 'first' : `run ${index}`}: ready ${ready === null ? '-' : Math.round(ready)} ms` +
      (ipPath
        ? `, on the IP ${run.metrics.ready_ip_ms === null ? '-' : Math.round(run.metrics.ready_ip_ms)} ms`
        : '') +
      (run.error ? `  FAILED ${run.error}` : ''),
  );
}

writeFileSync(
  out,
  `${JSON.stringify(
    {
      experiment: 'postgres-time-to-ready',
      engine,
      slot,
      host,
      ipPath,
      apiVersion: docker.apiVersion,
      startedUtc,
      endedUtc: new Date().toISOString(),
      body,
      oracle: oracleCmd,
      intervalMs,
      capMs,
      first: results[0],
      runs: results.slice(1),
    },
    null,
    2,
  )}\n`,
);
