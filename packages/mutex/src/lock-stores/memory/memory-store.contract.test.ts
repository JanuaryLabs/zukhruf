import { describe } from '@zukhruf/parameterized-test';

import { looksTakeNoToken } from '../../testing/contract/holder-check.ts';
import { lockStore } from '../../testing/contract/lock-store.ts';
import { subject } from '../../testing/subjects/memory.ts';

// Each test of the contract opens its own fixture, so the suites run at the
// same time: node:test runs the suites at the top level of a file one after
// another.
describe(subject.name, { concurrency: true }, () => {
  lockStore(subject);
  looksTakeNoToken(subject);
});
