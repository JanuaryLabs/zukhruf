import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { untilAborted } from '@zukhruf/async';
import { type Container, Docker } from '@zukhruf/docker';
import { TemporaryFiles } from '@zukhruf/fs';

import { timebox } from '../async/timebox.ts';
import { waitFor } from '../async/wait-for.ts';
import { engine, proxyless } from '../testing/current-engine.ts';
import { docker } from '../testing/engine-client.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';
import { DockerTestbed } from './index.ts';
import {
  REAPER_DEFAULTS,
  REAPER_IMAGE,
  REAPER_LABEL,
  ReaperHold,
  type ReaperSettings,
  SERVER_LABEL,
  reaperName,
  reaperRequest,
  startReaper,
} from './reaper.ts';

const RUN_LABEL = 'dev.zukhruf.testing.run';
const KIND_LABEL = 'dev.zukhruf.testing.kind';

/** Pulls `image` when the engine of this process does not have it. */
async function present(image: string): Promise<void> {
  if ((await docker.images.inspect(image)) === undefined)
    await docker.images.pull(image);
}

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
 * A test process of the run `run` whose records are in `records`, with
 * `environment` over this process's: it holds the run's reaper through
 * `DockerTestbed.defaults()` once, prints the labels as JSON, and then, for
 * each line `create`, creates a container with those labels through a client
 * of its own, as a sandbox launcher does, and prints its id.
 */
function launcher(
  run: string,
  records: string,
  environment: NodeJS.ProcessEnv = {},
): Program {
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
      ...environment,
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

const gone = (t: TestContext, check: () => Promise<void>) =>
  waitFor(check, { signal: t.signal, interval: 100 });

/**
 * Gives the id of the exec of the next `event` in the container `id`, from
 * `since` on: of the exec `exec` only, when given.
 */
async function execEvent(
  id: string,
  since: number,
  event: 'exec_start' | 'exec_die',
  signal: AbortSignal,
  exec?: string,
): Promise<string | undefined> {
  for await (const { Actor } of docker.events({
    since,
    filters: { container: [id], event: [event] },
    signal,
  })) {
    const found = Actor?.Attributes?.execID;
    if (exec === undefined || found === exec) return found;
  }
  return undefined;
}

/**
 * Starts the reaper of `run` with `settings`, and with no wait for a first
 * holder, with each of its engine requests through `proxy`, as moby-ryuk's
 * tests give its reaper a client that fails chosen calls. Its `docker` CLI
 * reads `DOCKER_HOST`, so the test points it at a TCP port of this process
 * that forwards to the proxy (as in docker-global-setup.integration.test.ts).
 * Gives its id, and its exit code once the engine removed it.
 */
async function proxiedReaper(
  stack: AsyncDisposableStack,
  proxy: EngineProxy,
  run: string,
  settings: ReaperSettings,
): Promise<{ id: string; exited: Promise<number> }> {
  await present('alpine:latest');
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
  await present(REAPER_IMAGE);
  const body = reaperRequest(
    run,
    { ...settings, firstHolder: 0 },
    '/var/run/docker.sock',
  );
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
  const exited = reaper
    .wait({ condition: 'removed' })
    .then(({ StatusCode }) => StatusCode);
  exited.catch(() => {});
  await reaper.start();
  return { id: reaper.id, exited };
}

/** Holds the `nth` request of the proxy to `method` `path`, counted from 1, until release(). */
function holdNth(
  proxy: EngineProxy,
  method: string,
  path: string | RegExp,
  nth: number,
) {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let seen = 0;
  proxy.intercept(method, path, async () => {
    seen += 1;
    if (seen !== nth) return;
    reached.resolve();
    await release.promise;
  });
  return { reached: reached.promise, release: () => release.resolve() };
}

/** `promise`, or, when `signal` aborts first, a rejection that names `what`. */
async function within<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  what: string,
): Promise<T> {
  try {
    return await untilAborted(promise, signal);
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      throw new Error(`${what} did not happen`, { cause: error });
    }
    throw error;
  }
}

test('one reaper of a run keeps the run’s objects while one of its holders lives, and removes them, with their anonymous volumes, after the last one ended', async (t) => {
  const run = randomUUID();
  await present('alpine:latest');
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
    // A fixed window, longer than the grace and each pass of the reaper: the
    // test proves that the reaper removed nothing while one holder lives.
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
  await present('alpine:latest');
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
  await present('alpine:latest');
  // Much longer than the start of a holder, so the second holder comes within it.
  const settings = { ...quick, grace: 15_000 };
  const holders: ChildProcess[] = [];
  try {
    holders.push(await holder(run, settings));
    const id = await object(run);
    const [reaper] = await reapers(run);
    assert.ok(reaper);

    await killed(holders[0]!);
    holders.push(await holder(run, settings));
    const heldAgain = {
      reapers: await reapers(run),
      holders: (await holdersOf(reaper)).length,
      kept: await exists(id),
    };
    await killed(holders[1]!);

    assert.deepEqual(heldAgain, { reapers: [reaper], holders: 1, kept: true });
    await gone(t, async () => assert.equal(await exists(id), false));
  } finally {
    for (const child of holders) await killed(child);
    await removeRun(run);
  }
});

test('a container that the engine creates after the first pass of the reaper is removed by a re-check pass', async (t) => {
  const run = randomUUID();
  await present('alpine:latest');
  // The re-check passes span 6 s after the first pass.
  const settings = { ...quick, grace: 300, interval: 3_000, passes: 2 };
  let child: ChildProcess | undefined;
  const ids: string[] = [];
  const watch = new AbortController();
  try {
    child = await holder(run, settings);
    ids.push(await object(run));
    const since = Math.floor(Date.now() / 1000) - 1;
    const destroyed = (async () => {
      for await (const _ of docker.events({
        since,
        filters: { container: [ids[0]!], event: ['destroy'] },
        signal: watch.signal,
      }))
        return;
    })();
    destroyed.catch(() => {});
    await killed(child);
    // The first pass removes the first container, after its list.
    await within(destroyed, t.signal, 'the removal by the first pass');

    // No anonymous volume: one would hold up the volume removal of the first pass.
    const late = await docker.containers.create({
      Image: 'alpine:latest',
      Cmd: ['sleep', '3600'],
      Labels: { [RUN_LABEL]: run },
    });
    ids.push(late.id);
    await late.start();

    await gone(t, async () => {
      assert.equal(await exists(ids[1]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  } finally {
    watch.abort();
    if (child) await killed(child);
    await removeRun(run, ids);
  }
});

test(
  'a reaper whose removal fails tries it again one interval later, and removes the volume once the engine allows it',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    await using stack = new AsyncDisposableStack();
    let user: string | undefined;
    try {
      const { name: volume } = await docker.volumes.create({
        Labels: { [RUN_LABEL]: run },
      });
      // Not of the run: the engine refuses the removal of the volume while it runs.
      const using = await docker.containers.create({
        Image: 'alpine:latest',
        Cmd: ['sleep', '3600'],
        HostConfig: { Binds: [`${volume}:/data`] },
      });
      user = using.id;
      await using.start();
      const proxy = stack.use(await EngineProxy.start(engine));
      const removal = `/volumes/${volume}`;
      // The reaper tries a removal again only after the engine refused it, so a
      // second try means the first was refused. The volume is freed before the
      // engine gets that second try.
      let tries = 0;
      proxy.intercept('DELETE', removal, async () => {
        tries += 1;
        if (tries === 2) await using.remove({ force: true });
      });

      await proxiedReaper(stack, proxy, run, {
        ...quick,
        interval: 500,
        passes: 0,
        retries: 8,
      });

      await gone(t, async () => {
        assert.equal(await volumeExists(volume), false);
        assert.deepEqual(await reapers(run), []);
      });
      const deletes = proxy.requests.filter(
        ({ method, path }) => method === 'DELETE' && path === removal,
      );
      assert.ok(
        deletes.length >= 2,
        `${deletes.length} removals of the volume`,
      );
    } finally {
      await removeRun(run, user === undefined ? [] : [user]);
    }
  },
);

test('a reaper whose drop of a database never gets an answer ends within its request time limit, keeps that database, and removes the run’s containers', async (t) => {
  const run = randomUUID();
  await present('alpine:latest');
  const database = `test_${run.replaceAll('-', '')}_0123456789abcdef`;
  const settings = { ...quick, grace: 100, passes: 0, requestTimeout: 1_000 };
  let child: ChildProcess | undefined;
  let server: string | undefined;
  try {
    // A shared Postgres server whose psql lists the run's database and never
    // ends a drop. The database is a file that the drop would remove. A drop
    // writes its command to /dropped first.
    const fake = await docker.containers.create({
      Image: 'alpine:latest',
      Entrypoint: [
        'sh',
        '-c',
        `mkdir -p /databases && touch /databases/${database}
printf '%s\\n' '#!/bin/sh' 'case "$*" in *DROP*) echo "$*" > /dropped; sleep 3600; rm -f /databases/*;; *) ls /databases;; esac' > /usr/local/bin/psql
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

    // Within the grace, one list, one drop that times out, and the expiry pass.
    await gone(t, async () => assert.deepEqual(await reapers(run), []));
    const dropped = await fake.exec({ Cmd: ['cat', '/dropped'] });
    assert.match(dropped.stdout, new RegExp(`DROP DATABASE.*${database}`));
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
  await present('alpine:latest');
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
  await present('alpine:latest');
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

    await gone(t, async () => {
      assert.equal(await exists(ids[0]!), false);
      assert.deepEqual(await reapers(run), []);
    });
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
  await present('alpine:latest');
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

    await gone(t, async () => {
      assert.equal(await exists(ids[0]!), false);
      assert.deepEqual(await reapers(run), []);
    });
  } finally {
    await killed(launched.child);
    await removeRun(run, ids);
  }
});

test('a hold on a reaper that is closing waits until the engine removed it, and holds the next reaper of the run', async (t) => {
  const run = randomUUID();
  await present('alpine:latest');
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

test('a hold on a reaper that stays closing past the readiness bound of the hold rejects with the hold’s named error', async (t) => {
  const run = randomUUID();
  await present('alpine:latest');
  // After its first pass, the reaper keeps its door closed for 10 minutes.
  const closing = { ...quick, grace: 0, passes: 1, interval: 600_000 };
  const readiness = 3_000;
  try {
    const id = await object(run);
    await startReaper(docker, run, closing);
    // The first pass removed the run's container: the reaper is closing.
    await gone(t, async () => assert.equal(await exists(id), false));

    await assert.rejects(
      ReaperHold.take(docker, run, { ...quick, readiness }, globalThis),
      {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      },
    );
  } finally {
    await removeRun(run);
  }
});

test(
  'a held() that joins the hold a cut hold takes again rejects with the hold’s named error when the bound of that hold ends, before its own bound',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    const readiness = 2_000;
    const clock = createClock();
    await using stack = new AsyncDisposableStack();
    try {
      const proxy = stack.use(await EngineProxy.start(engine));
      const client = stack.use(
        await Docker.connect({
          clock: globalThis,
          environment: { DOCKER_HOST: proxy.host },
        }),
      );
      // The first exec create is the hold that take() takes. The second is
      // the hold that is taken again after the cut: held here, so that hold
      // is in flight when held() joins it.
      const again = holdNth(proxy, 'POST', /^\/containers\/[^/]+\/exec$/, 2);
      stack.defer(() => again.release());
      const hold = await ReaperHold.take(
        client,
        run,
        { ...quick, readiness },
        clock,
      );
      const [reaper] = await reapers(run);
      assert.ok(reaper);
      const [cat] = await holdersOf(reaper);
      assert.ok(cat);

      // The engine ends the exec of the hold, as at a break of its connection.
      await (await docker.containers.find(reaper))!.exec({
        Cmd: ['kill', cat],
      });
      // The bound of the hold taken again starts before its exec create.
      await within(again.reached, t.signal, 'the hold taken again');
      clock.tick(readiness / 2);
      const joined = hold.held();
      // The bound of the hold taken again ends here. The bound of held()
      // started half a bound later, so it does not end.
      clock.tick(readiness / 2);

      await assert.rejects(within(joined, t.signal, 'the end of held()'), {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      });
    } finally {
      await removeRun(run);
    }
  },
);

test(
  'a hold on a reaper that stays closing ends its wait for the removal of that reaper at the readiness bound: its client leaves the request in flight',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    // After its first pass, the reaper keeps its door closed for 10 minutes.
    const closing = { ...quick, grace: 0, passes: 1, interval: 600_000 };
    const readiness = 3_000;
    const clock = createClock();
    try {
      const id = await object(run);
      await startReaper(docker, run, closing);
      // The first pass removed the run's container: the reaper is closing.
      await gone(t, async () => assert.equal(await exists(id), false));
      await using stack = new AsyncDisposableStack();
      const proxy = stack.use(await EngineProxy.start(engine));
      const client = stack.use(
        await Docker.connect({
          clock: globalThis,
          environment: { DOCKER_HOST: proxy.host },
        }),
      );
      // The reaper answers `closing` to the exec of the hold. The first
      // inspect after that exec starts is the hold's wait for the removal of
      // the reaper: held here until its client leaves.
      const reached = Promise.withResolvers<void>();
      const left = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      stack.defer(() => release.resolve());
      let holding = false;
      proxy.intercept(
        'GET',
        /^\/containers\/[^/]+\/json$/,
        async (_, signal) => {
          if (
            holding ||
            !proxy.requests.some(({ path }) =>
              /^\/exec\/[^/]+\/start$/.test(path),
            )
          )
            return;
          holding = true;
          reached.resolve();
          const leaving = signal.aborted
            ? Promise.resolve()
            : once(signal, 'abort');
          void leaving.then(() => left.resolve());
          await Promise.race([leaving, release.promise]);
        },
      );
      const taking = ReaperHold.take(
        client,
        run,
        { ...quick, readiness },
        clock,
      );
      taking.catch(() => {});
      await within(
        reached.promise,
        t.signal,
        'the wait for the removal of the closing reaper',
      );

      clock.tick(readiness);

      await within(left.promise, t.signal, 'the client leaving that wait');
      await assert.rejects(taking, {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      });
    } finally {
      await removeRun(run);
    }
  },
);

test(
  'a hold whose create of the reaper gets no answer ends that create at the readiness bound: its client leaves the request in flight',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    const readiness = 3_000;
    const clock = createClock();
    try {
      // The proxy forwards the create once its client left, and its disposal
      // waits for the engine's answer, so the cleanup sees that reaper.
      await using stack = new AsyncDisposableStack();
      const proxy = stack.use(await EngineProxy.start(engine));
      const client = stack.use(
        await Docker.connect({
          clock: globalThis,
          environment: { DOCKER_HOST: proxy.host },
        }),
      );
      const reached = Promise.withResolvers<void>();
      const left = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      stack.defer(() => release.resolve());
      let holding = false;
      proxy.intercept('POST', '/containers/create', async (_, signal) => {
        if (holding) return;
        holding = true;
        reached.resolve();
        const leaving = signal.aborted
          ? Promise.resolve()
          : once(signal, 'abort');
        void leaving.then(() => left.resolve());
        await Promise.race([leaving, release.promise]);
      });
      const taking = ReaperHold.take(
        client,
        run,
        { ...quick, readiness },
        clock,
      );
      taking.catch(() => {});
      await within(reached.promise, t.signal, 'the create of the reaper');

      clock.tick(readiness);

      await within(left.promise, t.signal, 'the client leaving the create');
      await assert.rejects(taking, {
        message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of ${readiness} ms`,
      });
    } finally {
      await removeRun(run);
    }
  },
);

test(
  'the start of the reaper of a dead run rejects with the hold’s named error when its readiness bound ends first',
  { skip: proxyless },
  async () => {
    const run = randomUUID();
    try {
      // The bound can end after the engine got the create of the reaper, which
      // then lands after the rejection. Each request goes through the proxy,
      // whose disposal waits until the engine answered each create it
      // forwarded and closes the rest, so the cleanup sees that reaper.
      await using proxy = await EngineProxy.start(engine);
      proxy.intercept('POST', '/containers/create', () => {});
      await using client = await Docker.connect({
        clock: globalThis,
        environment: { DOCKER_HOST: proxy.host },
      });
      await assert.rejects(
        startReaper(client, run, { ...quick, readiness: 1 }),
        {
          message: `The hold of the reaper ${reaperName(run)} was not ready within its readiness bound of 1 ms`,
        },
      );
    } finally {
      await removeRun(run);
    }
  },
);

test(
  'a holder that comes while a pass of the reaper runs keeps what it creates while it lives',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    await present('alpine:latest');
    await using stack = new AsyncDisposableStack();
    const ids = [await object(run)];
    let late: Program | undefined;
    try {
      const proxy = stack.use(await EngineProxy.start(engine));
      // The first list of containers is the reaper's check of its socket
      // (ADR 0020, item 14). The second is the first request of the pass: its
      // list of the run's containers.
      const listing = holdNth(proxy, 'GET', '/containers/json', 2);
      stack.defer(() => listing.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const { id: reaper } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
      });
      await within(listing.reached, t.signal, 'the list of the pass');

      late = creator(run, quick);
      const created = late.line();
      created.catch(() => {});
      const watch = new AbortController();
      const refused = execEvent(reaper, since, 'exec_die', watch.signal);
      refused.catch(() => {});
      await within(
        Promise.race([created, refused]),
        t.signal,
        'a hold or its refusal',
      );
      watch.abort();
      listing.release();
      ids.push(
        await within(created, t.signal, 'the create of the late holder'),
      );
      // The volume list of the pass comes after its removal of the containers.
      await waitFor(
        () =>
          assert.ok(
            proxy.requests.some(
              ({ method, path }) => method === 'GET' && path === '/volumes',
            ),
          ),
        { signal: t.signal, interval: 100 },
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
    await present('alpine:latest');
    await using stack = new AsyncDisposableStack();
    const ids = [await object(run)];
    let late: Program | undefined;
    try {
      const proxy = stack.use(await EngineProxy.start(engine));
      // A pass lists the run's volumes after it removed the run's containers.
      const listing = holdNth(proxy, 'GET', '/volumes', 1);
      stack.defer(() => listing.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const { id: reaper } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
      });
      await within(listing.reached, t.signal, 'the volume list of the pass');

      late = creator(run, quick);
      const created = late.line();
      created.catch(() => {});
      const watch = new AbortController();
      const refused = execEvent(reaper, since, 'exec_die', watch.signal);
      refused.catch(() => {});
      await within(
        Promise.race([created, refused]),
        t.signal,
        'a hold or its refusal',
      );
      watch.abort();
      listing.release();
      ids.push(
        await within(created, t.signal, 'the create of the late holder'),
      );
      await killed(late.child);

      await gone(t, async () => {
        assert.equal(await exists(ids[1]!), false);
        assert.deepEqual(await reapers(run), []);
      });
    } finally {
      if (late) await killed(late.child);
      await removeRun(run, ids);
    }
  },
);

/** The name of the sweep lease of `fingerprint`: the name each reaper and each test process of that server agree on (ADR 0014). */
const sweepLease = (fingerprint: string): string =>
  `zukhruf-testing-sweep-${fingerprint}`;

test(
  'a reaper that finds the sweep lease of an expired shared server taken on each of its sweepTries keeps that server and exits 0',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    const fingerprint = randomUUID();
    const lease = sweepLease(fingerprint);
    const sweepTries = 3;
    await using stack = new AsyncDisposableStack();
    let server: string | undefined;
    try {
      await present('alpine:latest');
      await present('busybox:1.37.0');
      const shared = await docker.containers.create({
        Image: 'alpine:latest',
        Cmd: ['sleep', '3600'],
        Labels: { [SERVER_LABEL]: fingerprint },
      });
      server = shared.id;
      await shared.start();
      // The reaper reads the age of a server in whole seconds of the engine's
      // clock: a server is older than a TTL of 1 ms from the next second on.
      const born = Math.floor(
        Date.parse((await shared.inspect()).Created ?? '') / 1000,
      );
      await waitFor(
        async () => {
          const { stdout } = await shared.exec({ Cmd: ['date', '-u', '+%s'] });
          assert.ok(Number(stdout.trim()) > born, 'the server is 1 s old');
        },
        { signal: t.signal, interval: 200 },
      );
      const proxy = stack.use(await EngineProxy.start(engine));
      // Another holder of the sweep lease, such as a reaper of another run,
      // takes it again before each create of the reaper under test, and lets
      // it go when that reaper looks for its end. The sweep lease of each
      // other shared server is refused, so the test keeps them all.
      const events: ('try' | 'gone')[] = [];
      proxy.intercept('POST', '/containers/create', async ({ body }) => {
        const { Labels: labels = {} }: { Labels?: Record<string, string> } =
          JSON.parse(body);
        if (labels['dev.zukhruf.testing.lease'] !== 'sweep') return;
        if (labels['dev.zukhruf.testing.lease.server'] !== fingerprint)
          throw new Error('The test keeps each other shared server.');
        events.push('try');
        if ((await docker.containers.find(lease)) !== undefined) return;
        const taken = await docker.containers.create(
          {
            Image: 'busybox:1.37.0',
            Entrypoint: ['cat'],
            Cmd: [],
            OpenStdin: true,
          },
          { name: lease },
        );
        await taken.start();
      });
      proxy.intercept('GET', `/containers/${lease}/json`, async () => {
        const taken = await docker.containers.find(lease);
        if (taken === undefined) return;
        await taken.remove({ force: true });
        events.push('gone');
      });

      const { exited } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        grace: 0,
        passes: 0,
        serverTtl: 1,
        sweepTries,
      });

      assert.equal(await within(exited, t.signal, 'the end of the reaper'), 0);
      assert.deepEqual(
        events,
        Array.from({ length: sweepTries }, () => ['try', 'gone']).flat(),
      );
      assert.equal(await exists(server), true);
    } finally {
      await removeRun(run, server === undefined ? [lease] : [server, lease]);
    }
  },
);

test('a reaper whose shared server is removed while it drops the run’s database in it removes the run’s containers and exits 0', async (t) => {
  const run = randomUUID();
  const database = `test_${run.replaceAll('-', '')}_0123456789abcdef`;
  // No request time limit ends the drop: only the removal of its server does.
  const settings = { ...quick, grace: 100, passes: 0, requestTimeout: 600_000 };
  let child: ChildProcess | undefined;
  let server: string | undefined;
  try {
    await present('alpine:latest');
    // A shared Postgres server whose psql lists the run's database, and
    // writes the command of a drop to /dropped and never ends it.
    const fake = await docker.containers.create({
      Image: 'alpine:latest',
      Entrypoint: [
        'sh',
        '-c',
        `mkdir -p /databases && touch /databases/${database}
printf '%s\\n' '#!/bin/sh' 'case "$*" in *DROP*) echo "$*" > /dropped; exec sleep 3600;; *) ls /databases;; esac' > /usr/local/bin/psql
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
    const reaper = await docker.containers.find(reaperName(run));
    assert.ok(reaper);
    const exited = reaper
      .wait({ condition: 'removed' })
      .then(({ StatusCode }) => StatusCode);
    exited.catch(() => {});
    await killed(child);
    await waitFor(
      async () => {
        const dropped = await fake.exec({ Cmd: ['cat', '/dropped'] });
        assert.match(dropped.stdout, new RegExp(`DROP DATABASE.*${database}`));
      },
      { signal: t.signal, interval: 100 },
    );

    await fake.remove({ force: true, v: true });

    assert.equal(await within(exited, t.signal, 'the end of the reaper'), 0);
    assert.equal(await exists(owned), false);
  } finally {
    if (child) await killed(child);
    await removeRun(run, server === undefined ? [] : [server]);
  }
});

test(
  'a holder whose test process is killed before the reaper checked its socket ends its exec, and leaves no cat in the reaper',
  { skip: proxyless },
  async (t) => {
    const run = randomUUID();
    await using stack = new AsyncDisposableStack();
    let owner: Program | undefined;
    try {
      const proxy = stack.use(await EngineProxy.start(engine));
      // The first list of containers is the reaper's check of its socket
      // (ADR 0020, item 14): held here, so a holder waits for its result. No
      // request time limit ends that check.
      const check = holdNth(proxy, 'GET', '/containers/json', 1);
      stack.defer(() => check.release());
      const since = Math.floor(Date.now() / 1000) - 1;
      const { id: reaper } = await proxiedReaper(stack, proxy, run, {
        ...quick,
        requestTimeout: 600_000,
      });
      await within(check.reached, t.signal, 'the check of the socket');
      const watch = new AbortController();
      stack.defer(() => watch.abort());
      const started = execEvent(reaper, since, 'exec_start', watch.signal);
      started.catch(() => {});
      owner = program(`
        const docker = await Docker.connect({ clock: globalThis, environment: process.env });
        await ReaperHold.take(docker, ${JSON.stringify(run)}, ${JSON.stringify(quick)}, globalThis);
      `);
      const hold = await within(started, t.signal, 'the exec of the hold');
      assert.ok(hold !== undefined, 'the exec of the hold has an id');

      await killed(owner.child);

      await within(
        execEvent(reaper, since, 'exec_die', t.signal, hold),
        t.signal,
        'the end of the exec of the hold',
      );
      assert.deepEqual(await holdersOf(reaper), []);
    } finally {
      if (owner) await killed(owner.child);
      await removeRun(run);
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
  await present('alpine:latest');
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
  await present('alpine:latest');
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

/** Marks a reaper with the source of its socket on the engine's host (ADR 0020, item 14). */
const SOCKET_LABEL = 'dev.zukhruf.testing.reaper.socket';

/** A second engine of this run, and a client of it through a unix socket of this machine. */
interface SecondEngine extends AsyncDisposable {
  /** The container of the second engine, on the engine of this process. */
  container: Container;
  client: Docker;
  /** The `unix://` host of the relay. */
  host: string;
}

/** A path of a unix socket that fits the 104 bytes of macOS. */
const shortSocket = () => `/tmp/zt-${randomUUID().slice(0, 8)}.sock`;

/**
 * A docker-in-docker engine, created by this run's testbed, whose dockerd
 * listens on each path of `sockets`, with `binds`, and a unix socket at
 * `relay` on this machine that relays to its TCP port. The testbed publishes
 * that port on 127.0.0.1 of the engine's host only: it gives root there.
 */
async function secondEngine({
  sockets,
  binds = [],
  relay,
}: {
  sockets: string[];
  binds?: string[];
  relay: string;
}): Promise<SecondEngine> {
  await using stack = new AsyncDisposableStack();
  const service = stack.use(
    await new DockerTestbed({ environment: process.env }).serve(
      {
        Image: 'docker:28.5.2-dind',
        Cmd: [
          'dockerd',
          ...sockets.map((socket) => `--host=unix://${socket}`),
          '--host=tcp://0.0.0.0:2375',
          '--tls=false',
        ],
        Env: ['DOCKER_TLS_CERTDIR='],
        HostConfig: { Privileged: true, Binds: binds },
      },
      {
        internalPort: 2375,
        healthy: ({ port }) =>
          timebox(
            async () => {
              const ping = await fetch(`http://127.0.0.1:${port}/_ping`);
              if (!ping.ok) throw new Error(`The ping answered ${ping.status}`);
            },
            { maxRetryTime: 60_000 },
          ),
      },
    ),
  );
  const connections = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(service.port, service.host);
    for (const socket of [client, upstream]) {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    }
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  server.listen(relay);
  await once(server, 'listening');
  stack.defer(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of connections) socket.destroy();
      }),
  );
  await chmod(relay, 0o600);
  const host = `unix://${relay}`;
  const client = stack.use(
    await Docker.connect({
      clock: globalThis,
      environment: { DOCKER_HOST: host },
    }),
  );
  // Platform setup that no product operation exposes: the second engine starts
  // with no image, and a pull from Docker Hub inside it in each test is slow
  // and meets the rate limit of Docker Hub. The engine of this process has
  // each image that the tests and the reaper use there, or pulls it once, and
  // loads it into the second engine.
  const images = [REAPER_IMAGE, 'alpine:latest'];
  for (const image of images) await present(image);
  await client.images.load(await docker.images.save(images));
  const owned = stack.move();
  return {
    container: service.container,
    client,
    host,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** The source of the socket of each reaper of `run` on the engine of `client`. */
const reaperSockets = async (client: Docker, run: string) =>
  (
    await client.containers.list({
      all: true,
      filters: { label: [`${REAPER_LABEL}=${run}`] },
    })
  )
    // The socket label is the contract of ADR 0020, item 14, and the only view of which socket a reaper used.
    .map(({ Labels }) => Labels?.[SOCKET_LABEL]);

/**
 * The source of the socket of each reaper of `run` that the second engine
 * removes from now on, in order. The stream starts at the second engine's own
 * clock, so an event before the stream attaches is still in it.
 */
async function removedReapers(second: SecondEngine, run: string) {
  const { stdout } = await second.container.exec({ Cmd: ['date', '+%s'] });
  const since = Number(stdout.trim());
  const watch = new AbortController();
  const sockets: (string | undefined)[] = [];
  const watching = (async () => {
    for await (const { Actor } of second.client.events({
      since,
      filters: { label: [`${REAPER_LABEL}=${run}`], event: ['destroy'] },
      signal: watch.signal,
    }))
      // The socket label is the contract of ADR 0020, item 14, and the only view of which socket a reaper used.
      sockets.push(Actor?.Attributes?.[SOCKET_LABEL]);
  })();
  watching.catch(() => {});
  return { sockets, [Symbol.dispose]: () => watch.abort() };
}

test('a hold whose /var/run/docker.sock reaches another engine removes that reaper, holds one on the socket of its client, and that reaper removes the run’s objects on its engine once the holder is killed', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-reaper-',
  );
  const relay = shortSocket();
  // Its /var/run/docker.sock is the socket of the engine of this process.
  await using second = await secondEngine({
    sockets: [relay],
    binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    relay,
  });
  const run = randomUUID();
  using removed = await removedReapers(second, run);
  const launched = launcher(run, await recordsOf(directory.path), {
    DOCKER_HOST: second.host,
  });
  try {
    await launched.line();
    const held = await reaperSockets(second.client, run);
    launched.send('create');
    const id = await launched.line();

    await killed(launched.child);

    assert.deepEqual(held, [relay]);
    await gone(t, async () => {
      assert.deepEqual(removed.sockets, ['/var/run/docker.sock', relay]);
      assert.equal(await second.client.containers.find(id), undefined);
      assert.deepEqual(await reaperSockets(second.client, run), []);
    });
  } finally {
    await killed(launched.child);
  }
});

test('defaults() rejects with each socket that it tried and why, when no socket reaches the engine, and leaves no reaper and no directory at the missing path', async () => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-reaper-',
  );
  const relay = shortSocket();
  // It has no file at the path of the relay, and its /var/run/docker.sock is
  // the socket of the engine of this process.
  await using second = await secondEngine({
    sockets: [shortSocket()],
    binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    relay,
  });
  const run = randomUUID();
  const testbed = new DockerTestbed({
    environment: {
      DOCKER_HOST: second.host,
      ZUKHRUF_TESTING_RUN_ID: run,
      ZUKHRUF_TESTING_RUN_DIR: await recordsOf(directory.path),
    },
  });
  try {
    await assert.rejects(testbed.defaults(), {
      message: `The reaper ${reaperName(run)} found no socket of the engine ${second.host} that reaches that engine: /var/run/docker.sock: the socket reaches an engine that does not run this reaper; ${relay}: the engine’s host has no file at this path`,
    });

    assert.deepEqual(await reaperSockets(second.client, run), []);
    const { exitCode } = await second.container.exec({
      Cmd: ['test', '-e', relay],
    });
    assert.equal(exitCode, 1);
  } finally {
    await (await testbed.client())[Symbol.asyncDispose]();
  }
});

test('a hold whose /var/run/docker.sock and client socket both reach the engine keeps /var/run/docker.sock', async () => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-reaper-',
  );
  const relay = shortSocket();
  await using second = await secondEngine({
    sockets: ['/var/run/docker.sock', relay],
    relay,
  });
  const run = randomUUID();
  const launched = launcher(run, await recordsOf(directory.path), {
    DOCKER_HOST: second.host,
  });
  try {
    await launched.line();

    assert.deepEqual(await reaperSockets(second.client, run), [
      '/var/run/docker.sock',
    ]);
  } finally {
    await killed(launched.child);
  }
});

test('the start of the reaper of a dead run on an engine whose /var/run/docker.sock reaches another engine starts a reaper on the socket of its client, which removes the run’s objects on its engine', async (t) => {
  const relay = shortSocket();
  // Its /var/run/docker.sock is the socket of the engine of this process.
  await using second = await secondEngine({
    sockets: [relay],
    binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    relay,
  });
  const run = randomUUID();
  using removed = await removedReapers(second, run);
  const owned = await second.client.containers.create({
    Image: 'alpine:latest',
    Cmd: ['sleep', '3600'],
    Labels: { [RUN_LABEL]: run },
  });
  await owned.start();

  await startReaper(second.client, run, quick);

  await gone(t, async () => {
    assert.deepEqual(removed.sockets, ['/var/run/docker.sock', relay]);
    assert.equal(await second.client.containers.find(owned.id), undefined);
    assert.deepEqual(await reaperSockets(second.client, run), []);
  });
});

test('defaults() names /var/run/docker.sock as a socket that does not answer, when the engine’s host has a file there that no engine listens on', async () => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-reaper-',
  );
  const relay = shortSocket();
  // It has no file at the path of the relay, and its dockerd listens on
  // another path only.
  await using second = await secondEngine({ sockets: [shortSocket()], relay });
  // Platform setup that no operation of the testbed exposes: a regular file at
  // /var/run/docker.sock of the engine's host.
  const made = await second.container.exec({
    Cmd: ['sh', '-c', ': > /var/run/docker.sock'],
  });
  assert.equal(made.exitCode, 0);
  const run = randomUUID();
  const testbed = new DockerTestbed({
    environment: {
      DOCKER_HOST: second.host,
      ZUKHRUF_TESTING_RUN_ID: run,
      ZUKHRUF_TESTING_RUN_DIR: await recordsOf(directory.path),
    },
  });
  try {
    await assert.rejects(testbed.defaults(), {
      message: `The reaper ${reaperName(run)} found no socket of the engine ${second.host} that reaches that engine: /var/run/docker.sock: the socket does not answer: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?; ${relay}: the engine’s host has no file at this path`,
    });

    assert.deepEqual(await reaperSockets(second.client, run), []);
  } finally {
    await (await testbed.client())[Symbol.asyncDispose]();
  }
});

test('a test process whose reaper on the socket of its client was removed holds a new reaper on that socket first, before /var/run/docker.sock, which reaches another engine', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-reaper-',
  );
  const relay = shortSocket();
  // Its /var/run/docker.sock is the socket of the engine of this process.
  await using second = await secondEngine({
    sockets: [relay],
    binds: ['/var/run/docker.sock:/var/run/docker.sock'],
    relay,
  });
  const run = randomUUID();
  using removed = await removedReapers(second, run);
  const launched = launcher(run, await recordsOf(directory.path), {
    DOCKER_HOST: second.host,
  });
  try {
    await launched.line();
    const [first] = await second.client.containers.list({
      filters: { label: [`${REAPER_LABEL}=${run}`] },
    });
    assert.ok(first);

    // The engine ends the hold, as at a removal of the reaper by another tool.
    await (
      await second.client.containers.find(first.Id)
    )?.remove({
      force: true,
    });
    await gone(t, async () => {
      const [next] = await second.client.containers.list({
        filters: { label: [`${REAPER_LABEL}=${run}`] },
      });
      assert.ok(next !== undefined && next.Id !== first.Id, 'a new reaper');
      assert.deepEqual(await reaperSockets(second.client, run), [relay]);
    });
    await killed(launched.child);

    // A kill before the new hold attached leaves the reaper waiting for a
    // first holder: 60 s by default.
    await gone(t, async () => {
      assert.deepEqual(removed.sockets, ['/var/run/docker.sock', relay, relay]);
      assert.deepEqual(await reaperSockets(second.client, run), []);
    });
  } finally {
    await killed(launched.child);
  }
});
