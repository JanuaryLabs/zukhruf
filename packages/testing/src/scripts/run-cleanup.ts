import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Docker } from '@zukhruf/docker';

import { SHARED_SERVER_LABEL } from '../docker/fixtures.ts';
import { DockerHost, SHELL_TIMEOUT, quote } from '../docker/host.ts';
import {
  TEST_RUN_LABEL,
  TestRun,
  directoryPrefix,
  forwardPrefix,
} from '../docker/test-run.ts';

/** How long one Engine API call of the cleanup may take. */
export const ENGINE_CALL_TIMEOUT = 240_000;

/** What the global setup writes to run.json. */
export interface Run {
  id: string;
  endpoint: string;
  pid: number;
}

const execute = promisify(execFile);

async function readRecordedPath(file: string): Promise<string> {
  const { path }: { path: string } = JSON.parse(await readFile(file, 'utf8'));
  return path;
}

/**
 * Removes what carries the run's label and what its records name, on the
 * engine that `engine` is connected to.
 */
export async function cleanup(
  engine: Docker,
  previous: Run,
  directory: string,
): Promise<void> {
  const host = new DockerHost(previous.endpoint, undefined);
  const owner = new TestRun(previous.id, directory);
  const signal = () => AbortSignal.timeout(ENGINE_CALL_TIMEOUT);
  // Labels are attached atomically at creation. Never prune an engine,
  // remove shared servers, or trust names alone as proof of ownership.
  const filters = { label: [`${TEST_RUN_LABEL}=${previous.id}`] };
  for (const summary of await engine.containers.list({
    all: true,
    filters,
    signal: signal(),
  })) {
    if (summary.Labels?.[SHARED_SERVER_LABEL] === '1') continue;
    const container = await engine.containers.find(summary.Id, {
      signal: signal(),
    });
    await container?.remove({ force: true, v: true, signal: signal() });
  }
  for (const { Name } of await engine.volumes.list({
    filters,
    signal: signal(),
  })) {
    const volume = await engine.volumes.find(Name, { signal: signal() });
    await volume?.remove({ signal: signal() });
  }
  for (const file of await readdir(directory)) {
    if (file.startsWith('forward-')) {
      const path = await readRecordedPath(join(directory, file));
      if (!path.startsWith(forwardPrefix(owner)) || path.slice(5).includes('/'))
        throw new Error(`Invalid SSH forwarding cleanup record: ${path}`);
      await rm(path, { recursive: true, force: true });
    } else if (file.startsWith('directory-')) {
      const path = await readRecordedPath(join(directory, file));
      if (!path.includes(`/${directoryPrefix(owner)}`) || path.includes('/../'))
        throw new Error(`Invalid fixture cleanup record: ${path}`);
      if (host.remote)
        await execute('ssh', [...host.sshArgs(), `rm -rf -- ${quote(path)}`], {
          timeout: SHELL_TIMEOUT,
        });
      else await rm(path, { recursive: true, force: true });
    }
  }
}

/** Connects to the run's engine, cleans the run, and ends the connection. */
export async function connectAndCleanup(
  previous: Run,
  directory: string,
): Promise<void> {
  // Disposal ends the connection, and with it the ssh child of an SSH engine.
  await using engine = await Docker.connect({
    host: previous.endpoint,
    signal: AbortSignal.timeout(ENGINE_CALL_TIMEOUT),
  });
  await cleanup(engine, previous, directory);
}
