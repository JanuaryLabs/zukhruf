import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { describe, test } from 'node:test';

import { writeContextStore } from './testing/context-store-files.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { ENTRY, lastJson, runScenario } from './testing/scenario.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';
import {
  NOT_RESPONDING,
  PERMISSION_DENIED,
  isAlive,
  localEngineSocket,
  sshStandIn,
} from './testing/ssh-stand-in.ts';

const posixOnly =
  process.platform === 'win32'
    ? 'the ssh stand-in is a POSIX executable with a shebang'
    : false;

const engineSocket = posixOnly ? undefined : await localEngineSocket();
const needsLocalEngine =
  posixOnly ||
  (engineSocket === undefined
    ? 'the current context of config.json is not a local unix:// engine'
    : false);

const HOST = 'ssh://tester@machine:2222';

/** The environment of a scenario: the stand-in is the `ssh` of its PATH. */
function scenarioEnvironment(standIn: string, home: string) {
  return { PATH: `${standIn}${delimiter}${process.env.PATH}`, HOME: home };
}

/** A scenario that connects to HOST, runs `body` with `docker`, and prints the JSON of its result. */
const withClient = (body: string) => `
import { Docker } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect({ clock: globalThis, host: ${JSON.stringify(HOST)}, signal: AbortSignal.timeout(20_000) });
${body}
`;

describe('the connection helper of an ssh:// host', () => {
  test(
    'ssh that exits with 255 before the answer is a ConnectionFailedError with the exit code and the stderr of ssh',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using standIn = await sshStandIn({ kind: 'permission-denied' });
      const scenario = `
import { ConnectionFailedError, Docker } from ${JSON.stringify(ENTRY)};
try {
  await Docker.connect({ clock: globalThis, host: ${JSON.stringify(HOST)}, signal: AbortSignal.timeout(20_000) });
  console.log(JSON.stringify({ connected: true }));
} catch (error) {
  console.log(JSON.stringify({
    failed: error instanceof ConnectionFailedError,
    host: error.host,
    exitCode: error.cause?.exitCode,
    stderr: error.cause?.stderr,
  }));
}
`;

      // Act
      const result = await runScenario(
        scenario,
        scenarioEnvironment(standIn.path, home.path),
      );

      // Assert
      assert.deepEqual(lastJson(result), {
        failed: true,
        host: HOST,
        exitCode: 255,
        stderr: `${PERMISSION_DENIED}\r\n`,
      });
    },
  );

  test(
    'a call that waits for its answer when ssh exits with 255, as its keepalive does when the machine stops answering, rejects with a ConnectionFailedError with the exit code and the stderr of ssh',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using engine = await fakeEngine({
        directory: home.path,
        apiVersion: '1.51',
        // The machine is silent: /info never gets an answer.
        answer: () => undefined,
      });
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: engine.socketPath,
        notRespondingAfter: '/info',
      });
      const scenario = withClient(`
import { ConnectionFailedError } from ${JSON.stringify(ENTRY)};
try {
  await docker.info();
  console.log(JSON.stringify({ answered: true }));
} catch (error) {
  console.log(JSON.stringify({
    failed: error instanceof ConnectionFailedError,
    host: error.host,
    cause: error.cause?.name,
    exitCode: error.cause?.exitCode,
    stderr: error.cause?.stderr,
  }));
}
await docker[Symbol.asyncDispose]();
`);

      try {
        // Act
        const result = await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );

        // Assert
        assert.deepEqual(
          lastJson(result),
          {
            failed: true,
            host: HOST,
            cause: 'SshExitError',
            exitCode: 255,
            stderr: `${NOT_RESPONDING}\r\n`,
          },
          result.stderr,
        );
        assert.deepEqual(engine.paths, ['/_ping', '/v1.51/info']);
      } finally {
        for (const { pid } of await standIn.runs()) {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    },
  );

  test(
    'an open stream of events, when ssh exits with 255 as its keepalive does when the machine stops answering, gives the events that came and then rejects with an error whose cause has the exit code and the stderr of ssh',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using engine = await fakeEngine({
        directory: home.path,
        apiVersion: '1.51',
        // One event, and then the machine is silent: the answer stays open.
        answer: (_request, response) => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write(
            `${JSON.stringify({ Type: 'container', Action: 'start' })}\n`,
          );
        },
      });
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: engine.socketPath,
        notRespondingAfter: '"Action":"start"',
      });
      const scenario = withClient(`
const events = [];
try {
  for await (const event of docker.events()) events.push(event.Action);
  console.log(JSON.stringify({ events, ended: true }));
} catch (error) {
  console.log(JSON.stringify({
    events,
    cause: error.cause?.name,
    exitCode: error.cause?.exitCode,
    stderr: error.cause?.stderr,
  }));
}
await docker[Symbol.asyncDispose]();
`);

      try {
        // Act
        const result = await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );

        // Assert
        assert.deepEqual(
          lastJson(result),
          {
            events: ['start'],
            cause: 'SshExitError',
            exitCode: 255,
            stderr: `${NOT_RESPONDING}\r\n`,
          },
          result.stderr,
        );
      } finally {
        for (const { pid } of await standIn.runs()) {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    },
  );

  test(
    'starts ssh -T -o BatchMode=yes -o ConnectTimeout=30 -l <user> -p <port> -- <machine> docker system dial-stdio',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      const argvOf = async (host: string) => {
        await using standIn = await sshStandIn({ kind: 'permission-denied' });
        const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
await Docker.connect({ clock: globalThis, host: ${JSON.stringify(host)} }).catch(() => undefined);
console.log('{}');
`;
        await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );
        return (await standIn.runs()).map(({ argv }) => argv);
      };

      // Act
      const full = await argvOf(HOST);
      const bare = await argvOf('ssh://machine');
      const encoded = await argvOf('ssh://deploy%40ops@machine');

      // Assert
      const dial = ['docker', 'system', 'dial-stdio'];
      const fixed = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30'];
      assert.deepEqual(full, [
        [...fixed, '-l', 'tester', '-p', '2222', '--', 'machine', ...dial],
      ]);
      assert.deepEqual(bare, [[...fixed, '--', 'machine', ...dial]]);
      assert.deepEqual(encoded, [
        [...fixed, '-l', 'deploy@ops', '--', 'machine', ...dial],
      ]);
    },
  );

  test(
    'an IPv6 machine goes to ssh without its brackets, as URL.Hostname() of Go gives it',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using standIn = await sshStandIn({ kind: 'permission-denied' });
      const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
await Docker.connect({ clock: globalThis, host: 'ssh://tester@[fd00::1]:2222' }).catch(() => undefined);
console.log('{}');
`;

      // Act
      await runScenario(scenario, scenarioEnvironment(standIn.path, home.path));

      // Assert
      assert.deepEqual(
        (await standIn.runs()).map(({ argv }) => argv),
        [
          [
            '-T',
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=30',
            '-l',
            'tester',
            '-p',
            '2222',
            '--',
            'fd00::1',
            'docker',
            'system',
            'dial-stdio',
          ],
        ],
      );
    },
  );

  test(
    'the sshFlags of the caller come first, before -T, in the order of the caller',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using standIn = await sshStandIn({ kind: 'permission-denied' });
      const sshFlags = [
        '-o',
        'ServerAliveInterval=10',
        '-o',
        'ServerAliveCountMax=2',
      ];
      const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
await Docker.connect({ clock: globalThis, host: ${JSON.stringify(HOST)}, sshFlags: ${JSON.stringify(sshFlags)} }).catch(() => undefined);
console.log('{}');
`;

      // Act
      await runScenario(scenario, scenarioEnvironment(standIn.path, home.path));

      // Assert
      assert.deepEqual(
        (await standIn.runs()).map(({ argv }) => argv),
        [
          [
            ...sshFlags,
            '-T',
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=30',
            '-l',
            'tester',
            '-p',
            '2222',
            '--',
            'machine',
            'docker',
            'system',
            'dial-stdio',
          ],
        ],
      );
    },
  );

  test(
    'sshFlags that name ConnectTimeout, as -o ConnectTimeout=5 or as -oConnectTimeout=5, go to ssh with no -o ConnectTimeout=30',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      const argvOf = async (sshFlags: string[]) => {
        await using standIn = await sshStandIn({ kind: 'permission-denied' });
        const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
await Docker.connect({ clock: globalThis, host: 'ssh://machine', sshFlags: ${JSON.stringify(sshFlags)} }).catch(() => undefined);
console.log('{}');
`;
        await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );
        return (await standIn.runs()).map(({ argv }) => argv);
      };

      // Act
      const twoArguments = await argvOf(['-o', 'ConnectTimeout=5']);
      const oneArgument = await argvOf(['-oConnectTimeout=5']);

      // Assert
      const rest = [
        '-T',
        '-o',
        'BatchMode=yes',
        '--',
        'machine',
        'docker',
        'system',
        'dial-stdio',
      ];
      assert.deepEqual(twoArguments, [['-o', 'ConnectTimeout=5', ...rest]]);
      assert.deepEqual(oneArgument, [['-oConnectTimeout=5', ...rest]]);
    },
  );

  test(
    'the sshFlags go to ssh when DOCKER_HOST or a context selected the ssh:// host',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      const config = join(home.path, 'docker-config');
      await writeContextStore(config, { contexts: { remote: HOST } });
      const argvOf = async (selection: object) => {
        await using standIn = await sshStandIn({ kind: 'permission-denied' });
        const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
await Docker.connect({ clock: globalThis, sshFlags: ['-o', 'ServerAliveInterval=10'], ...${JSON.stringify(selection)} }).catch(() => undefined);
console.log('{}');
`;
        await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );
        return (await standIn.runs()).map(({ argv }) => argv);
      };

      // Act
      const fromVariable = await argvOf({ environment: { DOCKER_HOST: HOST } });
      const fromContext = await argvOf({
        environment: { DOCKER_CONFIG: config },
        context: 'remote',
      });

      // Assert
      const expected = [
        [
          '-o',
          'ServerAliveInterval=10',
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=30',
          '-l',
          'tester',
          '-p',
          '2222',
          '--',
          'machine',
          'docker',
          'system',
          'dial-stdio',
        ],
      ];
      assert.deepEqual(fromVariable, expected);
      assert.deepEqual(fromContext, expected);
    },
  );

  test(
    'a unix:// engine ignores the sshFlags: the client connects and starts no ssh',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using engine = await fakeEngine({
        directory: home.path,
        apiVersion: '1.51',
      });
      await using standIn = await sshStandIn({ kind: 'permission-denied' });
      const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect({ clock: globalThis, host: ${JSON.stringify(engine.host)}, sshFlags: ['-o', 'ServerAliveInterval=10'] });
console.log(JSON.stringify({ host: docker.host }));
await docker[Symbol.asyncDispose]();
`;

      // Act
      const result = await runScenario(
        scenario,
        scenarioEnvironment(standIn.path, home.path),
      );

      // Assert
      assert.deepEqual(lastJson(result), { host: engine.host }, result.stderr);
      assert.deepEqual(await standIn.runs(), []);
    },
  );

  test(
    'no ssh on the PATH is a ConnectionFailedError',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      const scenario = `
import { ConnectionFailedError, Docker } from ${JSON.stringify(ENTRY)};
try {
  await Docker.connect({ clock: globalThis, host: ${JSON.stringify(HOST)}, signal: AbortSignal.timeout(20_000) });
  console.log(JSON.stringify({ connected: true }));
} catch (error) {
  console.log(JSON.stringify({
    failed: error instanceof ConnectionFailedError,
    host: error.host,
    code: error.cause?.code,
  }));
}
`;

      // Act
      const result = await runScenario(scenario, {
        PATH: home.path,
        HOME: home.path,
      });

      // Assert
      assert.deepEqual(
        lastJson(result),
        { failed: true, host: HOST, code: 'ENOENT' },
        result.stderr,
      );
    },
  );

  test(
    'info() reaches the engine through ssh, and host and cliEnvironment give the ssh:// host',
    {
      skip: needsLocalEngine,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: String(engineSocket),
      });
      const scenario = withClient(`
const info = await docker.info();
console.log(JSON.stringify({
  host: docker.host,
  context: docker.context,
  apiVersion: docker.apiVersion,
  cliEnvironment: docker.cliEnvironment,
  serverVersion: typeof info.ServerVersion,
  id: typeof info.ID,
}));
await docker[Symbol.asyncDispose]();
`);

      // Act
      const result = await runScenario(
        scenario,
        scenarioEnvironment(standIn.path, home.path),
      );

      // Assert
      const answer = lastJson(result);
      assert.match(
        String(Reflect.get(Object(answer), 'apiVersion')),
        /^1\.\d+$/,
      );
      assert.deepEqual(
        { ...Object(answer), apiVersion: undefined },
        {
          host: HOST,
          context: 'default',
          apiVersion: undefined,
          cliEnvironment: { DOCKER_HOST: HOST },
          serverVersion: 'string',
          id: 'string',
        },
        result.stderr,
      );
    },
  );

  test(
    'requests in sequence reuse one ssh process, and two concurrent requests use two',
    {
      skip: needsLocalEngine,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using sequential = await sshStandIn({
        kind: 'engine',
        socketPath: String(engineSocket),
      });
      await using concurrent = await sshStandIn({
        kind: 'engine',
        socketPath: String(engineSocket),
      });

      // Act
      const inSequence = await runScenario(
        withClient(`
await docker.info();
await docker.info();
await docker[Symbol.asyncDispose]();
console.log('{}');
`),
        scenarioEnvironment(sequential.path, home.path),
      );
      const together = await runScenario(
        withClient(`
await Promise.all([docker.info(), docker.info()]);
await docker[Symbol.asyncDispose]();
console.log('{}');
`),
        scenarioEnvironment(concurrent.path, home.path),
      );

      // Assert
      assert.equal(inSequence.exitCode, 0, inSequence.stderr);
      assert.equal(together.exitCode, 0, together.stderr);
      assert.equal(
        (await sequential.runs()).length,
        1,
        'the ping and two infos in sequence',
      );
      assert.equal(
        (await concurrent.runs()).length,
        2,
        'the ping, then two infos at the same time',
      );
    },
  );

  test(
    '20 requests in sequence on one ssh process give no MaxListenersExceededWarning',
    {
      skip: needsLocalEngine,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: String(engineSocket),
      });
      const scenario = `
const warnings = [];
process.on('warning', (warning) => warnings.push(warning.name + ': ' + warning.message));
${withClient(`
for (let request = 0; request < 20; request++) await docker.info();
await docker[Symbol.asyncDispose]();
console.log(JSON.stringify({ warnings }));
`)}`;

      // Act
      const result = await runScenario(
        scenario,
        scenarioEnvironment(standIn.path, home.path),
      );

      // Assert
      assert.deepEqual(lastJson(result), { warnings: [] }, result.stderr);
      assert.equal((await standIn.runs()).length, 1, 'one ssh process');
    },
  );

  test(
    'an idle connection whose ssh exits with 0, as after a restart of the engine, is not used again: the next request starts a new ssh',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using engine = await fakeEngine({
        directory: home.path,
        apiVersion: '1.51',
        answer: (_request, response) => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ ID: 'engine' }));
        },
      });
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: engine.socketPath,
        exitAfterFirstAnswer: true,
      });
      const scenario = withClient(`
const { readdirSync } = await import('node:fs');
const runs = ${JSON.stringify(`${standIn.path}/runs`)};
const [first] = readdirSync(runs).map((name) => Number.parseInt(name, 10));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// The client holds the ssh child and does not expose it, and no event reports the end of another process's child.
while (alive(first)) await new Promise((resolve) => setTimeout(resolve, 20));
const info = await docker.info().then((answer) => answer.ID, (error) => error.name + ': ' + error.message);
console.log(JSON.stringify({ info, started: readdirSync(runs).length }));
await docker[Symbol.asyncDispose]();
`);

      try {
        // Act
        const result = await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );

        // Assert
        assert.deepEqual(
          lastJson(result),
          { info: 'engine', started: 2 },
          result.stderr,
        );
      } finally {
        for (const { pid } of await standIn.runs()) {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    },
  );

  test(
    'a connection whose ssh exited with 0 before the caller read its answer to the end is not kept: the call right after the answer starts a new ssh and succeeds',
    {
      skip: posixOnly,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      const event = `${JSON.stringify({
        Type: 'container',
        Action: 'start',
        Actor: { ID: 'c'.repeat(64), Attributes: { name: 'n'.repeat(900) } },
      })}\n`;
      // 128 KB: more than the 64 KB of the answer that Node reads ahead of the
      // caller, so the end of the answer waits for the caller, and less than
      // what the client and the pipe of ssh hold together, so ssh can exit.
      const EVENTS = Math.ceil((128 * 1024) / event.length);
      await using engine = await fakeEngine({
        directory: home.path,
        apiVersion: '1.51',
        answer: (request, response) => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          if (request.url?.startsWith('/v1.51/events')) {
            // An engine that stops ends its events and closes the connection.
            response.end(event.repeat(EVENTS), () => request.socket.end());
            return;
          }
          response.end(JSON.stringify({ ID: 'engine' }));
        },
      });
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: engine.socketPath,
      });
      const scenario = withClient(`
const { readdirSync } = await import('node:fs');
const runs = ${JSON.stringify(`${standIn.path}/runs`)};
const [first] = readdirSync(runs).map((name) => Number.parseInt(name, 10));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const events = docker.events()[Symbol.asyncIterator]();
await events.next();
let read = 1;
// The client holds the ssh child and does not expose it, and no event reports the end of another process's child.
while (alive(first)) await new Promise((resolve) => setTimeout(resolve, 20));
while (!(await events.next()).done) read++;
const info = await docker.info().then((answer) => answer.ID, (error) => error.name + ': ' + error.message);
console.log(JSON.stringify({ read, info, started: readdirSync(runs).length }));
await docker[Symbol.asyncDispose]();
`);

      try {
        // Act
        const result = await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );

        // Assert
        assert.deepEqual(
          lastJson(result),
          { read: EVENTS, info: 'engine', started: 2 },
          result.stderr,
        );
      } finally {
        for (const { pid } of await standIn.runs()) {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    },
  );

  test(
    'disposal ends each ssh process and waits until it exited',
    {
      skip: needsLocalEngine,
    },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      // The stand-in keeps running after its standard input ends, so only a kill ends it.
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: String(engineSocket),
        ignoreInputEnd: true,
      });
      const scenario = withClient(`
await Promise.all([docker.info(), docker.info(), docker.info()]);
const { readdirSync } = await import('node:fs');
const pids = readdirSync(${JSON.stringify(`${standIn.path}/runs`)}).map((name) => Number.parseInt(name, 10));
await docker[Symbol.asyncDispose]();
const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
console.log(JSON.stringify({ started: pids.length, alive }));
`);

      try {
        // Act
        const result = await runScenario(
          scenario,
          scenarioEnvironment(standIn.path, home.path),
        );

        // Assert
        assert.deepEqual(
          lastJson(result),
          { started: 3, alive: [] },
          result.stderr,
        );
      } finally {
        for (const { pid } of await standIn.runs()) {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    },
  );

  test(
    'a process that connects and never disposes the client exits by itself, and its ssh processes end',
    {
      skip: needsLocalEngine,
    },
    async (t) => {
      // Arrange
      await using home = await scratchDirectory();
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: String(engineSocket),
      });
      const scenario = withClient(`
await Promise.all([docker.info(), docker.info()]);
console.log('connected');
`);

      // Act
      const result = await runScenario(
        scenario,
        scenarioEnvironment(standIn.path, home.path),
        AbortSignal.timeout(15_000),
      );

      // Assert
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'connected');
      const pids = (await standIn.runs()).map(({ pid }) => pid);
      try {
        assert.equal(pids.length, 2);
        await t.waitFor(() => assert.deepEqual(pids.filter(isAlive), []), {
          interval: 20,
          timeout: 10_000,
        });
      } finally {
        for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
      }
    },
  );
});
