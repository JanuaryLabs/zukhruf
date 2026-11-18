// The owner of a connection, as a process of its own: it holds, through the
// package, a session that runs a command and a channel dialed to a TCP port on
// the remote host, prints `ready`, and lives until it is killed.
//
//   node owner.ts <sshd port> <user key path> <dial address> <command>
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';

import { Client, PrivateKey } from '../index.ts';

const [port, userKey, address, command] = process.argv.slice(2);
if (
  port === undefined ||
  userKey === undefined ||
  address === undefined ||
  command === undefined
) {
  throw new Error(
    'usage: owner.ts <sshd port> <user key path> <dial address> <command>',
  );
}

const key = PrivateKey.parse(await readFile(userKey));
const client = await Client.dial(`127.0.0.1:${port}`, {
  user: userInfo().username,
  auth: [{ type: 'publickey', signers: async () => [key] }],
  hostKey: () => undefined,
  clock: globalThis,
});
const session = client.newSession();
await session.start(command);
const stream = await client.dial('tcp', address);
stream.resume();
process.stdout.write('ready\n');
