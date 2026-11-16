// Experiment 7, attach-round-trip: one slot of cat leases on one engine, through @zukhruf/docker.
// attach-round-trip.zsh calls it once per slot; run it through that wrapper.
//
// Usage: node --conditions=@zukhruf/source attach-round-trip.ts --engine <name>
//          --host <unix://socket> --slot <slot> --image <alpine ref> --label <key=value>
//          --name-prefix <prefix> --out <slot.json> [--containers N] [--writes N] [--cpus N]
//          [--memory 1g] [--dry-run]
//
// The container has the lease shape of packages/testing and the mutex store: `cat -` on an open,
// once-only stdin, AutoRemove. It is attached with stdin before its start. Per container:
//   create_ms              the create call
//   attach_ms              attach({ stdin: true }) on the created container
//   start_ms               the start call
//   round_trip_ms          --writes values: a 32-byte line written to stdin until cat echoes it
//                          on stdout, one line at a time
//   close_to_exit_ms       stdin closed until the attach's exitCode resolves
//   exit_to_removed_ms     exitCode until containers.inspect() gives undefined (404), polled
//                          every 10 ms
//   exit_to_removed_wait_ms  exitCode until wait({ condition: 'removed' }), sent before the
//                          start, resolves; null when the engine rejects that wait
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { Docker, type EngineApi, type OwnedContainer } from '@zukhruf/docker';

import { engineId } from './engine-id.ts';

const { values } = parseArgs({
  options: {
    engine: { type: 'string' },
    host: { type: 'string' },
    slot: { type: 'string' },
    image: { type: 'string' },
    label: { type: 'string' },
    'name-prefix': { type: 'string' },
    out: { type: 'string' },
    containers: { type: 'string', default: '10' },
    writes: { type: 'string', default: '20' },
    cpus: { type: 'string', default: '2' },
    memory: { type: 'string', default: '1g' },
    'cap-ms': { type: 'string', default: '60000' },
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
if (!new RegExp(`^${engineId}$`).test(engine))
  throw new Error('--engine takes an engine name such as docker or colima');
const host = required('host');
const slot = required('slot');
const image = required('image');
const [labelKey, labelValue] = required('label').split('=');
if (!labelKey || labelValue === undefined)
  throw new Error('--label takes key=value');
const namePrefix = required('name-prefix');
const out = required('out');
const containers = positive('containers');
const writes = positive('writes');
const cpus = positive('cpus');
const capMs = positive('cap-ms');

const body: EngineApi.ContainerCreateRequest = {
  Image: image,
  Entrypoint: ['cat'],
  Cmd: ['-'],
  OpenStdin: true,
  StdinOnce: true,
  AttachStdin: true,
  Labels: { [labelKey]: labelValue },
  HostConfig: {
    AutoRemove: true,
    NanoCpus: cpus * 1e9,
    Memory: bytes(values.memory!),
  },
};
const LINE_BYTES = 32;

if (values['dry-run']) {
  console.log(
    [
      `slot ${slot} on ${engine} (${host}): 1 first container, then ${containers}; each:`,
      `  create ${namePrefix}-rt-${slot}-<n> with ${JSON.stringify(body)}`,
      "  wait({ condition: 'removed' }) in the background; attach({ stdin: true }); start",
      `  ${writes} x: write a ${LINE_BYTES}-byte line, read stdout until it comes back`,
      '  close stdin; await exitCode; poll containers.inspect() every 10 ms until it gives undefined',
      `  cap ${capMs} ms per container; write ${out}`,
    ].join('\n'),
  );
  process.exit(0);
}

type Metric = number | number[] | null;

interface Run {
  index: number;
  startedUtc: string;
  name: string;
  id?: string;
  exitCode?: number;
  waitRemovedError?: string;
  metrics: Record<string, Metric>;
  error?: string;
}

function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms, undefined, { ref: false }).then(() => {
      throw new Error(`${what}: no answer in ${ms} ms`);
    }),
  ]);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function line(index: number, write: number): string {
  const text = `rt-${slot}-${index}-${write}-`.padEnd(LINE_BYTES - 1, 'x');
  if (text.length !== LINE_BYTES - 1)
    throw new Error(`the line ${text} is longer than ${LINE_BYTES} bytes`);
  return `${text}\n`;
}

async function measure(docker: Docker, index: number): Promise<Run> {
  const name = `${namePrefix}-rt-${slot}-${index}`;
  const run: Run = {
    index,
    startedUtc: new Date().toISOString(),
    name,
    metrics: {
      create_ms: null,
      attach_ms: null,
      start_ms: null,
      round_trip_ms: null,
      close_to_exit_ms: null,
      exit_to_removed_ms: null,
      exit_to_removed_wait_ms: null,
    },
  };
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  let container: OwnedContainer | undefined;
  try {
    container = await within(
      capMs,
      'create',
      docker.containers.create(body, { name }),
    );
    run.id = container.id;
    const created = now();
    run.metrics.create_ms = created;

    let removedAt: number | undefined;
    const removedByWait = container
      .wait({ condition: 'removed', signal: AbortSignal.timeout(capMs) })
      .then(
        () => {
          removedAt = now();
        },
        (error: unknown) => {
          run.waitRemovedError = String(error);
        },
      );

    const lease = await within(
      capMs,
      'attach',
      container.attach({ stdin: true }),
    );
    const attached = now();
    run.metrics.attach_ms = attached - created;
    await within(capMs, 'start', container.start());
    const started = now();
    run.metrics.start_ms = started - attached;

    const writer = lease.stdin!.getWriter();
    const chunks = lease[Symbol.asyncIterator]();
    const roundTrips: number[] = [];
    let echoed = '';
    for (let write = 1; write <= writes; write += 1) {
      const text = line(index, write);
      const sent = now();
      await within(capMs, 'write', writer.write(encoder.encode(text)));
      while (!echoed.includes(text)) {
        const next = await within(capMs, 'echo', chunks.next());
        if (next.done) throw new Error('the output ended before the echo');
        if (next.value.stream === 'stdout')
          echoed += decoder.decode(next.value.data);
      }
      roundTrips.push(now() - sent);
      echoed = echoed.slice(echoed.indexOf(text) + text.length);
    }
    run.metrics.round_trip_ms = roundTrips;

    const closing = now();
    await within(capMs, 'close', writer.close());
    const drained = (async () => {
      while (!(await chunks.next()).done);
    })();
    run.exitCode = await within(capMs, 'exitCode', lease.exitCode);
    const exited = now();
    run.metrics.close_to_exit_ms = exited - closing;
    await drained.catch(() => undefined);

    while ((await docker.containers.inspect(container.id)) !== undefined) {
      if (now() - exited > capMs)
        throw new Error(`not removed within ${capMs} ms of the exit`);
      await sleep(10);
    }
    run.metrics.exit_to_removed_ms = now() - exited;
    await within(capMs, 'wait removed', removedByWait);
    if (removedAt !== undefined)
      run.metrics.exit_to_removed_wait_ms = removedAt - exited;
  } catch (error) {
    run.error = String(error);
    await container
      ?.remove({ force: true, v: true })
      .catch((removal: unknown) => {
        run.error += ` remove: ${String(removal)}`;
      });
  }
  return run;
}

const startedUtc = new Date().toISOString();
await using docker = await Docker.connect({ clock: globalThis, host });
const results: Run[] = [];
for (let index = 0; index <= containers; index += 1) {
  const run = await measure(docker, index);
  results.push(run);
  const trips = run.metrics.round_trip_ms;
  const median = Array.isArray(trips)
    ? trips.toSorted((a, b) => a - b)[Math.floor(trips.length / 2)]!
    : null;
  console.log(
    `   ${index === 0 ? 'first' : `container ${index}`}: round trip ~${median === null ? '-' : median.toFixed(1)} ms, close to exit ${run.metrics.close_to_exit_ms === null ? '-' : Math.round(run.metrics.close_to_exit_ms as number)} ms` +
      (run.error ? `  FAILED ${run.error}` : ''),
  );
}

writeFileSync(
  out,
  `${JSON.stringify(
    {
      experiment: 'attach-round-trip',
      engine,
      slot,
      host,
      apiVersion: docker.apiVersion,
      startedUtc,
      endedUtc: new Date().toISOString(),
      body,
      lineBytes: LINE_BYTES,
      writes,
      capMs,
      first: results[0],
      runs: results.slice(1),
    },
    null,
    2,
  )}\n`,
);
