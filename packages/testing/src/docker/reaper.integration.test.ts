import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ContainerNotFoundError } from '@zukhruf/docker';
import { TemporaryFiles } from '@zukhruf/fs';

import { engine, proxyless } from '../testing/current-engine.ts';
import { docker } from '../testing/engine-client.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';
import {
  REAPER_DEFAULTS,
  REAPER_IMAGE,
  REAPER_LABEL,
  type ReaperSettings,
  SERVER_LABEL,
  reaperName,
  reaperRequest,
  startReaper,
} from './reaper.ts';

const RUN_LABEL = 'dev.zukhruf.testing.run';
const KIND_LABEL = 'dev.zukhruf.testing.kind';

/** Short inputs, as the tests of Ryuk give it (ADR 0020, item 4). */
const quick: ReaperSettings = {
  ...REAPER_DEFAULTS,
  grace: 300,
  interval: 200,
  passes: 2,
  requestTimeout: 3_000,
  retries: 2,
};

/** A Node process that runs `source`, with `Docker`, `ReaperHold` and `DockerTestbed` in scope, and the lines it prints. */
interface Program {
  child: ChildProcess;
  /** The next line that the program printed. Rejects when it exits first. */
  line(): Promise<string>;
  /** Writes a line to its standard input. */
  send(text: string): void;
}

function program(
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): Program {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { Docker } from ${JSON.stringify(import.meta.resolve('@zukhruf/docker'))};
        import { ReaperHold } from ${JSON.stringify(new URL('./reaper.ts', import.meta.url).href)};
        import { DockerTestbed } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
        ${source}
      `,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], env },
  );
  const lines = createInterface({ input: child.stdout! })[
    Symbol.asyncIterator
  ]();
  const exited = once(child, 'exit').then(([code]) => {
    throw new Error(`The program exited with ${String(code)}`);
  });
  exited.catch(() => {});
  return {
    child,
    line: async () => {
      const next = await Promise.race([lines.next(), exited]);
      if (next.done === true) throw new Error('The program closed its output');
      return next.value;
    },
    send: (text) => child.stdin!.write(`${text}\n`),
  };
}

/** A process that holds the reaper of `run` with `settings`, prints a line, and lives until it is killed. */
async function holder(
  run: string,
  settings: ReaperSettings,
): Promise<ChildProcess> {
  const { child, line } = program(`
    const docker = await Docker.connect({ clock: globalThis, environment: process.env });
    await ReaperHold.take(docker, ${JSON.stringify(run)}, ${JSON.stringify(settings)}, globalThis);
    console.log('held');
    setInterval(() => {}, 60_000);
  `);
  assert.equal(await line(), 'held');
  return child;
}

/**
 * A process that holds the reaper of `run` with `settings`, then creates and
 * starts a container of the run, prints its id, and lives until it is killed.
 */
function creator(run: string, settings: ReaperSettings): Program {
  return program(`
    const docker = await Docker.connect({ clock: globalThis, environment: process.env });
    await ReaperHold.take(docker, ${JSON.stringify(run)}, ${JSON.stringify(settings)}, globalThis);
    const container = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '3600'],
      Labels: { ${JSON.stringify(RUN_LABEL)}: ${JSON.stringify(run)} },
    });
    await container.start();
    console.log(container.id);
    setInterval(() => {}, 60_000);
  `);
}

/**
 * A test process of the run `run` whose records are in `records`: it holds
 * the run's reaper through `DockerTestbed.defaults()` once, prints the labels
 * as JSON, and then, for each line `create`, creates a container with those labels through
 * a client of its own, as a sandbox launcher does, and prints its id.
 */
function launcher(run: string, records: string): Program {
  return program(
    `
      import { createInterface } from 'node:readline';
      const testbed = new DockerTestbed({ environment: process.env });
      const { Labels } = await testbed.defaults();
      const docker = await Docker.connect({ clock: globalThis, environment: process.env });
      console.log(JSON.stringify(Labels));
      for await (const command of createInterface({ input: process.stdin })) {
        if (command !== 'create') continue;
        const container = await docker.containers.create({ Image: 'alpine:latest', Cmd: ['sleep', '3600'], Labels });
        await container.start();
        console.log(container.id);
      }
    `,
    {
      ...process.env,
      ZUKHRUF_TESTING_RUN_ID: run,
      ZUKHRUF_TESTING_RUN_DIR: records,
    },
  );
}

async function killed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

/** A started container of the run `run`, with `labels` and an anonymous volume. */
async function object(
  run: string,
  labels: Record<string, string> = {},
): Promise<string> {
  const container = await docker.containers.create({
    Image: 'alpine:latest',
    Cmd: ['sleep', '3600'],
    Labels: { [RUN_LABEL]: run, ...labels },
    Volumes: { '/data': {} },
  });
  await container.start();
  return container.id;
}

const exists = async (id: string): Promise<boolean> =>
  (await docker.containers.find(id)) !== undefined;

const volumeExists = async (name: string): Promise<boolean> =>
  (await docker.volumes.find(name)) !== undefined;

const reapers = async (run: string): Promise<string[]> =>
  (
    await docker.containers.list({
      all: true,
      filters: { label: [`${REAPER_LABEL}=${run}`] },
    })
  ).map(({ Id }) => Id);

/** The PIDs of the `cat` processes in the reaper `id`: one for each holder. */
async function holdersOf(id: string): Promise<string[]> {
  const reaper = await docker.containers.find(id);
  if (reaper === undefined) return [];
  const { stdout } = await reaper.exec({ Cmd: ['pgrep', '-x', 'cat'] });
  return stdout.split('\n').filter((pid) => pid !== '');
}

/** The anonymous volumes of the container `id`. */
async function volumesOf(id: string): Promise<string[]> {
  const inspected = await (await docker.containers.find(id))?.inspect();
  return (inspected?.Mounts ?? []).flatMap(({ Name }) =>
    Name === undefined ? [] : [Name],
  );
}

/** Removes what the test made: the containers and volumes of `run`, its reaper, and `others`. */
async function removeRun(run: string, others: string[] = []): Promise<void> {
  const filters = {
    label: [`${RUN_LABEL}=${run}`],
  };
  for (const id of [
    ...(await reapers(run)),
    ...others,
    ...(await docker.containers.list({ all: true, filters })).map(
      ({ Id }) => Id,
    ),
  ])
    await (
      await docker.containers.find(id)
    )
      ?.remove({ force: true, v: true })
      .catch(() => {});
  for (const { Name } of await docker.volumes.list({ filters }))
    await (
      await docker.volumes.find(Name)
    )
      ?.remove({ force: true })
      .catch(() => {});
}

const gone = (t: TestContext, check: () => Promise<void>, timeout = 20_000) =>
  t.waitFor(check, { timeout, interval: 100 });

/** Resolves when the engine removed the container `id`; fails after `ms`. */
async function removed(id: string, ms = 20_000): Promise<void> {
  try {
    await (
      await docker.containers.find(id)
    )?.wait({ condition: 'removed', signal: AbortSignal.timeout(ms) });
  } catch (error) {
    if (!(error instanceof ContainerNotFoundError)) throw error;
  }
}

/** Resolves at the end of the next exec in the container `id`, from `since` on. */
async function execEnded(id: string, since: number, signal: AbortSignal) {
  for await (const _ of docker.events({
    since,
    filters: { container: [id], event: ['exec_die'] },
    signal,
  }))
    return;
}

/**
 * Starts the reaper of `run` with `settings`, and with no wait for a first
 * holder, with each of its engine requests through `proxy`, as moby-ryuk's
 * tests give its reaper a client that fails chosen calls. Its `docker` CLI
 * reads `DOCKER_HOST`, so the test points it at a TCP port of this process
 * that forwards to the proxy (as in docker-global-setup.integration.test.ts).
 */
async function proxiedReaper(
  stack: AsyncDisposableStack,
  proxy: EngineProxy,
  run: string,
  settings: ReaperSettings,
): Promise<string> {
  // Docker Desktop resolves host.docker.internal to this machine. On a native
  // Linux engine the reaper reaches this machine at the gateway of the
  // default bridge; the relay listens there only, never on every address.
  const resolves = await docker.containers.run({
    Image: 'alpine:latest',
    Cmd: ['getent', 'hosts', 'host.docker.internal'],
    HostConfig: { AutoRemove: true },
  });
  const desktop = resolves.exitCode === 0;
  const bridge = desktop
    ? undefined
    : await (await docker.networks.find('bridge'))?.inspect();
  const gateway = bridge?.IPAM?.Config?.[0]?.Gateway;
  assert.ok(desktop || gateway !== undefined, 'the bridge has a gateway');
  const socket = proxy.host.slice('unix://'.length);
  const relay = createServer((client) => {
    const upstream = connect(socket);
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  relay.listen(0, gateway ?? '127.0.0.1');
  await once(relay, 'listening');
  stack.defer(
    () => new Promise<void>((resolve) => relay.close(() => resolve())),
  );
  const address = relay.address();
  assert.ok(address !== null && typeof address === 'object');
  if ((await docker.images.inspect(REAPER_IMAGE)) === undefined)
    await docker.images.pull(REAPER_IMAGE);
  const body = reaperRequest(run, { ...settings, firstHolder: 0 });
  const reaper = await docker.containers.create(
    {
      ...body,
      Env: [
        ...(body.Env ?? []),
        `DOCKER_HOST=tcp://host.docker.internal:${address.port}`,
      ],
      HostConfig: {
        ...body.HostConfig,
        ...(desktop
          ? {}
          : { ExtraHosts: ['host.docker.internal:host-gateway'] }),
      },
    },
    { name: reaperName(run) },
  );
  await reaper.start();
  return reaper.id;
}

/** Holds the first request of the proxy to `method` `path` until release(). */
function holdFirst(proxy: EngineProxy, method: string, path: string) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  proxy.intercept(method, path, async () => {
    if (!first) return;
    first = false;
    reached.resolve();
    await release.promise;
  });
  return { reached: reached.promise, release: () => release.resolve() };
}

/** `promise`, or a rejection that names `what` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string) {
  const limit = AbortSignal.timeout(ms);
  return Promise.race([
    promise,
    once(limit, 'abort').then(() => {
      throw new Error(`${what} did not happen within ${ms} ms`);
    }),
  ]);
}

test('one reaper of a run keeps the run’s objects while one of its holders lives, and removes them, with their anonymous volumes, after the last one ended', async (t) => {
  const run = randomUUID();
  const holders: ChildProcess[] = [];
  try {
    holders.push(await holder(run, quick), await holder(run, quick));
    const id = await object(run);
    const anonymous = await volumesOf(id);
    const { name: volume } = await docker.volumes.create({
      Labels: { [RUN_LABEL]: run },
    });
    const reapersWhileHeld = await reapers(run);

    await killed(holders[0]!);
    // Longer than the grace and each pass of the reaper.
    await delay(quick.grace + quick.interval * quick.passes + 2_000);
    const keptWhileOneHolds = [await exists(id), await volumeExists(volume)];
    await killed(holders[1]!);

    assert.equal(reapersWhileHeld.length, 1);
    assert.deepEqual(keptWhileOneHolds, [true, true]);
    await gone(t, async () => {
      assert.equal(await exists(id), false);
      assert.equal(await volumeExists(volume), false);
      for (const name of anonymous)
        assert.equal(await volumeExists(name), false);
      assert.deepEqual(await reapers(run), []);
    });
  } finally {
    for (const child of holders) await killed(child);
    await removeRun(run);
  }
});

test('the reaper of a run keeps a shared server that carries the run’s label', async (t) => {
  const run = randomUUID();
  let child: ChildProcess | undefined;
  try {
    child = await holder(run, quick);
    const server = await object(run, { [SERVER_LABEL]: randomUUID() });
    const owned = await object(run);

    await killed(child);

    await gone(t, async () => {
      assert.equal(await exists(owned), false);
      assert.deepEqual(await reapers(run), []);
    });
    assert.equal(await exists(server), true);
  } finally {
    if (child) await killed(child);
    await removeRun(run);
  }
});

test('a holder that comes during the grace stops the countdown, and the reaper acts after that holder ended', async (t) => {
  const run = randomUUID();
  const settings = { ...quick, grace: 3_000 };
  const holders: ChildProcess[] = [];
  try {
    holders.push(await holder(run, settings));
    const id = await object(run);

    await killed(holders[0]!);
    holders.push(await holder(run, settings));
    await delay(settings.grace + settings.interval * settings.passes + 2_000);
    const keptWhileHeldAgain = await exists(id);
    await killed(holders[1]!);

    assert.equal(keptWhileHeldAgain, true);
    await gone(t, async () => assert.equal(await exists(id), false));
  } finally {
    for (const child of holders) await killed(child);
    await removeRun(run);
  }
});

test('a container that the engine creates after the first pass of the reaper is removed by a re-check pass', async (t) => {
  const run = randomUUID();
  const settings = { ...quick, grace: 300, interval: 1_500, passes: 2 };
  let child: ChildProcess | undefined;
  const ids: string[] = [];
  try {
    child = await holder(run, settings);
    ids.push(await object(run));
    await killed(child);
    // After the first pass, before the first re-check pass.
    await gone(t, async () => assert.equal(await exists(ids[0]!), false));

    ids.push(await object(run));

    await gone(t, async () => {
      assert.equal(await exists(ids[1]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  } finally {
    if (child) await killed(child);
    await removeRun(run, ids);
  }
});

test('a reaper whose removal fails tries it again one interval later, and removes the volume once the engine allows it', async (t) => {
  const run = randomUUID();
  const settings = { ...quick, interval: 500, passes: 0, retries: 8 };
  let child: ChildProcess | undefined;
  let user: string | undefined;
  try {
    child = await holder(run, settings);
    const { name: volume } = await docker.volumes.create({
      Labels: { [RUN_LABEL]: run },
    });
    // Not of the run: the engine refuses the removal of the volume until it is gone.
    const using = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '2'],
      HostConfig: { AutoRemove: true, Binds: [`${volume}:/data`] },
    });
    user = using.id;
    await using.start();

    await killed(child);

    await gone(t, async () => {
      assert.equal(await volumeExists(volume), false);
      assert.deepEqual(await reapers(run), []);
    });
  } finally {
    if (child) await killed(child);
    await removeRun(run, user === undefined ? [] : [user]);
  }
});

test('a reaper whose drop of a database never gets an answer ends within its request time limit, keeps that database, and removes the run’s containers', async (t) => {
  const run = randomUUID();
  const database = `test_${run.replaceAll('-', '')}_0123456789abcdef`;
  const settings = { ...quick, grace: 100, passes: 0, requestTimeout: 1_000 };
  let child: ChildProcess | undefined;
  let server: string | undefined;
  try {
    // A shared Postgres server whose psql lists the run's database and never
    // ends a drop. The database is a file that the drop would remove.
    const fake = await docker.containers.create({
      Image: 'alpine:latest',
      Entrypoint: [
        'sh',
        '-c',
        `mkdir -p /databases && touch /databases/${database}
printf '%s\\n' '#!/bin/sh' 'case "$*" in *DROP*) sleep 3600; rm -f /databases/*;; *) ls /databases;; esac' > /usr/local/bin/psql
chmod +x /usr/local/bin/psql
exec sleep 3600`,
      ],
      Cmd: [],
      Labels: { [SERVER_LABEL]: randomUUID(), [KIND_LABEL]: 'postgres' },
    });
    server = fake.id;
    await fake.start();
    child = await holder(run, settings);
    const owned = await object(run);

    await killed(child);

    await gone(
      t,
      async () => assert.deepEqual(await reapers(run), []),
      // Within the grace, one list, one drop that times out, and the expiry pass.
      settings.grace + 4 * settings.requestTimeout + 5_000,
    );
    const { stdout } = await fake.exec({ Cmd: ['ls', '/databases'] });
    assert.equal(stdout.trim(), database);
    assert.equal(await exists(owned), false);
  } finally {
    if (child) await killed(child);
    await removeRun(run, server === undefined ? [] : [server]);
  }
});

test('a reaper that no holder holds removes the run’s objects after its wait for a first holder, and exits', async (t) => {
  const run = randomUUID();
  const ids: string[] = [];
  try {
    ids.push(await object(run));

    await startReaper(docker, run, quick);

    await gone(t, async () => {
      assert.equal(await exists(ids[0]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  } finally {
    await removeRun(run, ids);
  }
});

/** The records directory of a new run, under `directory`. */
async function recordsOf(directory: string): Promise<string> {
  const records = join(directory, 'run');
  await mkdir(records);
  return records;
}

test('a test process whose hold was cut holds the reaper again at once, and the reaper removes what it creates after that, once it exits', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-reaper-',
  );
  const run = randomUUID();
  const launched = launcher(run, await recordsOf(directory.path));
  const ids: string[] = [];
  try {
    await launched.line();
    const [reaper] = await reapers(run);
    assert.ok(reaper);
    const [cat] = await holdersOf(reaper);
    assert.ok(cat);

    // The engine ends the exec of the hold, as at a break of its connection.
    await (await docker.containers.find(reaper))!.exec({ Cmd: ['kill', cat] });
    await gone(t, async () => {
      const [now] = await reapers(run);
      assert.ok(
        now === undefined || (await holdersOf(now)).some((pid) => pid !== cat),
        'held again, or the reaper is gone',
      );
    });
    launched.send('create');
    ids.push(await launched.line());
    await killed(launched.child);

    await gone(
      t,
      async () => {
        assert.equal(await exists(ids[0]!), false);
        assert.deepEqual(await reapers(run), []);
      },
      30_000,
    );
  } finally {
    await killed(launched.child);
    await removeRun(run, ids);
  }
});

test('a test process whose reaper was removed holds a new reaper at once, and that reaper removes what it creates after that, once it exits', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-reaper-',
  );
  const run = randomUUID();
  const launched = launcher(run, await recordsOf(directory.path));
  const ids: string[] = [];
  try {
    await launched.line();
    const [first] = await reapers(run);
    assert.ok(first);

    await (await docker.containers.find(first))?.remove({ force: true });
    await gone(t, async () => {
      const [now] = await reapers(run);
      assert.ok(now !== undefined && now !== first, 'a new reaper');
      assert.equal((await holdersOf(now)).length, 1);
    });
    launched.send('create');
    ids.push(await launched.line());
    await killed(launched.child);

    await gone(
      t,
      async () => {
        assert.equal(await exists(ids[0]!), false);
        assert.deepEqual(await reapers(run), []);
      },
      30_000,
    );
  } finally {
    await killed(launched.child);
    await removeRun(run, ids);
  }
});

test('a hold on a reaper that is closing waits until the engine removed it, and holds the next reaper of the run', async (t) => {
  const run = randomUUID();
  // The re-check passes keep the reaper closing for about 4.5 s.
  const settings = { ...quick, grace: 300, interval: 1_500, passes: 3 };
  const holders: ChildProcess[] = [];
  try {
    holders.push(await holder(run, settings));
    const id = await object(run);
    const [closing] = await reapers(run);
    assert.ok(closing);
    await killed(holders[0]!);
    // The first pass removed the run's container: the reaper is closing.
    await gone(t, async () => assert.equal(await exists(id), false));

    holders.push(await holder(run, settings));

    assert.equal(await exists(closing), false);
    const [next] = await reapers(run);
    assert.ok(next, 'the hold is on a new reaper');
    assert.equal((await holdersOf(next)).length, 1);
  } finally {
    for (const child of holders) await killed(child);
    await removeRun(run);
  }
});

test(
  'a holder that comes while a pass of the reaper runs keeps what it creates while it lives',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    await using stack = new AsyncDisposableStack();
    const ids = [await object(run)];
    let late: Program | undefined;
    try {
      const proxy = stack.use(await EngineProxy.start(engine));
      // The first request of a pass is its list of the run's containers.
      const listing = holdFirst(proxy, 'GET', '/containers/json');
      stack.defer(() => listing.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const reaper = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
      });
      await within(listing.reached, 20_000, 'the list of the pass');

      late = creator(run, quick);
      const created = late.line();
      created.catch(() => {});
      const watch = new AbortController();
      const refused = execEnded(reaper, since, watch.signal);
      refused.catch(() => {});
      await within(
        Promise.race([created, refused]),
        20_000,
        'a hold or its refusal',
      );
      watch.abort();
      listing.release();
      ids.push(await within(created, 60_000, 'the create of the late holder'));
      // The volume list of the pass comes after its removal of the containers.
      await t.waitFor(
        () =>
          assert.ok(
            proxy.requests.some(
              ({ method, path }) => method === 'GET' && path === '/volumes',
            ),
          ),
        { timeout: 20_000, interval: 100 },
      );

      assert.equal(await exists(ids[1]!), true);
      assert.equal(await exists(ids[0]!), false);
    } finally {
      if (late) await killed(late.child);
      await removeRun(run, ids);
    }
  },
);

test(
  'a holder that comes during the last pass of the reaper, after its removal of the containers, and then exits, leaves nothing that it created',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    await using stack = new AsyncDisposableStack();
    const ids = [await object(run)];
    let late: Program | undefined;
    try {
      const proxy = stack.use(await EngineProxy.start(engine));
      // A pass lists the run's volumes after it removed the run's containers.
      const listing = holdFirst(proxy, 'GET', '/volumes');
      stack.defer(() => listing.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const reaper = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
      });
      await within(listing.reached, 20_000, 'the volume list of the pass');

      late = creator(run, quick);
      const created = late.line();
      created.catch(() => {});
      const watch = new AbortController();
      const refused = execEnded(reaper, since, watch.signal);
      refused.catch(() => {});
      await within(
        Promise.race([created, refused]),
        20_000,
        'a hold or its refusal',
      );
      watch.abort();
      listing.release();
      ids.push(await within(created, 60_000, 'the create of the late holder'));
      await killed(late.child);

      await gone(
        t,
        async () => {
          assert.equal(await exists(ids[1]!), false);
          assert.deepEqual(await reapers(run), []);
        },
        30_000,
      );
    } finally {
      if (late) await killed(late.child);
      await removeRun(run, ids);
    }
  },
);

/** A container with the name and the label of the reaper of `run` that exited, and that the engine does not remove, unlike a real one. */
async function staleReaper(run: string): Promise<string> {
  const stale = await docker.containers.create(
    {
      Image: 'alpine:latest',
      Cmd: ['true'],
      Labels: { [REAPER_LABEL]: run },
    },
    { name: reaperName(run) },
  );
  await stale.start();
  await stale.wait({ condition: 'not-running' });
  return stale.id;
}

test('a hold of a run whose reaper ended and was never removed holds a new reaper', async () => {
  const run = randomUUID();
  let child: ChildProcess | undefined;
  try {
    const stale = await staleReaper(run);

    child = await holder(run, quick);

    const [next] = await reapers(run);
    assert.ok(next);
    assert.notEqual(next, stale);
    assert.equal((await holdersOf(next)).length, 1);
  } finally {
    if (child) await killed(child);
    await removeRun(run);
  }
});

test('the start of the reaper of a dead run whose reaper ended and was never removed starts a new reaper, which removes the run’s objects', async (t) => {
  const run = randomUUID();
  const ids: string[] = [];
  try {
    await staleReaper(run);
    ids.push(await object(run));

    await startReaper(docker, run, quick);

    await gone(t, async () => {
      assert.equal(await exists(ids[0]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  } finally {
    await removeRun(run, ids);
  }
});

test('defaults() in a run holds the run’s reaper, records its process, and gives the run’s labels', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-defaults-',
  );
  const run = randomUUID();
  const launched = launcher(run, directory.path);
  try {
    const labels: unknown = JSON.parse(await launched.line());

    assert.deepEqual(labels, { [RUN_LABEL]: run });
    const { pid } = launched.child;
    const [reaper] = await reapers(run);
    assert.ok(reaper, 'defaults() holds a reaper');
    assert.equal((await holdersOf(reaper)).length, 1);
    const files = await readdir(directory.path);
    assert.ok(
      files.some((file) =>
        new RegExp(`^process-${pid}-[0-9a-f-]{36}\\.json$`).test(file),
      ),
    );
  } finally {
    await killed(launched.child);
    await removeRun(run);
    await gone(t, async () => assert.deepEqual(await reapers(run), []));
  }
});
