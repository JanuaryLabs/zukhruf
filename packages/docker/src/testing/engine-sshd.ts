import { execFile } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { localEngineSocket } from './local-engine.ts';
import { type Sshd, startSshd } from './sshd.ts';

const run = promisify(execFile);

/** The ssh:// host of the tests: the `Host` that the ssh_config of `clientFlags` names. */
export const SSH_HOST = 'ssh://engine';

async function dockerCliDirectory(): Promise<string | undefined> {
  try {
    const { stdout } = await run('sh', ['-c', 'command -v docker']);
    return dirname(await realpath(stdout.trim()));
  } catch (error) {
    // `command -v` exits with 1 when it finds no docker.
    if (Reflect.get(Object(error), 'code') === 1) return undefined;
    throw error;
  }
}

/** The local engine socket and the docker CLI directory that an sshd of the tests gives its sessions. */
export interface EngineForSshd {
  readonly engineSocket: string;
  readonly dockerCli: string;
}

/** The engine for an sshd of the tests, or why a test cannot run. */
export async function engineForSshd(): Promise<
  EngineForSshd | { readonly skip: string }
> {
  if (process.platform === 'win32') return { skip: 'Windows has no sshd' };
  const engineSocket = await localEngineSocket(process.env);
  if (engineSocket === undefined) {
    return {
      skip: 'the selected engine is not a local unix:// engine that sshd can reach',
    };
  }
  const dockerCli = await dockerCliDirectory();
  if (dockerCli === undefined) {
    return { skip: 'the PATH has no docker CLI for the sessions of sshd' };
  }
  return { engineSocket, dockerCli };
}

/** The engine of engineForSshd() in a test that runs only when it has one. */
export function ready(
  engine: EngineForSshd | { readonly skip: string },
): EngineForSshd {
  if ('skip' in engine) throw new Error(engine.skip);
  return engine;
}

/** The `skip` option of a test that needs the engine of engineForSshd(). */
export function skipWithout(
  engine: EngineForSshd | { readonly skip: string },
): string | false {
  return 'skip' in engine ? engine.skip : false;
}

/** The variables of a session that reaches the engine: the docker CLI on its PATH, and DOCKER_HOST. */
export function engineVariables(engine: EngineForSshd): {
  readonly PATH: string;
  readonly DOCKER_HOST: string;
} {
  return {
    PATH: `${engine.dockerCli}:/usr/bin:/bin`,
    DOCKER_HOST: `unix://${engine.engineSocket}`,
  };
}

/**
 * A real OpenSSH server whose sessions have `variables`, such as the PATH of
 * a docker CLI and the DOCKER_HOST of an engine socket, and the extra lines
 * `config` of sshd_config.
 */
export async function startEngineSshd(
  variables: Readonly<Record<string, string>>,
  config: readonly string[] = [],
): Promise<Sshd> {
  const setEnv = Object.entries(variables)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  return startSshd({ config: [`SetEnv ${setEnv}`, ...config] });
}

/**
 * The sshFlags of a client of `sshd`: `-F` and an ssh_config, written into
 * the directory of `sshd`, whose Host `engine` is that server, with its own
 * known hosts file. `port`, `identityFile` and `knownHosts` replace what the
 * config would have.
 */
export async function clientFlags(
  sshd: Sshd,
  options: {
    readonly port?: number;
    readonly identityFile?: string;
    readonly knownHosts?: string;
  } = {},
): Promise<string[]> {
  const port = options.port ?? sshd.port;
  const knownHostsFile = join(sshd.directory, 'client_known_hosts');
  await writeFile(
    knownHostsFile,
    options.knownHosts ?? `[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`,
  );
  const lines = [
    `Host ${new URL(SSH_HOST).hostname}`,
    'HostName 127.0.0.1',
    `Port ${port}`,
    `User ${userInfo().username}`,
    `IdentityFile ${options.identityFile ?? sshd.userKey}`,
    'IdentitiesOnly yes',
    'IdentityAgent none',
    `UserKnownHostsFile ${knownHostsFile}`,
    'GlobalKnownHostsFile /dev/null',
    'StrictHostKeyChecking yes',
  ];
  const file = join(sshd.directory, 'client_config');
  await writeFile(file, `${lines.join('\n')}\n`);
  return ['-F', file];
}
