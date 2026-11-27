import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import {
  DeprecatedRevisionError,
  DisposedError,
  JobCancelledError,
  JobFailedError,
  JobNotFoundError,
  PoolWarning,
} from './index.ts';

// A module that Node loads again under another URL is a second module record,
// with classes of its own: the second copy of the package that a host loads
// when it links another package which brings its own copy.
async function secondCopy<T>(file: string): Promise<T> {
  const copy: T = await import(new URL(`${file}?copy`, import.meta.url).href);
  return copy;
}

const errors = await secondCopy<typeof import('./errors.ts')>('./errors.ts');
const warnings =
  await secondCopy<typeof import('./pool-warning.ts')>('./pool-warning.ts');

void test.each(
  [
    {
      first: DeprecatedRevisionError,
      second: errors.DeprecatedRevisionError,
      error: new errors.DeprecatedRevisionError({
        kind: 'resize',
        revision: 1,
        newest: 2,
      }),
    },
    {
      first: DisposedError,
      second: errors.DisposedError,
      error: new errors.DisposedError(),
    },
    {
      first: JobCancelledError,
      second: errors.JobCancelledError,
      error: new errors.JobCancelledError('job-1'),
    },
    {
      first: JobFailedError,
      second: errors.JobFailedError,
      error: new errors.JobFailedError('job-1', {
        name: 'Error',
        message: 'boom',
      }),
    },
    {
      first: JobNotFoundError,
      second: errors.JobNotFoundError,
      error: new errors.JobNotFoundError('job-1'),
    },
    {
      first: PoolWarning,
      second: warnings.PoolWarning,
      error: new warnings.PoolWarning(new Error('boom'), {
        code: 'ZUKHRUF_POOL_QUEUE_ERROR',
        queue: 'resize',
      }),
    },
  ],
  ({ first, second, error }) =>
    test(`a ${first.name} that a second copy of the package throws is an instance of the ${first.name} of the first copy`, () => {
      assert.notEqual(second, first);
      assert.ok(error instanceof first);
    }),
);

const poolErrors = [
  new DeprecatedRevisionError({ kind: 'resize', revision: 1, newest: 2 }),
  new DisposedError(),
  new JobCancelledError('job-1'),
  new JobFailedError('job-1', { name: 'Error', message: 'boom' }),
  new JobNotFoundError('job-1'),
  new PoolWarning(new Error('boom'), {
    code: 'ZUKHRUF_POOL_QUEUE_ERROR',
    queue: 'resize',
  }),
];

void test.each(poolErrors, (error) =>
  test(`a plain Error with the name, the message and the fields of a ${error.name} is not an instance of it`, () => {
    const lookalike = Object.assign(new Error(error.message), { ...error });

    assert.equal(lookalike.name, error.name);
    assert.equal(lookalike instanceof error.constructor, false);
  }),
);

void test.each(poolErrors, (error) =>
  test(`a ${error.name} is an instance of no other error class of the pool`, () => {
    const others = poolErrors
      .map(({ constructor }) => constructor)
      .filter((errorClass) => errorClass !== error.constructor);

    assert.equal(others.length, poolErrors.length - 1);
    assert.deepEqual(
      others.filter((errorClass) => error instanceof errorClass),
      [],
    );
  }),
);

test('an error of a subclass of a pool error is an instance of both, and an error of the pool class is not an instance of the subclass', () => {
  class HostError extends DeprecatedRevisionError {}
  const options = { kind: 'resize', revision: 1, newest: 2 };

  const fromSubclass = new HostError(options);
  const fromPool = new DeprecatedRevisionError(options);

  assert.ok(fromSubclass instanceof HostError);
  assert.ok(fromSubclass instanceof DeprecatedRevisionError);
  assert.equal(fromPool instanceof HostError, false);
});

const thrownValues: readonly unknown[] = [undefined, null, 'DisposedError', 42];

void test.each(thrownValues, (thrown) =>
  test(`a thrown ${String(thrown)} is no instance of a pool error class, and the check does not throw`, () => {
    assert.equal(thrown instanceof DisposedError, false);
  }),
);
