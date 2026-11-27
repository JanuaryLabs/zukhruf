import { describe } from '@zukhruf/parameterized-test';

import { durableTokens } from '../../testing/contract/durable-tokens.ts';
import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { onDisk } from '../../testing/contract/on-disk.ts';
import { processes } from '../../testing/contract/processes.ts';
import { threads } from '../../testing/contract/threads.ts';
import {
  disk,
  sharing,
  subject,
  threadSharing,
} from '../../testing/subjects/socket.ts';

// Each test of the contract opens its own fixture, so the suites run at the
// same time: node:test runs the suites at the top level of a file one after
// another.
describe(subject.name, { concurrency: true }, () => {
  lockStore(subject);
  looksTakeNoToken(subject);
  durableTokens(subject);
  processes(subject, sharing);
  threads(subject, threadSharing);
  onDisk(subject, disk);
  // No passiveLooks: a look that finds no leader campaigns to lead, and a campaign makes the directory and writes the term.
});
