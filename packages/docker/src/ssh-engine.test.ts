import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { describe, test } from 'node:test';

import { ENTRY, lastJson, runScenario } from './testing/scenario.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';
import {
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
const docker = await Docker.connect({ host: ${JSON.stringify(HOST)}, signal: AbortSignal.timeout(20_000) });
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
  await Docker.connect({ host: ${JSON.stringify(HOST)}, signal: AbortSignal.timeout(20_000) });
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
    'starts ssh -T -o BatchMode=yes -l <user> -p <port> -- <machine> docker system dial-stdio',
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
await Docker.connect({ host: ${JSON.stringify(host)} }).catch(() => undefined);
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
      const fixed = ['-T', '-o', 'BatchMode=yes'];
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
  await Docker.connect({ host: ${JSON.stringify(HOST)}, signal: AbortSignal.timeout(20_000) });
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
    async () => {
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
        await waitUntil(() => pids.every((pid) => !isAlive(pid)));
      } finally {
        for (const pid of pids.filter(isAlive)) process.kill(pid, 'SIGKILL');
      }
    },
  );
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The condition never held.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
