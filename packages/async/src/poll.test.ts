import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { poll } from './poll.ts';

const execFileAsync = promisify(execFile);

describe('poll', () => {
  test('a deadline that already passed still gets exactly one attempt, and the poll then resolves undefined without a wait', async () => {
    // Arrange
    const clock = createClock();
    let attempts = 0;
    const deadline = clock.performance.now();

    // Act
    const value = await poll(
      async () => {
        attempts++;
        return undefined;
      },
      { interval: 1_000, signal: undefined, clock, deadline },
    );

    // Assert
    assert.equal(value, undefined);
    assert.equal(
      attempts,
      1,
      'A campaign with a timeout of 0 must try the claim once',
    );
    assert.equal(
      clock.countTimers(),
      0,
      'The poll must not wait after the last attempt',
    );
  });

  test('an attempt that gives a value after the deadline passed still resolves the poll with that value', async () => {
    // Arrange
    const clock = createClock();
    const deadline = clock.performance.now() - 1;

    // Act
    const value = await poll(async () => 'held', {
      interval: 1_000,
      signal: undefined,
      clock,
      deadline,
    });

    // Assert
    assert.equal(
      value,
      'held',
      'A campaign with a timeout of 0 that wins its one try must get its term',
    );
  });

  test('an error from an attempt rejects the poll with that same error, and no attempt follows', async (t) => {
    // Arrange
    const clock = createClock();
    const failure = new Error('disk full');
    let attempts = 0;

    // Act
    const polling = poll(
      async () => {
        attempts++;
        throw failure;
      },
      { interval: 5, signal: undefined, clock },
    );

    // Assert
    const rejected = assert.rejects(polling, (error) => error === failure);
    await t.waitFor(() => assert.equal(attempts, 1));
    assert.equal(
      clock.countTimers(),
      0,
      'A failed attempt must not be followed by a wait for the next one',
    );
    await rejected;
    assert.equal(attempts, 1, 'A failed attempt must not be tried again');
  });

  test('an abort during the wait rejects the poll with the reason of the signal, stops the timer, and no attempt follows', async (t) => {
    // Arrange
    const clock = createClock();
    const controller = new AbortController();
    const reason = new Error('the caller left');
    let attempts = 0;
    const polling = poll(
      async () => {
        attempts++;
        return undefined;
      },
      { interval: 60_000, signal: controller.signal, clock },
    );
    const rejected = assert.rejects(polling, (error) => error === reason);
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));

    // Act
    controller.abort(reason);

    // Assert
    await rejected;
    assert.equal(clock.countTimers(), 0, 'The abort must stop the timer');
    await clock.tickAsync(60_000);
    assert.equal(attempts, 1);
  });

  test('a signal that aborted before the call rejects the poll with its reason after the first attempt, and leaves no timer', async () => {
    // Arrange
    const clock = createClock();
    const reason = new Error('the caller left');
    let attempts = 0;

    // Act
    const polling = poll(
      async () => {
        attempts++;
        return undefined;
      },
      { interval: 60_000, signal: AbortSignal.abort(reason), clock },
    );

    // Assert
    await assert.rejects(polling, (error) => error === reason);
    assert.equal(attempts, 1);
    assert.equal(clock.countTimers(), 0);
  });

  test('a process that cancels a poll during its wait ends at once, because the timer of the wait stops', async () => {
    // Arrange
    const program = `
        import { poll } from ${JSON.stringify(import.meta.resolve('./poll.ts'))};
        const controller = new AbortController();
        const polling = poll(async () => undefined, {
          interval: 60_000,
          signal: controller.signal,
          clock: globalThis,
        });
        setImmediate(() => controller.abort(new Error('the caller left')));
        await polling.catch(() => {});
      `;

    // Act
    const run = execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { timeout: 5_000 },
    );

    // Assert
    await assert.doesNotReject(
      run,
      'The process must end when the poll is cancelled, not after the interval of 60 seconds',
    );
  });

  test('a process whose only pending work is a poll with ref false ends during the wait, before the poll resolves', async () => {
    // Arrange
    const program = `
        import { poll } from ${JSON.stringify(import.meta.resolve('./poll.ts'))};
        let attempts = 0;
        poll(async () => (++attempts === 3 ? 'found' : undefined), {
          interval: 1_000,
          signal: undefined,
          clock: globalThis,
          ref: false,
        }).then((value) => console.log(value));
      `;

    // Act
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { timeout: 5_000 },
    );

    // Assert
    assert.equal(
      stdout,
      '',
      'A wait with ref false must not keep the process alive until the poll resolves',
    );
  });

  test('a process whose poll leaves ref out stays alive until the poll resolves', async () => {
    // Arrange
    const program = `
        import { poll } from ${JSON.stringify(import.meta.resolve('./poll.ts'))};
        let attempts = 0;
        poll(async () => (++attempts === 3 ? 'found' : undefined), {
          interval: 20,
          signal: undefined,
          clock: globalThis,
        }).then((value) => console.log(value));
      `;

    // Act
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { timeout: 5_000 },
    );

    // Assert
    assert.equal(
      stdout,
      'found\n',
      'Without ref, the wait must keep the process alive until the poll resolves',
    );
  });

  test('the first attempt occurs at once, attempts that give nothing repeat after the interval, and the poll resolves with the first value that is not undefined', async (t) => {
    // Arrange
    const clock = createClock();
    const interval = 200;
    const times: number[] = [];
    const answers = [undefined, undefined, null];

    // Act
    const polling = poll(
      async () => {
        times.push(clock.now);
        return answers[times.length - 1];
      },
      { interval, signal: undefined, clock },
    );
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));
    assert.deepEqual(times, [0], 'The first attempt must come before any wait');
    let settled = false;
    void polling.then(() => {
      settled = true;
    });
    await clock.tickAsync(interval * 2);

    // Assert
    assert.deepEqual(
      times,
      [0, interval, interval * 2],
      'The first attempt comes at once, and each next attempt one interval after the one before it',
    );
    assert.equal(
      settled,
      true,
      'Only undefined means that an attempt gave nothing: null must end the poll',
    );
    assert.equal(await polling, null);
  });

  test('with a deadline, attempts that give nothing repeat until the deadline passes on the clock, and a jump of the wall clock does not move it', async () => {
    // Arrange
    const clock = createClock();
    const deadline = clock.performance.now() + 50;
    const times: number[] = [];

    // Act
    const polling = poll(
      async () => {
        times.push(clock.performance.now());
        return undefined;
      },
      { interval: 10, signal: undefined, clock, deadline },
    );
    await clock.tickAsync(20);
    clock.setSystemTime(clock.now + 3_600_000);
    await clock.tickAsync(30);

    // Assert
    assert.equal(await polling, undefined);
    assert.deepEqual(
      times,
      [0, 10, 20, 30, 40, 50],
      'The poll must try every interval until the first attempt at or after the deadline',
    );
    assert.equal(clock.countTimers(), 0);
  });
});
