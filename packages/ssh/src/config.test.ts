import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { OpenSshConfig } from './config.ts';
import { PATH } from './testing/path.ts';
import { startReports } from './testing/reports.ts';

const noSsh =
  process.platform === 'win32'
    ? 'the tests run the OpenSSH ssh binary on a config file with a Unix path'
    : false;

/** The environment of ssh -G in each test: of the test process, only its PATH. */
const environment = { PATH, HOME: '/home/test' };

/** Writes `lines` to a config file of the test, for ssh -F. */
async function configFile(
  directory: string,
  lines: readonly string[],
): Promise<string> {
  const file = join(directory, 'ssh_config');
  await writeFile(file, [...lines, ''].join('\n'));
  return file;
}

test(
  'a non-zero exit of ssh -G rejects with its standard error as the message and a cause with its exit code',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host box',
      '  NoSuchOption yes',
    ]);

    // Act
    const resolving = OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment,
    });

    // Assert
    await assert.rejects(resolving, (error) => {
      assert.ok(Error.isError(error));
      assert.equal(
        error.message,
        `${file}: line 2: Bad configuration option: nosuchoption\r\n${file}: terminating, 1 bad configuration options`,
      );
      assert.ok(Error.isError(error.cause) && 'code' in error.cause);
      assert.equal(error.cause.code, 255);
      return true;
    });
  },
);

test(
  'a warning on the standard error of ssh -G with exit 0 is ignored',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host box',
      '  HostName box.internal',
      '  RSAAuthentication yes',
    ]);

    // Act
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment,
    });

    // Assert
    assert.equal(config.hostname, 'box.internal');
  },
);

/**
 * A command for Match exec, run by Node: it reports the pid of its shell to
 * the report port.
 *
 *   node report.mjs <pid> <report port>
 */
const reportScript = `
import { connect } from 'node:net';
const [pid, port] = process.argv.slice(2);
connect(Number(port), '127.0.0.1').end(pid + '\\n');
`;

test(
  'an abort of the signal while ssh -G runs rejects with its reason',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using reports = await startReports();
    const script = join(directory.path, 'report.mjs');
    await writeFile(script, reportScript);
    const file = await configFile(directory.path, [
      `Match exec "${process.execPath} ${script} $$ ${reports.port}; exec sleep 30"`,
    ]);
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    const resolving = OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment,
      signal: controller.signal,
    });
    await Promise.race([
      reports.pid(t.signal),
      resolving.then(() => {
        throw new Error('resolve ended before Match exec ran');
      }),
    ]);

    // Act
    controller.abort(reason);

    // Assert
    await assert.rejects(resolving, (error) => error === reason);
  },
);

test(
  'a loop of first jump hosts that comes back rejects with jumphost loop',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host a',
      '  ProxyJump b',
      'Host b',
      '  ProxyJump a',
    ]);

    // Act
    const resolving = OpenSshConfig.resolve('a', {
      flags: ['-F', file],
      environment,
    });

    // Assert
    await assert.rejects(resolving, (error) => {
      assert.ok(Error.isError(error));
      assert.equal(error.message, 'jumphost loop via b');
      assert.equal(error.cause, undefined);
      return true;
    });
  },
);

test(
  'a jump host with the host, port and user of its destination rejects as ssh -G rejects it',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, ['Host h', '  ProxyJump h']);

    // Act
    const resolving = OpenSshConfig.resolve('h', {
      flags: ['-F', file],
      environment,
    });

    // Assert
    await assert.rejects(resolving, (error) => {
      assert.ok(Error.isError(error));
      assert.equal(error.message, 'jumphost loop via h');
      assert.ok(Error.isError(error.cause) && 'code' in error.cause);
      assert.equal(error.cause.code, 255);
      return true;
    });
  },
);

test(
  'a non-zero exit of the ssh -G of a jump host rejects with its standard error',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host dest',
      '  ProxyJump j',
      'Host j',
      '  ForwardAgent /no/such/agent.sock',
      '  ExitOnForwardFailure yes',
    ]);

    // Act
    const resolving = OpenSshConfig.resolve('dest', {
      flags: ['-F', file],
      environment,
    });

    // Assert
    await assert.rejects(resolving, (error) => {
      assert.ok(Error.isError(error));
      assert.match(
        error.message,
        /^Cannot forward agent socket path "\/no\/such\/agent\.sock": No such file or directory$/m,
      );
      assert.ok(Error.isError(error.cause) && 'code' in error.cause);
      assert.equal(error.cause.code, 255);
      return true;
    });
  },
);

test(
  'the hostname, the port and the user come from the config, and the flags win over it',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host box',
      '  HostName box.internal',
      '  Port 2222',
      '  User deploy',
    ]);
    const resolve = async (destination: string, flags: string[] = []) => {
      const config = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file, ...flags],
        environment,
      });
      const { hostname, port, user } = config;
      return { destination: config.destination, hostname, port, user };
    };

    // Act
    const resolved = await Promise.all([
      resolve('box'),
      resolve('box', ['-p', '2200', '-l', 'root']),
      resolve('box', ['-o', 'Port=2201', '-o', 'User=admin']),
      resolve('alice@box'),
      resolve('ssh://bob@box:2202'),
    ]);

    // Assert
    assert.deepEqual(resolved, [
      {
        destination: 'box',
        hostname: 'box.internal',
        port: 2222,
        user: 'deploy',
      },
      {
        destination: 'box',
        hostname: 'box.internal',
        port: 2200,
        user: 'root',
      },
      {
        destination: 'box',
        hostname: 'box.internal',
        port: 2201,
        user: 'admin',
      },
      {
        destination: 'alice@box',
        hostname: 'box.internal',
        port: 2222,
        user: 'alice',
      },
      {
        destination: 'ssh://bob@box:2202',
        hostname: 'box.internal',
        port: 2202,
        user: 'bob',
      },
    ]);
  },
);

test(
  'the host key alias and the known hosts files come from the config, with ~ of a global file from HOME of the environment',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host box',
      '  HostKeyAlias box-alias',
      '  UserKnownHostsFile /keys/user1 /keys/user2',
      '  GlobalKnownHostsFile ~/global1 /keys/global2',
      'Host nofiles',
      '  UserKnownHostsFile none',
      '  GlobalKnownHostsFile none',
    ]);
    const resolve = async (destination: string) => {
      const config = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file],
        environment,
      });
      return {
        hostKeyAlias: config.hostKeyAlias,
        knownHostsFiles: config.knownHostsFiles,
      };
    };

    // Act
    const [box, nofiles, plain] = await Promise.all([
      resolve('box'),
      resolve('nofiles'),
      resolve('plain'),
    ]);

    // Assert
    assert.deepEqual(box, {
      hostKeyAlias: 'box-alias',
      knownHostsFiles: {
        user: ['/keys/user1', '/keys/user2'],
        global: ['/home/test/global1', '/keys/global2'],
      },
    });
    assert.deepEqual(nofiles, {
      hostKeyAlias: undefined,
      knownHostsFiles: { user: [], global: [] },
    });
    assert.equal(plain.hostKeyAlias, undefined);
  },
);

test(
  'StrictHostKeyChecking gives its config name for each value that ssh -G prints, and HashKnownHosts its flag',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const values = ['yes', 'no', 'off', 'ask', 'accept-new'];
    const file = await configFile(directory.path, [
      ...values.flatMap((value) => [
        `Host ${value}`,
        `  StrictHostKeyChecking ${value}`,
      ]),
      'Host hashed',
      '  HashKnownHosts yes',
    ]);
    const resolve = async (destination: string) => {
      const config = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file],
        environment,
      });
      return [config.strictHostKeyChecking, config.hashKnownHosts];
    };

    // Act
    const resolved = await Promise.all(
      [...values, 'unset', 'hashed'].map(resolve),
    );

    // Assert
    assert.deepEqual(resolved, [
      ['yes', false],
      ['no', false],
      ['no', false],
      ['ask', false],
      ['accept-new', false],
      ['ask', false],
      ['ask', true],
    ]);
  },
);

test(
  'the host key algorithms drop the names that ssh2 does not have, in the order of the config',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host box',
      '  HostKeyAlgorithms ssh-ed25519-cert-v01@openssh.com,rsa-sha2-256,sk-ssh-ed25519@openssh.com,ssh-ed25519',
    ]);

    // Act
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment,
    });

    // Assert
    assert.deepEqual(config.hostKeyAlgorithms, ['rsa-sha2-256', 'ssh-ed25519']);
  },
);

test(
  'IdentityAgent gives SSH_AUTH_SOCK of the environment when absent or named, nothing for none, a path, or a $NAME of the environment, and ssh -G expands only the variables of the environment',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host named',
      '  IdentityAgent SSH_AUTH_SOCK',
      'Host none',
      '  IdentityAgent none',
      'Host path',
      '  IdentityAgent /run/other.sock',
      'Host variable',
      '  IdentityAgent $OTHER_AGENT',
      'Host expanded',
      '  IdentityAgent ${HOME}/agent.sock',
    ]);
    const withAgent = {
      ...environment,
      SSH_AUTH_SOCK: '/run/agent.sock',
      OTHER_AGENT: '/run/third.sock',
    };
    const resolve = async (
      destination: string,
      env: Record<string, string> = withAgent,
    ) =>
      (
        await OpenSshConfig.resolve(destination, {
          flags: ['-F', file],
          environment: env,
        })
      ).identityAgent;

    // Act
    const resolved = await Promise.all([
      resolve('absent'),
      resolve('named'),
      resolve('none'),
      resolve('path'),
      resolve('variable'),
      resolve('expanded'),
      resolve('absent', environment),
    ]);
    // HOME of the test process is set; ssh -G must not see it.
    const withoutHome = OpenSshConfig.resolve('expanded', {
      flags: ['-F', file],
      environment: { PATH },
    });

    // Assert
    assert.deepEqual(resolved, [
      '/run/agent.sock',
      '/run/agent.sock',
      undefined,
      '/run/other.sock',
      '/run/third.sock',
      '/home/test/agent.sock',
      undefined,
    ]);
    await assert.rejects(withoutHome, /env var \$\{HOME\} has no value/);
  },
);

test(
  'the identity files keep their order with ~ expanded from HOME of the environment, kept without HOME, and IdentitiesOnly gives its flag',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host box',
      '  IdentityFile ~/.ssh/id_box',
      '  IdentityFile /keys/id_other',
      '  IdentitiesOnly yes',
      'Host plain',
      '  IdentityFile /keys/id_plain',
    ]);
    const resolve = async (
      destination: string,
      env: Record<string, string> = environment,
    ) => {
      const config = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file],
        environment: env,
      });
      return [config.identityFiles, config.identitiesOnly];
    };

    // Act
    const resolved = await Promise.all([
      resolve('box'),
      resolve('plain'),
      resolve('box', { PATH }),
    ]);

    // Assert
    assert.deepEqual(resolved, [
      [['/home/test/.ssh/id_box', '/keys/id_other'], true],
      [['/keys/id_plain'], false],
      [['~/.ssh/id_box', '/keys/id_other'], true],
    ]);
  },
);

test(
  'the route is direct, or the ProxyCommand with its tokens, and none of ProxyCommand or ProxyJump is direct',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host command',
      '  ProxyCommand nc %h %p',
      'Host nocommand',
      '  ProxyCommand none',
      'Host nojump',
      '  ProxyJump none',
    ]);
    const resolve = async (destination: string) =>
      (
        await OpenSshConfig.resolve(destination, {
          flags: ['-F', file],
          environment,
        })
      ).route;

    // Act
    const resolved = await Promise.all(
      ['plain', 'command', 'nocommand', 'nojump'].map(resolve),
    );

    // Assert
    assert.deepEqual(resolved, [
      { kind: 'direct' },
      { kind: 'proxy-command', command: 'nc %h %p' },
      { kind: 'direct' },
      { kind: 'direct' },
    ]);
  },
);

test(
  'each jump host is resolved by its own ssh -G with -l and -p of the value and the -F of the caller, and only the first keeps its route',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host dest',
      '  HostName dest.internal',
      '  ProxyJump alice@j1:2200,j2,bob@j3',
      'Host j1',
      '  HostName j1.internal',
      '  HostKeyAlias j1-alias',
      '  IdentityAgent ${HOME}/j1-agent.sock',
      '  ProxyJump j0',
      'Host j0',
      '  HostName j0.internal',
      'Host j2',
      '  HostName j2.internal',
      '  User carol',
      '  ProxyCommand nc %h %p',
      'Host j3',
      '  HostName j3.internal',
      '  ProxyJump j0',
      'Host *',
      '  User zed',
      '  UserKnownHostsFile /keys/known_hosts',
      '  GlobalKnownHostsFile /keys/global',
      '  HostKeyAlgorithms ssh-ed25519',
      '  IdentityFile /keys/id',
    ]);
    const jumpHost = {
      hostKeyAlias: undefined,
      knownHostsFiles: {
        user: ['/keys/known_hosts'],
        global: ['/keys/global'],
      },
      strictHostKeyChecking: 'ask',
      hashKnownHosts: false,
      hostKeyAlgorithms: ['ssh-ed25519'],
      identityAgent: '/run/agent.sock',
      identityFiles: ['/keys/id'],
      identitiesOnly: false,
      connectTimeout: undefined,
      keepalive: undefined,
      addressFamily: undefined,
    };

    // Act
    const config = await OpenSshConfig.resolve('dest', {
      flags: ['-F', file, '-o', 'Port=2022', '-o', 'ConnectTimeout=5'],
      environment: { ...environment, SSH_AUTH_SOCK: '/run/agent.sock' },
    });

    // Assert
    assert.equal(config.port, 2022);
    assert.equal(config.connectTimeout, 5000);
    assert.deepEqual(config.route, {
      kind: 'jump',
      jumpHosts: [
        {
          ...jumpHost,
          destination: 'j1',
          hostname: 'j1.internal',
          port: 2200,
          user: 'alice',
          hostKeyAlias: 'j1-alias',
          identityAgent: '/home/test/j1-agent.sock',
          route: {
            kind: 'jump',
            jumpHosts: [
              {
                ...jumpHost,
                destination: 'j0',
                hostname: 'j0.internal',
                port: 22,
                user: 'zed',
                route: { kind: 'direct' },
              },
            ],
          },
        },
        {
          ...jumpHost,
          destination: 'j2',
          hostname: 'j2.internal',
          port: 22,
          user: 'carol',
        },
        {
          ...jumpHost,
          destination: 'j3',
          hostname: 'j3.internal',
          port: 22,
          user: 'bob',
        },
      ],
    });
  },
);

test(
  'a first jump host follows its own ProxyCommand, and a -J flag of the caller gives the jump hosts, as ssh:// and numeric forms too',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host dest',
      '  ProxyJump jp',
      'Host jp',
      '  ProxyCommand nc %h %p',
    ]);
    const resolve = async (destination: string, flags: string[] = []) => {
      const { route } = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file, ...flags],
        environment,
      });
      assert.equal(route.kind, 'jump');
      return route.jumpHosts.map((jumpHost) => ({
        destination: jumpHost.destination,
        port: jumpHost.port,
        user: jumpHost.user,
        route: 'route' in jumpHost ? jumpHost.route : 'none',
      }));
    };

    // Act
    const resolved = await Promise.all([
      resolve('dest'),
      resolve('plain', ['-J', 'ssh://carl@jx:2300,dot@10.0.0.2:2500']),
    ]);

    // Assert
    assert.deepEqual(resolved[0][0]?.route, {
      kind: 'proxy-command',
      command: 'nc %h %p',
    });
    assert.deepEqual(resolved[1], [
      {
        destination: 'jx',
        port: 2300,
        user: 'carl',
        route: { kind: 'direct' },
      },
      { destination: '10.0.0.2', port: 2500, user: 'dot', route: 'none' },
    ]);
  },
);

test(
  'ConnectTimeout and ServerAliveInterval give milliseconds only when the config sets them',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host both',
      '  ConnectTimeout 7',
      '  ServerAliveInterval 10',
      '  ServerAliveCountMax 2',
      'Host zero',
      '  ConnectTimeout 0',
      '  ServerAliveInterval 5',
    ]);
    const resolve = async (destination: string) => {
      const config = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file],
        environment,
      });
      return [config.connectTimeout, config.keepalive];
    };

    // Act
    const resolved = await Promise.all(['both', 'zero', 'plain'].map(resolve));

    // Assert
    assert.deepEqual(resolved, [
      [7000, { interval: 10_000, countMax: 2 }],
      [undefined, { interval: 5000, countMax: 3 }],
      [undefined, undefined],
    ]);
  },
);

test(
  'AddressFamily inet is 4, inet6 is 6, and any is undefined',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host inet',
      '  AddressFamily inet',
      'Host inet6',
      '  AddressFamily inet6',
    ]);
    const resolve = async (destination: string) =>
      (
        await OpenSshConfig.resolve(destination, {
          flags: ['-F', file],
          environment,
        })
      ).addressFamily;

    // Act
    const resolved = await Promise.all(['inet', 'inet6', 'any'].map(resolve));

    // Assert
    assert.deepEqual(resolved, [4, 6, undefined]);
  },
);

test(
  'SetEnv gives each variable with its value, and SendEnv its patterns',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host box',
      '  SetEnv FOO=bar BAZ="q x"',
      '  SendEnv LANG LC_*',
    ]);
    const resolve = async (destination: string) => {
      const config = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file],
        environment: { ...environment, LANG: 'C', LC_ALL: 'C' },
      });
      return [config.setEnv, config.sendEnv];
    };

    // Act
    const resolved = await Promise.all([resolve('box'), resolve('plain')]);

    // Assert
    assert.deepEqual(resolved, [
      [
        new Map([
          ['FOO', 'bar'],
          ['BAZ', 'q x'],
        ]),
        ['LANG', 'LC_*'],
      ],
      [new Map(), []],
    ]);
  },
);

test(
  'ForwardAgent no is off, yes is the agent, a path or a $NAME of the environment is a socket, and an unset $NAME is off',
  { skip: noSsh },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await configFile(directory.path, [
      'Host yes',
      '  ForwardAgent yes',
      'Host path',
      '  ForwardAgent /run/forwarded.sock',
      'Host variable',
      '  ForwardAgent $FORWARDED_AGENT',
      'Host unset',
      '  ForwardAgent $NO_SUCH_AGENT',
    ]);
    const resolve = async (destination: string) =>
      (
        await OpenSshConfig.resolve(destination, {
          flags: ['-F', file],
          environment: {
            ...environment,
            FORWARDED_AGENT: '/run/variable.sock',
          },
        })
      ).forwardAgent;

    // Act
    const resolved = await Promise.all(
      ['plain', 'yes', 'path', 'variable', 'unset'].map(resolve),
    );

    // Assert
    assert.deepEqual(resolved, [
      { kind: 'off' },
      { kind: 'agent' },
      { kind: 'socket', path: '/run/forwarded.sock' },
      { kind: 'socket', path: '/run/variable.sock' },
      { kind: 'off' },
    ]);
  },
);
