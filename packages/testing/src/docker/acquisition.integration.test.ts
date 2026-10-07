import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import spawn from 'nano-spawn';

import { Docker } from './index.ts';

const docker = new Docker();
const skip =
  process.platform === 'win32'
    ? 'the Docker CLI stand-in is a POSIX shell script'
    : false;

/**
 * Stands in for the Docker CLI on PATH. Each `container inspect <name>` call
 * is appended to `calls` and takes the next line of `faults`: `missing`
 * replays the daemon's answer for a name it has reserved but not registered
 * yet, `daemon` an engine that stopped answering. Everything else reaches the
 * real CLI.
 */
const standIn = (docker: string, name: string, directory: string) => `#!/bin/sh
if [ "$1" = container ] && [ "$2" = inspect ] && [ "$3" = '${name}' ]; then
  echo inspect >> '${directory}/calls'
  fault=$(head -n 1 '${directory}/faults')
  tail -n +2 '${directory}/faults' > '${directory}/rest'
  mv '${directory}/rest' '${directory}/faults'
  case "$fault" in
    missing) echo "Error response from daemon: No such object: $3" >&2; exit 1 ;;
    daemon) echo 'Cannot connect to the Docker daemon (injected)' >&2; exit 1 ;;
  esac
fi
exec '${docker}' "$@"
`;

/** One process that reuses the server once, as a test file of a consumer does. */
const reuseOnce = (name: string) => `
  import { Docker } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
  try {
    const server = await new Docker().reuse({
      name: ${JSON.stringify(name)},
      image: 'postgres:18-alpine',
      internalPort: 5432,
      env: { POSTGRES_PASSWORD: 'testpassword' },
    });
    const { stdout } = await server.exec(['printenv', 'POSTGRES_PASSWORD']);
    await server.disconnect();
    console.log(JSON.stringify({ id: server.containerId, password: stdout }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
  }
`;

test(
  'reuse waits for a reserved name to become inspectable, and does not retry a daemon failure',
  { skip, timeout: 120_000 },
  async () => {
    const name = `zukhruf-testing-acquisition-${randomUUID()}`;
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-testing-acquisition-'),
    );
    const { stdout: realDocker } = await spawn('which', ['docker']);
    await writeFile(
      join(directory.path, 'docker'),
      standIn(realDocker, name, directory.path),
      { mode: 0o755 },
    );
    const inspections = async () =>
      (await readFile(join(directory.path, 'calls'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean).length;
    const acquire = async (faults: string[]) => {
      await writeFile(join(directory.path, 'faults'), faults.join('\n') + '\n');
      const before = await inspections();
      const { stdout } = await spawn(
        process.execPath,
        ['--input-type=module', '--eval', reuseOnce(name)],
        { env: { PATH: `${directory.path}:${process.env.PATH}` } },
      );
      return {
        result: JSON.parse(stdout),
        inspections: (await inspections()) - before,
      };
    };
    try {
      const server = await acquire([]);
      assert.ok(server.result.id, JSON.stringify(server.result));

      // The real daemon can reserve the name before inspect sees the
      // container: the first lookup and the first lookup after the create
      // conflict both miss it.
      const waited = await acquire(['missing', 'missing']);

      assert.deepEqual(waited.result, {
        id: server.result.id,
        password: 'testpassword',
      });
      assert.equal(waited.inspections, 3);

      const failed = await acquire(['missing', 'daemon']);

      assert.deepEqual(failed.result, {
        error:
          'Command failed with exit code 1: docker container inspect ' + name,
      });
      assert.equal(failed.inspections, 2);
    } finally {
      await docker.command(['rm', '--force', name]).catch(() => {});
    }
  },
);
