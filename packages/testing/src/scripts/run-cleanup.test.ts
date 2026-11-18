import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { RunRecords, forwardName } from '../docker/run-records.ts';
import { type Run, removeRecordedPaths } from './run-cleanup.ts';

const localRun = (): Run => ({
  id: randomUUID(),
  endpoint: 'unix:///var/run/docker.sock',
  pid: process.pid,
});

test('the forward directory of the run goes, and then its record', async () => {
  const run = localRun();
  await using records = await new TemporaryFiles().directory('records-');
  await using forward = await new TemporaryFiles().directory(
    forwardName(run.id),
    {
      parent: '/tmp',
    },
  );
  await new RunRecords(records.path).recordForward(forward.path);

  removeRecordedPaths(run, records.path);

  await assert.rejects(access(forward.path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(records.path), []);
});

test('a record that names the directory below /tmp as written, not at its real path, also goes', async () => {
  const run = localRun();
  await using records = await new TemporaryFiles().directory('records-');
  await using forward = await new TemporaryFiles().directory(
    forwardName(run.id),
    {
      parent: '/tmp',
    },
  );
  const written = join('/tmp', basename(forward.path));
  await new RunRecords(records.path).recordForward(written);

  removeRecordedPaths(run, records.path);

  await assert.rejects(access(forward.path), { code: 'ENOENT' });
});

test('a record whose `..` leads out of /tmp is refused, and the directory it names stays', async () => {
  const run = localRun();
  await using records = await new TemporaryFiles().directory('records-');
  await using outside = await new TemporaryFiles().directory('outside-');
  const victim = join(outside.path, `${forwardName(run.id)}x`);
  await mkdir(victim);
  await new RunRecords(records.path).recordForward(`/tmp/..${victim}`);

  assert.throws(() => removeRecordedPaths(run, records.path), {
    message: /Invalid SSH forwarding cleanup record/,
  });
  await access(victim);
});

test('the forward directory of another run is refused, and it stays', async () => {
  const run = localRun();
  await using records = await new TemporaryFiles().directory('records-');
  await using other = await new TemporaryFiles().directory(
    forwardName(randomUUID()),
    {
      parent: '/tmp',
    },
  );
  await new RunRecords(records.path).recordForward(other.path);

  assert.throws(() => removeRecordedPaths(run, records.path), {
    message: /Invalid SSH forwarding cleanup record/,
  });
  await access(other.path);
});
