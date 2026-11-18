import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import {
  Client,
  type ClientConfig,
  ExitError,
  PrivateKey,
  ServerConn,
} from './index.ts';
import { type SshAgent, startSshAgent } from './testing/ssh-agent.ts';
import { startSshClientRig } from './testing/ssh-client.ts';
import { type Sshd, startSshd } from './testing/sshd.ts';

const noSshd =
  process.platform === 'win32'
    ? 'Windows has no sshd and no ssh-agent Unix socket'
    : false;

async function dial(
  sshd: Sshd,
  agentForwarding?: ClientConfig['agentForwarding'],
): Promise<Client> {
  const key = PrivateKey.parse(await readFile(sshd.userKey));
  return Client.dial(`127.0.0.1:${sshd.port}`, {
    user: userInfo().username,
    auth: [{ type: 'publickey', signers: async () => [key] }],
    hostKey: () => undefined,
    clock: createClock(),
    ...(agentForwarding && { agentForwarding }),
  });
}

async function agentWithKey(): Promise<{
  readonly agent: SshAgent;
  readonly fingerprint: string;
}> {
  const agent = await startSshAgent();
  const keyFile = await agent.generateKey('forwarded key');
  await agent.sshAdd([keyFile]);
  return { agent, fingerprint: await agent.fingerprint(keyFile) };
}

test(
  'with agentForwarding, ssh-add -l in a session on the server lists the keys of the agent of the client',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const { agent, fingerprint } = await agentWithKey();
    await using _agent = agent;
    await using client = await dial(sshd, async () => connect(agent.socket));

    // Act
    const listed = await client.newSession().output('ssh-add -l');

    // Assert
    assert.ok(String(listed).includes(`${fingerprint} forwarded key`));
  },
);

test(
  'with agentForwarding, a second session of the same client gets the agent too',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const { agent, fingerprint } = await agentWithKey();
    await using _agent = agent;
    await using client = await dial(sshd, async () => connect(agent.socket));
    await client.newSession().run('ssh-add -l');

    // Act
    const listed = await client.newSession().output('ssh-add -l');

    // Assert
    assert.ok(String(listed).includes(`${fingerprint} forwarded key`));
  },
);

test(
  'without agentForwarding, ssh-add -l in a session finds no agent and exits 2',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const { agent } = await agentWithKey();
    await using _agent = agent;
    await using client = await dial(sshd);

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
  'with agentForwarding, each session asks for agent forwarding before its other requests',
  { skip: noSshd },
  async () => {
    // Arrange
    const requested: string[][] = [];
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: () => true,
      });
      for await (const channel of conn.channels()) {
        if (channel.type !== 'session') {
          channel.reject();
          continue;
        }
        const session = channel.accept();
        const types: string[] = [];
        requested.push(types);
        for await (const request of session.requests()) {
          types.push(request.type);
          if (request.type === 'exec') {
            request.accept();
            await session.exit(0);
            break;
          }
          if ('accept' in request) request.accept();
        }
      }
    });
    await using client = await Client.dial(`127.0.0.1:${rig.port}`, {
      user: 'test',
      auth: [{ type: 'publickey', signers: async () => [rig.hostKey] }],
      hostKey: () => undefined,
      clock: createClock(),
      agentForwarding: () => Promise.reject(new Error('no agent is dialed')),
    });

    // Act
    await client.newSession().run('first');
    await client.newSession().run('second');

    // Assert
    assert.deepEqual(
      requested.map((types) => types[0]),
      ['auth-agent-req@openssh.com', 'auth-agent-req@openssh.com'],
    );
  },
);

test(
  'with agentForwarding, a session that sshd refuses to forward the agent to still runs its command',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd({ config: ['AllowAgentForwarding no'] });
    const { agent } = await agentWithKey();
    await using _agent = agent;
    await using client = await dial(sshd, async () => connect(agent.socket));

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
