import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

/**
 * A consumer imports the package by its name, so these tests do too: a child
 * process resolves each path through the exports of package.json, the way an
 * installed copy resolves it.
 */
const run = async (source: string): Promise<unknown> => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
  ]);
  return JSON.parse(stdout);
};

const exportsOf = (path: string) =>
  run(
    `console.log(JSON.stringify(Object.keys(await import(${JSON.stringify(path)})).sort()));`,
  );

test('each lock-store family has its own import path with its stores and the errors they throw', async () => {
  for (const [family, names] of [
    ['memory', ['MemoryStore']],
    [
      'thread',
      [
        'CoordinatorUnavailableError',
        'GrantFailedError',
        'ThreadLockCoordinator',
        'ThreadStore',
      ],
    ],
    [
      'ipc',
      [
        'CoordinatorUnavailableError',
        'GrantFailedError',
        'IpcLockCoordinator',
        'IpcStore',
      ],
    ],
    [
      'file-system',
      [
        'FileLockStore',
        'LockFileStore',
        'NetworkDirectoryError',
        'TicketQueueFileStore',
      ],
    ],
    ['sqlite', ['NetworkDirectoryError', 'SqliteStore']],
    ['postgres', ['PostgresStore']],
    ['sqlserver', ['SqlServerStore']],
    ['mysql', ['MysqlStore']],
    ['mariadb', ['MariadbStore']],
    ['docker', ['DockerEngineStore']],
    [
      'socket',
      [
        'CoordinatorUnavailableError',
        'GrantFailedError',
        'NetworkDirectoryError',
        'ProtocolVersionError',
        'SocketStore',
        'UnsupportedRequestError',
      ],
    ],
  ] as const) {
    assert.deepEqual(
      await exportsOf(`@zukhruf/mutex/${family}`),
      names,
      `@zukhruf/mutex/${family}`,
    );
  }
});

test('the root import path has only the core and no lock store', async () => {
  assert.deepEqual(await exportsOf('@zukhruf/mutex'), [
    'Key',
    'LeaseLostError',
    'Modes',
    'Mutex',
    'SkipIfBusyMode',
    'WaitMode',
    'leaseFor',
  ]);
});

test('an error that several families throw is one class on every path, so instanceof holds', async () => {
  assert.deepEqual(
    await run(`
      const thread = await import('@zukhruf/mutex/thread');
      const ipc = await import('@zukhruf/mutex/ipc');
      const socket = await import('@zukhruf/mutex/socket');
      const fileSystem = await import('@zukhruf/mutex/file-system');
      const sqlite = await import('@zukhruf/mutex/sqlite');
      console.log(JSON.stringify([
        thread.CoordinatorUnavailableError === socket.CoordinatorUnavailableError,
        ipc.GrantFailedError === socket.GrantFailedError,
        fileSystem.NetworkDirectoryError === socket.NetworkDirectoryError,
        sqlite.NetworkDirectoryError === socket.NetworkDirectoryError,
      ]));
    `),
    [true, true, true, true],
  );
});

test('the remote internals have no import path', async () => {
  await assert.rejects(exportsOf('@zukhruf/mutex/remote'), (error: unknown) => {
    assert.ok(error instanceof Error && 'stderr' in error);
    assert.match(String(error.stderr), /ERR_PACKAGE_PATH_NOT_EXPORTED/);
    return true;
  });
});
