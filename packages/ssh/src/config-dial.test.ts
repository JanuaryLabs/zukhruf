import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { TemporaryFiles } from '@zukhruf/fs';

import { OpenSshConfig } from './config.ts';
import { AuthenticationError, ExitError } from './index.ts';
import { KeyError, RevokedError } from './knownhosts.ts';
import { startSilentServer } from './testing/silent-server.ts';
import { type SshAgent, startSshAgent } from './testing/ssh-agent.ts';
import { type Sshd, startSshd } from './testing/sshd.ts';

const noSsh =
  process.platform === 'win32'
    ? 'the tests run OpenSSH ssh, sshd and ssh-agent with Unix paths and sockets'
    : false;

const run = promisify(execFile);

/**
 * A config file for ssh -F that reaches the sshd of the test as `box`. The
 * lines of the test come first, so they win, as in OpenSSH; after them, the
 * known hosts are the test's own file, and no agent and no other host key
 * policy than `yes` apply unless the test sets them.
 */
async function writeConfig(
  directory: string,
  sshd: Sshd,
  lines: readonly string[],
): Promise<string> {
  const file = join(directory, 'ssh_config');
  await writeFile(
    file,
    [
      'Host box',
      ...lines.map((line) => `  ${line}`),
      '  HostName 127.0.0.1',
      `  Port ${sshd.port}`,
      `  User ${userInfo().username}`,
      `  UserKnownHostsFile ${join(directory, 'known_hosts')}`,
      '  GlobalKnownHostsFile /dev/null',
      '  IdentityAgent none',
      '  StrictHostKeyChecking yes',
      '',
    ].join('\n'),
  );
  return file;
}

/** The known hosts line of the sshd of the test, as OpenSSH writes it for a port other than 22. */
function knownHost(sshd: Sshd, key = sshd.hostPublicKey): string {
  return `[127.0.0.1]:${sshd.port} ${withoutComment(key)}\n`;
}

/** `type base64` of a public key line, without its comment. */
function withoutComment(key: string): string {
  return key.split(' ').slice(0, 2).join(' ');
}

async function generateKey(
  file: string,
  options: { readonly type?: string; readonly passphrase?: string } = {},
): Promise<string> {
  await run('ssh-keygen', [
    '-q',
    '-t',
    options.type ?? 'ed25519',
    '-N',
    options.passphrase ?? '',
    '-f',
    file,
  ]);
  return file;
}

/** Lets the sshd of the test accept the key of a file; sshd reads authorized_keys at each login. */
async function authorize(sshd: Sshd, keyFile: string): Promise<void> {
  await appendFile(
    join(sshd.directory, 'authorized_keys'),
    await readFile(`${keyFile}.pub`),
  );
}

/** The lines that OpenSSH's `ssh-keygen -F` finds for the name in the file, without its comment lines. */
async function findHost(name: string, file: string): Promise<string[]> {
  try {
    const { stdout } = await run('ssh-keygen', ['-F', name, '-f', file]);
    return stdout
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 1) return [];
    throw error;
  }
}

async function resolve(
  file: string,
  environment: Readonly<Record<string, string>>,
): Promise<OpenSshConfig> {
  return OpenSshConfig.resolve('box', { flags: ['-F', file], environment });
}

async function agentWithKey(
  name: string,
): Promise<{ readonly agent: SshAgent; readonly keyFile: string }> {
  const agent = await startSshAgent();
  const keyFile = await agent.generateKey(name);
  await agent.sshAdd([keyFile]);
  return { agent, keyFile };
}

test(
  'under StrictHostKeyChecking yes, an unknown host key rejects with KeyError with no want, and adds no line',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), '');
    const config = await resolve(
      await writeConfig(directory.path, sshd, [`IdentityFile ${sshd.userKey}`]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, (error) => {
      assert.ok(error instanceof KeyError);
      assert.deepEqual(error.want, []);
      return true;
    });
    assert.deepEqual(
      await findHost(
        `[127.0.0.1]:${sshd.port}`,
        join(directory.path, 'known_hosts'),
      ),
      [],
    );
  },
);

test(
  'under StrictHostKeyChecking yes, a revoked host key rejects with RevokedError',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      `@revoked ${knownHost(sshd)}${knownHost(sshd)}`,
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [`IdentityFile ${sshd.userKey}`]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, RevokedError);
  },
);

test(
  'under StrictHostKeyChecking ask, an unknown host key rejects with KeyError, as under yes: the client never prompts',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking ask',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, (error) => {
      assert.ok(error instanceof KeyError);
      assert.deepEqual(error.want, []);
      return true;
    });
  },
);

test(
  'under StrictHostKeyChecking yes, a changed host key rejects with KeyError whose want is the known line',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const other = await generateKey(join(directory.path, 'other'));
    const knownHosts = join(directory.path, 'known_hosts');
    await writeFile(
      knownHosts,
      knownHost(sshd, (await readFile(`${other}.pub`, 'utf8')).trim()),
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [`IdentityFile ${sshd.userKey}`]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, (error) => {
      assert.ok(error instanceof KeyError);
      assert.deepEqual(
        error.want.map(({ file, line }) => `${file}:${line}`),
        [`${knownHosts}:1`],
      );
      return true;
    });
  },
);

test(
  'under StrictHostKeyChecking accept-new, a changed host key rejects with KeyError',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const other = await generateKey(join(directory.path, 'other'));
    await writeFile(
      join(directory.path, 'known_hosts'),
      knownHost(sshd, (await readFile(`${other}.pub`, 'utf8')).trim()),
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking accept-new',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, (error) => {
      assert.ok(error instanceof KeyError);
      assert.equal(error.want.length, 1);
      return true;
    });
  },
);

test(
  'under StrictHostKeyChecking accept-new, a revoked host key rejects with RevokedError',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      `@revoked ${knownHost(sshd)}`,
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking accept-new',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, RevokedError);
  },
);

test(
  'under StrictHostKeyChecking accept-new, an unknown host key is added to the first user file and the dial connects',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const [first, second, global] = ['first', 'second', 'global'].map((name) =>
      join(directory.path, name),
    );
    await writeFile(second ?? '', '');
    await writeFile(global ?? '', '');
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking accept-new',
        `UserKnownHostsFile ${first} ${second}`,
        `GlobalKnownHostsFile ${global}`,
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    const name = `[127.0.0.1]:${sshd.port}`;
    assert.deepEqual(await findHost(name, first ?? ''), [
      knownHost(sshd).trim(),
    ]);
    assert.deepEqual(await findHost(name, second ?? ''), []);
    assert.deepEqual(await findHost(name, global ?? ''), []);
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'under StrictHostKeyChecking accept-new with HashKnownHosts yes, the added line is hashed',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const knownHosts = join(directory.path, 'known_hosts');
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking accept-new',
        'HashKnownHosts yes',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using _client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    const [found] = await findHost(`[127.0.0.1]:${sshd.port}`, knownHosts);
    assert.match(found ?? '', /^\|1\|/);
    assert.ok((found ?? '').endsWith(` ${withoutComment(sshd.hostPublicKey)}`));
  },
);

test(
  'under StrictHostKeyChecking no, an unknown host key is added to the first user file and the dial connects',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking no',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.deepEqual(
      await findHost(
        `[127.0.0.1]:${sshd.port}`,
        join(directory.path, 'known_hosts'),
      ),
      [knownHost(sshd).trim()],
    );
    await client.listen('tcp', '127.0.0.1:0', () => undefined);
  },
);

test(
  'under StrictHostKeyChecking no, a changed host key connects in the restricted mode: sessions and dial work, listen rejects with the KeyError, and no session gets the agent',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const { agent } = await agentWithKey('forwarded-key');
    await using _agent = agent;
    const other = await generateKey(join(directory.path, 'other'));
    await writeFile(
      join(directory.path, 'known_hosts'),
      knownHost(sshd, (await readFile(`${other}.pub`, 'utf8')).trim()),
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking no',
        'ForwardAgent yes',
        `IdentityFile ${sshd.userKey}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: agent.socket,
      },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
    (await client.dial('tcp', `127.0.0.1:${sshd.port}`)).destroy();
    await assert.rejects(
      client.listen('tcp', '127.0.0.1:0', () => undefined),
      (error) => error instanceof KeyError && error.want.length === 1,
    );
    await assert.rejects(client.newSession().run('ssh-add -l'), (error) => {
      assert.ok(error instanceof ExitError);
      assert.deepEqual(error.exit, { kind: 'status', exitStatus: 2 });
      return true;
    });
  },
);

test(
  'under StrictHostKeyChecking no, a revoked host key connects in the restricted mode, and listen rejects with the RevokedError',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      `@revoked ${knownHost(sshd)}`,
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'StrictHostKeyChecking no',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
    await assert.rejects(
      client.listen('tcp', '127.0.0.1:0', () => undefined),
      RevokedError,
    );
  },
);

test(
  'a HostKeyAlias is looked up as it is, with no port, in place of the hostname',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      `box-alias ${withoutComment(sshd.hostPublicKey)}\n`,
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'HostKeyAlias box-alias',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'a host key that only a GlobalKnownHostsFile knows is trusted',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const global = join(directory.path, 'global');
    await writeFile(global, knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        `GlobalKnownHostsFile ${global}`,
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'the algorithm of the key known under the HostKeyAlias goes first, so a server with two host keys signs with the one that the known hosts hold',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const ecdsa = await generateKey(join(directory.path, 'host_ecdsa'), {
      type: 'ecdsa',
    });
    await using sshd = await startSshd({ config: [`HostKey ${ecdsa}`] });
    await writeFile(
      join(directory.path, 'known_hosts'),
      `box-alias ${withoutComment(await readFile(`${ecdsa}.pub`, 'utf8'))}\n`,
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'HostKeyAlias box-alias',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'a missing agent socket offers no agent key, and the identity files still authenticate',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'IdentityAgent SSH_AUTH_SOCK',
        `IdentityFile ${sshd.userKey}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: join(directory.path, 'no-agent.sock'),
      },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'an encrypted identity file is skipped when no agent holds its key, and the next identity file authenticates',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const encrypted = await generateKey(join(directory.path, 'encrypted'), {
      passphrase: 'secret phrase',
    });
    await authorize(sshd, encrypted);
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        `IdentityFile ${encrypted}`,
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'an identity file that is not a key the package can read is skipped, and the next identity file authenticates',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const garbage = join(directory.path, 'garbage');
    await writeFile(garbage, 'not a key\n');
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        `IdentityFile ${garbage}`,
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'the agent of SSH_AUTH_SOCK of the environment authenticates when no identity file exists',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const { agent, keyFile } = await agentWithKey('agent-key');
    await using _agent = agent;
    await authorize(sshd, keyFile);
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, ['IdentityAgent SSH_AUTH_SOCK']),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: agent.socket,
      },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'the keys of the agent go before the identity files: with MaxAuthTries 1, the agent key logs in before a refused file key ends the login',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd({ config: ['MaxAuthTries 1'] });
    const { agent, keyFile } = await agentWithKey('agent-key');
    await using _agent = agent;
    await authorize(sshd, keyFile);
    const refused = await generateKey(join(directory.path, 'refused'));
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'IdentityAgent SSH_AUTH_SOCK',
        `IdentityFile ${refused}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: agent.socket,
      },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'with IdentitiesOnly yes, a key of the agent that no identity file names is not offered',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const { agent, keyFile } = await agentWithKey('agent-key');
    await using _agent = agent;
    await authorize(sshd, keyFile);
    const refused = await generateKey(join(directory.path, 'refused'));
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'IdentityAgent SSH_AUTH_SOCK',
        'IdentitiesOnly yes',
        `IdentityFile ${refused}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: agent.socket,
      },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, AuthenticationError);
  },
);

test(
  'with IdentitiesOnly yes, the agent signs for an encrypted identity file whose key it holds',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const { agent, keyFile } = await agentWithKey('agent-key');
    await using _agent = agent;
    await authorize(sshd, keyFile);
    await run('ssh-keygen', ['-q', '-p', '-N', 'secret phrase', '-f', keyFile]);
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'IdentityAgent SSH_AUTH_SOCK',
        'IdentitiesOnly yes',
        `IdentityFile ${keyFile}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: agent.socket,
      },
    );

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'each session gets the SetEnv variables and the variables of the environment that a SendEnv pattern names with * or ?, and no other variable',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd({ config: ['AcceptEnv *'] });
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'SetEnv FROM_SETENV="set value"',
        'SendEnv LC_* NAME?',
        `IdentityFile ${sshd.userKey}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        LC_TEST: 'sent by pattern',
        NAMED: 'sent by name',
        UNNAMED: 'kept',
      },
    );
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    const output = await client
      .newSession()
      .output(
        'printf "%s|%s|%s|%s" "$FROM_SETENV" "$LC_TEST" "$NAMED" "$UNNAMED"',
      );

    // Assert
    assert.equal(String(output), 'set value|sent by pattern|sent by name|');
  },
);

test(
  'a SetEnv variable wins over the variable of the environment of the same name that SendEnv names',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd({ config: ['AcceptEnv *'] });
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'SetEnv LC_TEST=from-setenv',
        'SendEnv LC_*',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path, LC_TEST: 'from-env' },
    );
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    const output = await client.newSession().output('printf %s "$LC_TEST"');

    // Assert
    assert.equal(String(output), 'from-setenv');
  },
);

test(
  'with ForwardAgent yes, ssh-add -l in a session lists the keys of the agent at SSH_AUTH_SOCK of the environment',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const { agent, keyFile } = await agentWithKey('forwarded-key');
    await using _agent = agent;
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'ForwardAgent yes',
        `IdentityFile ${sshd.userKey}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: agent.socket,
      },
    );
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    const listed = await client.newSession().output('ssh-add -l');

    // Assert
    assert.ok(
      String(listed).includes(
        `${await agent.fingerprint(keyFile)} forwarded-key`,
      ),
    );
  },
);

test(
  'with ForwardAgent set to a socket path, a session gets the agent at that path, not the one at SSH_AUTH_SOCK',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const { agent: named, keyFile } = await agentWithKey('named-agent-key');
    await using _named = named;
    const { agent: other } = await agentWithKey('other-agent-key');
    await using _other = other;
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        `ForwardAgent ${named.socket}`,
        `IdentityFile ${sshd.userKey}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: other.socket,
      },
    );
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    const listed = await client.newSession().output('ssh-add -l');

    // Assert
    assert.deepEqual(
      String(listed)
        .trim()
        .split('\n')
        .map((line) => line.split(' ')[1]),
      [await named.fingerprint(keyFile)],
    );
  },
);

test(
  'with ForwardAgent no, a session finds no agent although SSH_AUTH_SOCK is set',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const { agent } = await agentWithKey('agent-key');
    await using _agent = agent;
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'ForwardAgent no',
        `IdentityFile ${sshd.userKey}`,
      ]),
      {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        SSH_AUTH_SOCK: agent.socket,
      },
    );
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    const ran = client.newSession().run('ssh-add -l');

    // Assert
    await assert.rejects(ran, (error) => {
      assert.ok(error instanceof ExitError);
      assert.deepEqual(error.exit, { kind: 'status', exitStatus: 2 });
      return true;
    });
  },
);

test(
  'with ForwardAgent yes and no SSH_AUTH_SOCK in the environment, no session asks for agent forwarding',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'ForwardAgent yes',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    const output = await client
      .newSession()
      .output('printf %s "${SSH_AUTH_SOCK-unset}"');

    // Assert
    assert.equal(String(output), 'unset');
  },
);

test(
  'ConnectTimeout rejects the dial with a TimeoutError when it passes on the given clock, and not before',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using server = await startSilentServer();
    const file = join(directory.path, 'ssh_config');
    await writeFile(
      file,
      [
        'Host box',
        '  HostName 127.0.0.1',
        `  Port ${server.port}`,
        '  ConnectTimeout 5',
        '  IdentityAgent none',
        '',
      ].join('\n'),
    );
    const config = await resolve(file, {
      PATH: '/usr/bin:/bin',
      HOME: directory.path,
    });
    const clock = createClock();
    let settled = false;
    const dial = config.dial({ clock, signal: t.signal });
    dial.then(
      () => (settled = true),
      () => (settled = true),
    );
    await server.accepted;

    // Act
    clock.tick(4999);
    await nextMacrotask();
    const settledBefore = settled;
    clock.tick(1);

    // Assert
    assert.equal(settledBefore, false);
    await assert.rejects(dial, (error) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, 'TimeoutError');
      return true;
    });
  },
);

test(
  'ServerAliveInterval ends a connection to a server that stops answering, on the clock of the dial, and wait() rejects with the keepalive error',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        // An hour: a keepalive on the real clock cannot end the connection
        // before the test times out.
        'ServerAliveInterval 3600',
        'ServerAliveCountMax 1',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );
    const clock = createClock();
    await using client = await config.dial({ clock, signal: t.signal });

    // Act
    sshd.kill('SIGSTOP');
    // Data that sshd sent before the stop, such as its
    // hostkeys-00@openssh.com request after the login, can arrive while the
    // clock runs, and each arrival moves the next check an interval later. So
    // the clock runs the timers of the check until the keepalive end stops
    // the last one.
    await clock.runAllAsync();

    // Assert
    await assert.rejects(client.wait(), /keepalive/i);
  },
);

test(
  'AddressFamily inet6 connects over IPv6 only: localhost to a server only on 127.0.0.1 fails',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      `[localhost]:${sshd.port} ${withoutComment(sshd.hostPublicKey)}\n`,
    );
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        'HostName localhost',
        'AddressFamily inet6',
        `IdentityFile ${sshd.userKey}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(
      dial,
      (error) =>
        Error.isError(error) &&
        'code' in error &&
        ['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH'].includes(
          String(error.code),
        ),
    );
  },
);

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

test(
  'under ControlMaster auto, a second share() of the host joins the first: the server sees one connection, and each runs a command',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        `IdentityFile ${sshd.userKey}`,
        'ControlMaster auto',
        `ControlPath ${join(directory.path, 'cm')}`,
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );
    await using first = await config.share({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    await using second = await config.share({
      clock: createClock(),
      signal: t.signal,
    });
    const outputs = await Promise.all(
      [first, second].map(async (shared) =>
        String(await shared.newSession().output('echo ran')),
      ),
    );

    // Assert
    assert.deepEqual(outputs, ['ran\n', 'ran\n']);
    assert.equal(sshd.connections(), 1);
  },
);

/** The config of `box` with `lines` and a ControlPath in `directory`, resolved as OpenSSH would. */
async function sharing(
  directory: string,
  sshd: Sshd,
  lines: readonly string[],
): Promise<OpenSshConfig> {
  return resolve(
    await writeConfig(directory, sshd, [
      `IdentityFile ${sshd.userKey}`,
      `ControlPath ${join(directory, 'cm')}`,
      ...lines,
    ]),
    { PATH: '/usr/bin:/bin', HOME: directory },
  );
}

/** A Unix socket server at `path` that answers each connection with `greeting`, or with nothing. */
async function listenAt(path: string, greeting?: Buffer): Promise<Server> {
  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    if (greeting !== undefined) socket.write(greeting);
  });
  server.listen(path);
  await once(server, 'listening');
  return server;
}

test(
  'under ControlMaster auto, a peer at the socket that speaks another protocol gives a connection of this process that works, and keeps its socket',
  { skip: noSsh },
  async (t) => {
    // Arrange: OpenSSH's MUX_MSG_HELLO, version 4 (PROTOCOL.mux).
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await sharing(directory.path, sshd, ['ControlMaster auto']);
    const peer = await listenAt(
      join(directory.path, 'cm.zukhruf'),
      Buffer.from([0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 0, 4]),
    );
    try {
      // Act
      await using shared = await config.share({
        clock: createClock(),
        signal: t.signal,
      });

      // Assert
      assert.equal(
        String(await shared.newSession().output('echo ran')),
        'ran\n',
      );
      assert.equal(sshd.connections(), 1);
      assert.ok(peer.listening);
    } finally {
      peer.close();
    }
  },
);

test(
  'under ControlMaster auto, a peer at the socket that sends no hello for ConnectTimeout gives a connection of this process',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await sharing(directory.path, sshd, [
      'ControlMaster auto',
      'ConnectTimeout 5',
    ]);
    const peer = await listenAt(join(directory.path, 'cm.zukhruf'));
    const clock = createClock();
    try {
      const sharingStarted = config.share({ clock, signal: t.signal });

      // Act
      await clock.tickAsync(5000);
      await using shared = await sharingStarted;

      // Assert
      assert.equal(
        String(await shared.newSession().output('echo ran')),
        'ran\n',
      );
      assert.equal(sshd.connections(), 1);
    } finally {
      peer.close();
    }
  },
);

test(
  'under ControlMaster yes, a socket that a master already holds gives a connection of this process, and the master still serves the next share()',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const auto = await sharing(directory.path, sshd, ['ControlMaster auto']);
    await using master = await auto.share({
      clock: createClock(),
      signal: t.signal,
    });
    const yes = await sharing(directory.path, sshd, ['ControlMaster yes']);

    // Act
    await using own = await yes.share({
      clock: createClock(),
      signal: t.signal,
    });
    await using joined = await auto.share({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    const outputs = await Promise.all(
      [master, own, joined].map(async (shared) =>
        String(await shared.newSession().output('echo ran')),
      ),
    );
    assert.deepEqual(outputs, ['ran\n', 'ran\n', 'ran\n']);
    assert.equal(sshd.connections(), 2);
  },
);

test(
  'under ControlMaster no, share() joins a master at the socket, and with none there it is a connection of this process that makes no socket',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const no = await sharing(directory.path, sshd, ['ControlMaster no']);
    const auto = await sharing(directory.path, sshd, ['ControlMaster auto']);

    // Act
    const alone = await no.share({ clock: createClock(), signal: t.signal });
    const aloneMadeSocket = await stat(join(directory.path, 'cm.zukhruf')).then(
      () => true,
      () => false,
    );
    await alone.close();
    await using master = await auto.share({
      clock: createClock(),
      signal: t.signal,
    });
    await using joined = await no.share({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(aloneMadeSocket, false);
    assert.equal(String(await joined.newSession().output('echo ran')), 'ran\n');
    assert.equal(sshd.connections(), 2);
  },
);

for (const setting of ['ask', 'autoask']) {
  test(
    `under ControlMaster ${setting}, share() rejects with an error that names the setting, before any connection`,
    { skip: noSsh },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('ssh-', {
        parent: '/tmp',
      });
      await using sshd = await startSshd();
      await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
      const config = await sharing(directory.path, sshd, [
        `ControlMaster ${setting}`,
      ]);

      // Act
      const shared = config.share({ clock: createClock(), signal: t.signal });

      // Assert
      await assert.rejects(shared, {
        message: `ssh: ControlMaster ${setting} is not supported: it confirms each use of the master through ssh-askpass`,
      });
      assert.equal(sshd.connections(), 0);
    },
  );
}

test(
  'with ControlPath none, share() is a connection of this process alone: a second share() makes a second connection',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await resolve(
      await writeConfig(directory.path, sshd, [
        `IdentityFile ${sshd.userKey}`,
        'ControlMaster auto',
        'ControlPath none',
      ]),
      { PATH: '/usr/bin:/bin', HOME: directory.path },
    );

    // Act
    await using first = await config.share({
      clock: createClock(),
      signal: t.signal,
    });
    await using second = await config.share({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    const outputs = await Promise.all(
      [first, second].map(async (shared) =>
        String(await shared.newSession().output('echo ran')),
      ),
    );
    assert.deepEqual(outputs, ['ran\n', 'ran\n']);
    assert.equal(sshd.connections(), 2);
  },
);

test(
  'under ControlMaster auto, a master that closes while another share() holds it serves that one on, and once it closes, the server sees the connection end and the socket is gone',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const config = await sharing(directory.path, sshd, ['ControlMaster auto']);
    const master = await config.share({
      clock: createClock(),
      signal: t.signal,
    });
    const joined = await config.share({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    await master.close();
    const output = String(await joined.newSession().output('echo ran'));
    await joined.close();

    // Assert
    assert.equal(output, 'ran\n');
    await sshd.connectionsEnded({ signal: t.signal });
    await assert.rejects(stat(join(directory.path, 'cm.zukhruf')), {
      code: 'ENOENT',
    });
    assert.equal(sshd.connections(), 1);
  },
);
