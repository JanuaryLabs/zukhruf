import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import {
  type AuthMethod,
  AuthenticationError,
  Client,
  type Prompt,
  type ServerConfig,
  ServerConn,
} from './index.ts';
import { type SshClientRig, startSshClientRig } from './testing/ssh-client.ts';

const noSsh =
  process.platform === 'win32'
    ? 'the rig makes its keys with ssh-keygen in /tmp'
    : false;

/** Our server on the port of a rig: each connection handshakes with `config` and the host key of the rig, and stays open until the client closes it. A handshake that fails ends its handler. */
async function startServer(
  config: Omit<ServerConfig, 'hostKeys'>,
): Promise<SshClientRig> {
  const rig = await startSshClientRig(async (socket) => {
    const conn = await ServerConn.handshake(socket, {
      ...config,
      hostKeys: [rig.hostKey],
    }).catch((error: unknown) => {
      // A client that fails to log in closes the connection.
      if (
        Error.isError(error) &&
        error.message === 'ssh: the client closed the connection'
      ) {
        return undefined;
      }
      throw error;
    });
    if (conn === undefined) return;
    await using _conn = conn;
    for await (const channel of conn.channels()) channel.reject();
  });
  return rig;
}

function dial(rig: SshClientRig, auth: readonly AuthMethod[]): Promise<Client> {
  return Client.dial(`127.0.0.1:${rig.port}`, {
    user: 'test',
    auth,
    hostKey: () => {},
    clock: createClock(),
  });
}

/** The error that `dialed` rejects with. A client that logged in instead is closed, so that the rig does not wait for it, and the result is 'logged in'. */
function refusalOf(dialed: Promise<Client>): Promise<unknown> {
  return dialed.then(
    async (client) => {
      await client.close();
      return 'logged in';
    },
    (error: unknown) => error,
  );
}

test(
  'keyboard-interactive: respond that rejects fails the dial with its error',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startServer({
      keyboardInteractive: async (_user, ask) => {
        await ask([{ prompt: 'Code: ', echo: false }]);
        return true;
      },
    });
    const refusal = new Error('no code at hand');

    // Act
    const refused = await refusalOf(
      dial(rig, [
        {
          type: 'keyboard-interactive',
          respond: () => Promise.reject(refusal),
        },
      ]),
    );

    // Assert
    assert.equal(refused, refusal);
  },
);

for (const answers of [['424242'], ['ezz', '424242', 'extra']]) {
  test(
    `keyboard-interactive: ${answers.length} answers to 2 prompts fail the dial, and the server gets none of them`,
    { skip: noSsh },
    async () => {
      // Arrange
      const received: (readonly string[])[] = [];
      await using rig = await startServer({
        keyboardInteractive: async (_user, ask) => {
          received.push(
            await ask([
              { prompt: 'User: ', echo: true },
              { prompt: 'Code: ', echo: false },
            ]),
          );
          return true;
        },
      });

      // Act
      const refused = await refusalOf(
        dial(rig, [
          { type: 'keyboard-interactive', respond: async () => answers },
        ]),
      );

      // Assert
      assert.ok(Error.isError(refused), String(refused));
      assert.equal(
        refused.message,
        `ssh: incorrect number of answers from keyboard-interactive callback ${answers.length} (expected 2)`,
      );
      assert.deepEqual(received, []);
    },
  );
}

test(
  'a method that the server does not list is skipped, and a refused password rejects the dial with AuthenticationError, which lists the methods tried and the methods of the server',
  { skip: noSsh },
  async () => {
    // Arrange
    const passwords: string[] = [];
    await using rig = await startServer({
      password: (_user, password) => {
        passwords.push(password);
        return false;
      },
    });
    const responded: (readonly Prompt[])[] = [];

    // Act
    const refused = await refusalOf(
      dial(rig, [
        {
          type: 'keyboard-interactive',
          respond: async (prompts) => {
            responded.push(prompts);
            return [];
          },
        },
        { type: 'password', password: 'wrong' },
      ]),
    );

    // Assert
    assert.ok(refused instanceof AuthenticationError, String(refused));
    assert.deepEqual(refused.attempted, ['none', 'password']);
    assert.deepEqual(refused.allowed, ['password']);
    assert.deepEqual(passwords, ['wrong']);
    assert.deepEqual(responded, []);
  },
);

test(
  'the methods go in the order of the config, not of the server: a refused keyboard-interactive goes on to password, which logs in',
  { skip: noSsh },
  async () => {
    // Arrange
    const tried: string[] = [];
    await using rig = await startServer({
      password: (_user, password) => {
        tried.push('password');
        return password === 'open';
      },
      keyboardInteractive: async (_user, ask) => {
        tried.push('keyboard-interactive');
        await ask([{ prompt: 'Code: ', echo: false }]);
        return false;
      },
    });

    // Act
    await using _client = await dial(rig, [
      { type: 'keyboard-interactive', respond: async () => ['000000'] },
      { type: 'password', password: 'open' },
    ]);

    // Assert
    assert.deepEqual(tried, ['keyboard-interactive', 'password']);
  },
);

test(
  'password: the password callback of the server gets the user and the password, and logs in',
  { skip: noSsh },
  async () => {
    // Arrange
    const logins: [string, string][] = [];
    await using rig = await startServer({
      password: (user, password) => {
        logins.push([user, password]);
        return true;
      },
    });

    // Act
    await using _client = await dial(rig, [
      { type: 'password', password: 'open sesame' },
    ]);

    // Assert
    assert.deepEqual(logins, [['test', 'open sesame']]);
  },
);

test(
  'keyboard-interactive: respond gets the prompts of the server with their echo, and its answers reach the server, which logs in',
  { skip: noSsh },
  async () => {
    // Arrange
    const received: (readonly string[])[] = [];
    await using rig = await startServer({
      keyboardInteractive: async (_user, ask) => {
        const answers = await ask([
          { prompt: 'User: ', echo: true },
          { prompt: 'Code: ', echo: false },
        ]);
        received.push(answers);
        return answers[1] === '424242';
      },
    });
    const responded: (readonly Prompt[])[] = [];

    // Act
    await using _client = await dial(rig, [
      {
        type: 'keyboard-interactive',
        respond: async (prompts) => {
          responded.push(prompts);
          return ['ezz', '424242'];
        },
      },
    ]);

    // Assert
    assert.deepEqual(responded, [
      [
        { prompt: 'User: ', echo: true },
        { prompt: 'Code: ', echo: false },
      ],
    ]);
    assert.deepEqual(received, [['ezz', '424242']]);
  },
);

test(
  'keyboard-interactive: respond answers each round of the server, and a round with zero prompts gets zero answers without respond',
  { skip: noSsh },
  async () => {
    // Arrange
    const received: (readonly string[])[] = [];
    await using rig = await startServer({
      keyboardInteractive: async (_user, ask) => {
        received.push(await ask([{ prompt: 'User: ', echo: true }]));
        received.push(await ask([]));
        received.push(await ask([{ prompt: 'Code: ', echo: false }]));
        return received.at(-1)?.[0] === '424242';
      },
    });
    const responded: string[][] = [];

    // Act
    await using _client = await dial(rig, [
      {
        type: 'keyboard-interactive',
        respond: async (prompts) => {
          responded.push(prompts.map(({ prompt }) => prompt));
          return prompts.map(({ prompt }) =>
            prompt === 'User: ' ? 'ezz' : '424242',
          );
        },
      },
    ]);

    // Assert
    assert.deepEqual(responded, [['User: '], ['Code: ']]);
    assert.deepEqual(received, [['ezz'], [], ['424242']]);
  },
);
