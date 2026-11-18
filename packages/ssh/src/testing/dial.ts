import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';

import { createClock } from '@sinonjs/fake-timers';

import { Client, type ClientConfig, PrivateKey } from '../index.ts';
import type { Sshd } from './sshd.ts';

/** A client of the test's sshd, logged in with its user key and trusting its host key, on a fake clock. `config` adds the session settings that a test needs. */
export async function dial(
  sshd: Sshd,
  config: Pick<ClientConfig, 'sessionEnv' | 'agentForwarding'> = {},
): Promise<Client> {
  const key = PrivateKey.parse(await readFile(sshd.userKey));
  return Client.dial(`127.0.0.1:${sshd.port}`, {
    user: userInfo().username,
    auth: [{ type: 'publickey', signers: async () => [key] }],
    hostKey: () => undefined,
    clock: createClock(),
    ...config,
  });
}
