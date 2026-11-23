import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { BackgroundService } from './index.ts';

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );

describe('The start', () => {
  test('the work runs before start returns', async () => {
    // Arrange
    let ran = false;

    // Act
    const service = BackgroundService.start(async () => {
      ran = true;
    });

    // Assert
    assert.equal(ran, true, 'The first step of the work must not wait');
    await service[Symbol.asyncDispose]();
  });

  test('a work that throws at once is a failure of the work, not a throw of start', async () => {
    // Arrange
    const failure = new Error('The store is gone');

    // Act
    const service = BackgroundService.start(() => {
      throw failure;
    });

    // Assert
    await assert.rejects(service.ended, (error) => error === failure);
    await assert.rejects(
      service[Symbol.asyncDispose](),
      (error) => error === failure,
    );
  });
});

describe('A failure of the work', () => {
  test('a failure before the stop rejects ended and the dispose with it', async () => {
    // Arrange
    const failure = new Error('The store is gone');
    const service = BackgroundService.start(async () => {
      await afterPendingReactions();
      throw failure;
    });

    // Act: the work fails while nobody stops it.
    const ended = service.ended;

    // Assert
    await assert.rejects(ended, (error) => error === failure);
    await assert.rejects(
      service[Symbol.asyncDispose](),
      (error) => error === failure,
    );
  });

  test('a failure after the stop, with another reason than the stop, rejects the dispose and ended', async () => {
    // Arrange
    const failure = new Error('The last flush failed');
    const service = BackgroundService.start(async (signal) => {
      await aborted(signal);
      throw failure;
    });

    // Act
    const disposed = service[Symbol.asyncDispose]();

    // Assert
    await assert.rejects(disposed, (error) => error === failure);
    await assert.rejects(service.ended, (error) => error === failure);
  });

  test('a failure that nobody reads leaves no unhandled rejection', async () => {
    // Arrange
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    const failure = new Error('The store is gone');
    try {
      // Act
      const service = BackgroundService.start(async () => {
        throw failure;
      });
      await afterPendingReactions();

      // Assert
      assert.deepEqual(unhandled, []);
      await assert.rejects(
        service[Symbol.asyncDispose](),
        (error) => error === failure,
      );
    } finally {
      process.off('unhandledRejection', record);
    }
  });
});

describe('The stop', () => {
  test('the dispose aborts the signal with an AbortError and waits for the last step of the work', async () => {
    // Arrange
    const steps: string[] = [];
    let reason: unknown;
    const service = BackgroundService.start(async (signal) => {
      await aborted(signal);
      reason = signal.reason;
      await afterPendingReactions();
      steps.push('flushed');
    });

    // Act
    await service[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(
      steps,
      ['flushed'],
      'The dispose must not resolve before the work ended',
    );
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, 'AbortError');
    await service.ended;
  });

  test('a work that rejects with the reason of the stop ends clean', async () => {
    // Arrange
    const service = BackgroundService.start(async (signal) => {
      await aborted(signal);
      throw signal.reason;
    });

    // Act
    await service[Symbol.asyncDispose]();

    // Assert
    await service.ended;
  });

  test('a work that ended before the stop resolves ended, and the dispose then resolves', async () => {
    // Arrange
    const service = BackgroundService.start(async () => {});

    // Act
    await service.ended;

    // Assert
    await service[Symbol.asyncDispose]();
  });

  test('a second dispose waits for the end of the work, and rejects with its failure', async () => {
    // Arrange
    const failure = new Error('The last flush failed');
    const flush = Promise.withResolvers<void>();
    const service = BackgroundService.start(async (signal) => {
      await aborted(signal);
      await flush.promise;
      throw failure;
    });
    const first = service[Symbol.asyncDispose]();
    let secondSettled = false;
    const second = assert.rejects(
      service[Symbol.asyncDispose]().finally(() => {
        secondSettled = true;
      }),
      (error) => error === failure,
    );
    await afterPendingReactions();
    assert.equal(
      secondSettled,
      false,
      'A second dispose must not end before the work',
    );

    // Act
    flush.resolve();

    // Assert
    await assert.rejects(first, (error) => error === failure);
    await second;
  });
});
