import { userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * The lines of a Host block of a test's ssh -F config that keep ssh -G to the
 * files of the test: its own known hosts in `directory`, the host key policy
 * `yes`, and no agent. Each is indented for the block.
 */
export function hermeticLines(directory: string): string[] {
  return [
    `  User ${userInfo().username}`,
    `  UserKnownHostsFile ${join(directory, 'known_hosts')}`,
    '  GlobalKnownHostsFile /dev/null',
    '  IdentityAgent none',
    '  StrictHostKeyChecking yes',
  ];
}
