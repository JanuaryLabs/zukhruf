import assert from 'node:assert/strict';
import { mkdtempDisposable, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileFlightRecords } from './index.ts';

test(
  'finish of a flight that is no longer running changes nothing',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = new FileFlightRecords(directory.path);
    const stopped = await records.begin('sync');
    const next = await records.begin('sync');
    await records.finish('sync', next, { status: 'succeeded', value: 'next' });

    await records.finish('sync', stopped, {
      status: 'succeeded',
      value: 'late',
    });
    await records.finish('sync', next, {
      status: 'failed',
      error: { name: 'Error', message: 'twice' },
    });

    assert.deepEqual(await records.outcome('sync', stopped), {
      status: 'interrupted',
      successor: next,
    });
    assert.deepEqual(await records.outcome('sync', next), {
      status: 'succeeded',
      value: 'next',
    });
  },
);

test(
  'keys that are not file names each get their own record inside the directory',
  { timeout: 10_000 },
  async () => {
    await using parent = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = new FileFlightRecords(join(parent.path, 'flights'));
    const keys = [
      'report:daily',
      'report:Daily',
      'a/b',
      '../outside',
      '\uD800',
      '\uDBFF',
    ];

    const ids = [];
    for (const key of keys) ids.push(await records.begin(key));
    for (const [index, key] of keys.entries()) {
      await records.finish(key, ids[index]!, {
        status: 'succeeded',
        value: key,
      });
    }

    for (const [index, key] of keys.entries()) {
      assert.deepEqual(await records.latest(key), {
        id: ids[index],
        status: 'succeeded',
      });
      assert.deepEqual(await records.outcome(key, ids[index]!), {
        status: 'succeeded',
        value: key,
      });
    }
    assert.deepEqual(await readdir(parent.path), ['flights']);
  },
);

test(
  'a file that is not a flight record makes each read fail with the path of the file',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = new FileFlightRecords(directory.path);
    const id = await records.begin('sync');
    const [name] = await readdir(directory.path);
    const file = join(directory.path, name!);
    const namesTheFile = (error: unknown) =>
      error instanceof Error && error.message.includes(JSON.stringify(file));
    const foreign = [
      JSON.stringify({ flights: 'none' }),
      JSON.stringify({ flights: [{ id: 1, outcome: { status: 'running' } }] }),
      JSON.stringify({ flights: [{ id, outcome: { status: 'succeeded' } }] }),
      'not JSON',
    ];

    for (const content of foreign) {
      // Another program writes in the directory, which only the records may use.
      await writeFile(file, content);
      await assert.rejects(records.latest('sync'), namesTheFile, content);
      await assert.rejects(records.outcome('sync', id), namesTheFile, content);
    }
  },
);

test(
  'a joiner that reads while the holder writes never sees part of a record',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    // The file keeps one flight, so each write has the same size and the
    // test costs the same on a slow runner.
    const holder = new FileFlightRecords(directory.path, { keepFor: 0 });
    const joiner = new FileFlightRecords(directory.path);
    const report = 'row\n'.repeat(5000);
    const failures: unknown[] = [];
    let writing = true;

    const readers = [1, 2, 3, 4].map(async () => {
      while (writing) {
        await joiner
          .latest('sync')
          .catch((error: unknown) => failures.push(error));
      }
    });
    try {
      for (let flight = 0; flight < 200; flight++) {
        const id = await holder.begin('sync');
        await holder.finish('sync', id, { status: 'succeeded', value: report });
      }
    } finally {
      writing = false;
      await Promise.all(readers);
    }

    assert.deepEqual(failures, []);
  },
);

test(
  'the outcome of a flight stays readable after newer flights of the key began and ended',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = new FileFlightRecords(directory.path);
    const first = await records.begin('sync');
    await records.finish('sync', first, {
      status: 'succeeded',
      value: 'first',
    });

    for (let flight = 0; flight < 5; flight++) {
      const id = await records.begin('sync');
      await records.finish('sync', id, { status: 'succeeded', value: 'newer' });
    }

    assert.deepEqual(await records.outcome('sync', first), {
      status: 'succeeded',
      value: 'first',
    });
  },
);
