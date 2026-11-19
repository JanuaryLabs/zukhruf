// A process that holds one client of the package and nothing else that keeps
// it alive. Over IPC it reports `idle` once the client is set up, and at the
// command `unref` it calls client.unref() and reports `unrefed`. Its IPC
// channel is unref'd, so once nothing holds it, it reports `exiting` (Node's
// beforeExit) and exits.
//
//   node ref-owner.ts dial <sshd port> <user key path> [--keepalive <ms>]
//     [--connect-timeout <ms>] [--session] [--unref-then-ref]
//     [--session-after-unref]
//   node ref-owner.ts handshake <sshd port> <user key path> --keepalive <ms>
//     [--replies-after-unref <count>]
//   node ref-owner.ts config <ssh config file> <destination> <home>
//   node ref-owner.ts share <ssh config file> <destination> <home>
//   node ref-owner.ts master <sshd port> <user key path> <socket path>
//     [--unref-then-ref]
//
// dial: Client.dial. --session runs a command before `idle`; --unref-then-ref
// calls client.unref() and client.ref() before `idle`; --session-after-unref
// runs a command after client.unref(), with its IPC channel ref'd until the
// command ends, before `unrefed`.
// handshake: Client.handshake on a stream with no ref() or unref() over a
// socket of its own; `idle` comes after the third chunk that the server sends
// after the handshake. With no session, the server sends only its host keys
// (hostkeys-00@openssh.com) and the replies to keepalives after it, so a
// keepalive reply has come. At `unref` it unrefs its socket too.
// --replies-after-unref keeps its IPC channel ref'd after client.unref() until
// that many more chunks came, the replies to keepalives that went out after
// unref(), before `unrefed`.
// config: OpenSshConfig#dial, with only PATH and `home` as HOME.
// share: OpenSshConfig#share, as config: it joins the master of ControlPath
// or becomes it; at `unref` it calls unref() of the shared connection.
// --hold-dial <port> opens a channel to 127.0.0.1:<port> before `idle` and
// keeps it open, idle, as an HTTP agent keeps a connection in its pool.
// master: Client.dial and client.unref(), then a ControlMaster on <socket
// path>, so only the master's listener keeps the process alive; at `unref` it
// calls master.unref() too. --unref-then-ref calls master.unref() and
// master.ref() before `idle`.
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';

import { OpenSshConfig, type SharedConnection } from '../config.ts';
import { ControlMaster } from '../control.ts';
import { Client, type ClientConfig, PrivateKey } from '../index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    keepalive: { type: 'string' },
    'connect-timeout': { type: 'string' },
    session: { type: 'boolean', default: false },
    'unref-then-ref': { type: 'boolean', default: false },
    'session-after-unref': { type: 'boolean', default: false },
    'replies-after-unref': { type: 'string' },
    'hold-dial': { type: 'string' },
  },
});
const [route, ...args] = positionals;

function send(message: string): void {
  if (process.send === undefined) throw new Error('ref-owner.ts needs IPC.');
  process.send(message);
}

async function directConfig(userKey: string): Promise<ClientConfig> {
  const key = PrivateKey.parse(await readFile(userKey));
  return {
    user: userInfo().username,
    auth: [{ type: 'publickey', signers: async () => [key] }],
    hostKey: () => undefined,
    clock: globalThis,
    ...(values.keepalive !== undefined && {
      keepalive: { interval: Number(values.keepalive), countMax: 3 },
    }),
    ...(values['connect-timeout'] !== undefined && {
      connectTimeout: Number(values['connect-timeout']),
    }),
  };
}

async function dial(port: string, userKey: string): Promise<Client> {
  const client = await Client.dial(
    `127.0.0.1:${port}`,
    await directConfig(userKey),
  );
  if (values.session) await client.newSession().run('true');
  if (values['unref-then-ref']) {
    client.unref();
    client.ref();
  }
  return client;
}

async function handshake(
  port: string,
  userKey: string,
): Promise<{
  client: Client;
  socket: { unref(): void };
  chunks: (count: number) => Promise<void>;
}> {
  const socket = connect(Number(port), '127.0.0.1');
  await once(socket, 'connect');
  const stream = new Duplex({
    read: () => socket.resume(),
    write: (chunk: Buffer, _encoding, callback) =>
      socket.write(chunk, () => callback()),
    final: (callback) => socket.end(() => callback()),
  });
  socket.on('data', (chunk: Buffer) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.once('end', () => stream.push(null));
  const client = await Client.handshake(
    stream,
    `127.0.0.1:${port}`,
    await directConfig(userKey),
  );
  const chunks = (count: number): Promise<void> => {
    const came = Promise.withResolvers<void>();
    let seen = 0;
    const onData = (): void => {
      seen += 1;
      if (seen < count) return;
      stream.off('data', onData);
      came.resolve();
    };
    stream.on('data', onData);
    return came.promise;
  };
  await chunks(3);
  return { client, socket, chunks };
}

async function resolveConfig(
  file: string,
  destination: string,
  home: string,
): Promise<OpenSshConfig> {
  return OpenSshConfig.resolve(destination, {
    flags: ['-F', file],
    environment: { PATH: '/usr/bin:/bin', HOME: home },
  });
}

async function shared(
  config: OpenSshConfig,
): Promise<{ client: SharedConnection; channel?: Duplex }> {
  const client = await config.share({ clock: globalThis });
  const port = values['hold-dial'];
  if (port === undefined) return { client };
  return { client, channel: await client.dial('tcp', `127.0.0.1:${port}`) };
}

async function served(
  port: string,
  userKey: string,
  path: string,
): Promise<{ client: Client; master: ControlMaster }> {
  const client = await Client.dial(
    `127.0.0.1:${port}`,
    await directConfig(userKey),
  );
  client.unref();
  const master = await ControlMaster.listen(client, path);
  if (values['unref-then-ref']) {
    master.unref();
    master.ref();
  }
  return { client, master };
}

async function start(): Promise<{
  client: Client | SharedConnection;
  socket?: { unref(): void };
  chunks?: (count: number) => Promise<void>;
  master?: ControlMaster;
}> {
  const [first, second, third] = args;
  if (first === undefined || second === undefined) {
    throw new Error('usage: see the head of ref-owner.ts');
  }
  switch (route) {
    case 'dial':
      return { client: await dial(first, second) };
    case 'handshake':
      return handshake(first, second);
    case 'config':
      if (third === undefined) throw new Error('config needs <home>');
      return {
        client: await (
          await resolveConfig(first, second, third)
        ).dial({ clock: globalThis }),
      };
    case 'share':
      if (third === undefined) throw new Error('share needs <home>');
      return shared(await resolveConfig(first, second, third));
    case 'master':
      if (third === undefined) throw new Error('master needs <socket path>');
      return served(first, second, third);
    default:
      throw new Error(`unknown route ${String(route)}`);
  }
}

const { client, socket, chunks, master } = await start();
async function unref(): Promise<void> {
  socket?.unref();
  client.unref();
  master?.unref();
  if (values['session-after-unref']) {
    process.channel?.ref();
    await client.newSession().run('true');
    process.channel?.unref();
  }
  const replies = values['replies-after-unref'];
  if (replies !== undefined) {
    if (chunks === undefined) throw new Error('only handshake counts replies');
    process.channel?.ref();
    await chunks(Number(replies));
    process.channel?.unref();
  }
  send('unrefed');
}

process.on('message', (command) => {
  if (command !== 'unref') {
    throw new Error(`unknown command ${String(command)}`);
  }
  void unref();
});
process.once('beforeExit', () => send('exiting'));
process.channel?.unref();
send('idle');
