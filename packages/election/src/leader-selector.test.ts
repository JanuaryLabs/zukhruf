import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as afterPendingReactions } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { Backoff, type Clock, delay } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { describe, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

import {
  LeaderElection,
  LeaderSelector,
  LeaderSelectorWarning,
  LeaseLostError,
  SqliteElection,
} from './index.ts';

interface Script {
  /** What each try answers, in order: an epoch, `busy`, or an error. The last answer repeats. */
  tries?: Array<bigint | 'busy' | Error>;
  /** Runs inside each try, before it answers. */
  duringTry?: () => void;
  /** The attempt whose watch reports a loss before it returns. */
  lostAtOnce?: number;
  /** Aborting it reports a loss to the term that is watched then. */
  lose?: AbortSignal;
  /** Collects each watch's `lose`, so a test can call one late. */
  losers?: Array<(reason: Error) => void>;
  /** Thrown by each watch: the backend could not start to watch its claim. */
  watchFails?: Error;
  /** Thrown by each watch's disposer: the backend could not stop watching its claim. */
  unwatchFails?: Error;
  recordFails?: Error;
  /** Runs inside `release`, before it answers. */
  duringRelease?: () => Promise<void>;
  /** Runs inside `close`, before it answers. */
  duringClose?: () => Promise<void>;
  releaseFails?: Error;
  closeFails?: Error;
}

/**
 * A backend whose claim is the number of its attempt. It has no push, so it
 * polls in its own wait for a change, every `interval`. It records each step
 * it is asked for, so a test reads what the campaign and the term did.
 */
class ScriptedElection extends LeaderElection<number> {
  readonly steps: string[] = [];
  readonly #script: Script;
  readonly #interval: number;
  #attempts = 0;
  #tries = 0;

  constructor(clock: Clock, script: Script, interval = 1) {
    super('scripted', clock);
    this.#script = script;
    this.#interval = interval;
  }

  protected async open(): Promise<number> {
    this.#attempts += 1;
    this.steps.push(`open ${this.#attempts}`);
    return this.#attempts;
  }

  protected async tryClaim(
    claim: number,
  ): Promise<{ epoch: bigint; afterCleanShutdown: boolean } | undefined> {
    this.steps.push(`try ${claim}`);
    const answers = this.#script.tries ?? [1n];
    const answer = answers[Math.min(this.#tries, answers.length - 1)];
    this.#tries += 1;
    this.#script.duringTry?.();
    if (Error.isError(answer)) throw answer;
    if (answer === 'busy' || answer === undefined) return undefined;
    return { epoch: answer, afterCleanShutdown: false };
  }

  protected waitForChange(_claim: number, signal: AbortSignal): Promise<void> {
    return delay(this.#interval, { clock: this.clock, signal });
  }

  protected watch(claim: number, lose: (reason: Error) => void): Disposable {
    this.steps.push(`watch ${claim}`);
    if (this.#script.watchFails) throw this.#script.watchFails;
    this.#script.losers?.push(lose);
    const expire = () =>
      lose(new Error(`The lease of attempt ${claim} expired`));
    this.#script.lose?.addEventListener('abort', expire, { once: true });
    if (this.#script.lostAtOnce === claim) expire();
    return {
      [Symbol.dispose]: () => {
        this.#script.lose?.removeEventListener('abort', expire);
        this.steps.push(`unwatch ${claim}`);
        if (this.#script.unwatchFails) throw this.#script.unwatchFails;
      },
    };
  }

  protected async recordCleanShutdown(
    claim: number,
    epoch: bigint,
  ): Promise<void> {
    this.steps.push(`record ${claim} at ${epoch}`);
    if (this.#script.recordFails) throw this.#script.recordFails;
  }

  protected async release(claim: number): Promise<void> {
    this.steps.push(`release ${claim}`);
    await this.#script.duringRelease?.();
    if (this.#script.releaseFails) throw this.#script.releaseFails;
  }

  protected async close(claim: number): Promise<void> {
    this.steps.push(`close ${claim}`);
    await this.#script.duringClose?.();
    if (this.#script.closeFails) throw this.#script.closeFails;
  }
}

/** Waits 1 s, 2 s, 4 s and so on, with no jitter, so each count of failed campaigns has its own wait. */
const backoff = new Backoff({
  initial: 1000,
  multiplier: 2,
  max: 60_000,
  jitter: { kind: 'none' },
});

const both = [
  ['with autoRequeue', { autoRequeue: { backoff, clock: globalThis } }],
  ['without autoRequeue', {}],
] as const;

/** Holds the leadership until `signal` aborts, and then rejects with its reason, as a writer that runs until it is stopped. */
const untilStopped = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );

/** Whether `promise` settled within the pending reactions. */
const settledSoon = async (promise: Promise<unknown>) => {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 5; turn++) await afterPendingReactions();
  return settled;
};

/** The steps of `election` that give a won claim up or free an attempt. */
const endings = (election: ScriptedElection) =>
  election.steps.filter((step) => /^(release|close) /.test(step));

/** The number of campaigns that tried the claim of `election`. */
const tries = (election: ScriptedElection) =>
  election.steps.filter((step) => step.startsWith('try ')).length;

/** An election of the writer in `directory`. */
const writerElection = (directory: string) =>
  new SqliteElection({
    clock: globalThis,
    directory,
    claimFile: 'writer.lock',
    epochFile: 'writer.epoch',
  });

describe('A task that fails', () => {
  void test.each(both, ([name, options]) =>
    test(`${name}, it ends the selector after it resigned the term, and ended and the dispose reject with the failure`, async () => {
      // Arrange
      const election = new ScriptedElection(globalThis, {});
      const failure = new Error('The warehouse write failed');
      let rounds = 0;

      // Act
      const selector = LeaderSelector.start(
        election,
        {
          takeLeadership: async () => {
            rounds++;
            throw failure;
          },
        },
        options,
      );

      // Assert
      await assert.rejects(selector.ended, (error) => error === failure);
      assert.deepEqual(endings(election), ['release 1', 'close 1']);
      await assert.rejects(
        selector[Symbol.asyncDispose](),
        (error) => error === failure,
      );
      assert.equal(rounds, 1, 'A failed task must not run again');
    }),
  );

  test('a task that rejects with another error than the stop after the dispose is a failure', async (t) => {
    // Arrange
    const election = new ScriptedElection(globalThis, {});
    const failure = new Error('The last flush failed');
    const selector = LeaderSelector.start(election, {
      takeLeadership: async (_term, signal) => {
        await aborted(signal);
        throw failure;
      },
    });
    await waitFor(() => assert.equal(selector.hasLeadership, true), {
      signal: t.signal,
    });

    // Act
    const disposed = selector[Symbol.asyncDispose]();

    // Assert
    await assert.rejects(disposed, (error) => error === failure);
    await assert.rejects(selector.ended, (error) => error === failure);
    assert.deepEqual(endings(election), ['release 1', 'close 1']);
  });
});

describe('A resign that fails', () => {
  test('a resign that fails after the task resolved ends the selector with that failure, and the selector leads no more', async () => {
    // Arrange: the backend frees the claim, then reports that its release failed.
    const failure = new Error(
      'The backend lost its connection while it released the claim',
    );
    const election = new ScriptedElection(globalThis, {
      releaseFails: failure,
    });
    let rounds = 0;

    // Act
    const selector = LeaderSelector.start(election, {
      takeLeadership: async () => {
        rounds++;
      },
    });

    // Assert
    await assert.rejects(selector.ended, (error) => error === failure);
    assert.equal(rounds, 1);
    assert.equal(tries(election), 1);
    assert.throws(() => selector.requeue(), {
      message: 'This leader selector ended, so it leads no more.',
    });
  });
});

describe('The dispose', () => {
  void test.each(both, ([name, options]) =>
    test(`${name}, a dispose during the task aborts its signal, and waits until the task ended and the term was resigned`, async (t) => {
      // Arrange
      const election = new ScriptedElection(globalThis, {});
      const steps: string[] = [];
      const selector = LeaderSelector.start(
        election,
        {
          takeLeadership: async (_term, signal) => {
            await aborted(signal);
            await afterPendingReactions();
            steps.push('flushed');
          },
        },
        options,
      );
      await waitFor(() => assert.equal(selector.hasLeadership, true), {
        signal: t.signal,
      });

      // Act
      const first = selector[Symbol.asyncDispose]();
      const second = selector[Symbol.asyncDispose]();

      // Assert
      await second;
      assert.deepEqual(steps, ['flushed'], 'A second dispose waits too');
      assert.deepEqual(endings(election), ['release 1', 'close 1']);
      await first;
      assert.equal(selector.hasLeadership, false);
      await selector.ended;
      assert.equal(tries(election), 1, 'The dispose must not campaign again');
    }),
  );
});

describe('A task that resolves', () => {
  test('with autoRequeue, the term is resigned and the next round starts at once', async (t) => {
    // Arrange
    const clock = createClock();
    const election = new ScriptedElection(globalThis, { tries: [1n, 2n, 3n] });
    const epochs: bigint[] = [];

    // Act
    await using selector = LeaderSelector.start(
      election,
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          if (epochs.length === 3) await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );

    // Assert
    await waitFor(() => assert.deepEqual(epochs, [1n, 2n, 3n]), {
      signal: t.signal,
    });
    assert.deepEqual(endings(election), [
      'release 1',
      'close 1',
      'release 2',
      'close 2',
    ]);
    assert.equal(clock.countTimers(), 0, 'A resolved task waits no back-off');
  });
});

describe('Over a SQLite election', () => {
  test('with autoRequeue, the task gets the term, a resolved task resigns and campaigns again, and the dispose resigns', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const epochs: bigint[] = [];
    const selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          if (epochs.length === 2) await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock: globalThis } },
    );

    // Act
    await waitFor(() => assert.equal(epochs.length, 2), { signal: t.signal });
    assert.equal(selector.hasLeadership, true);
    await selector[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(epochs, [1n, 2n]);
    await selector.ended;
    await using next = await writerElection(directory.path).campaign();
    assert.equal(next?.epoch, 3n, 'The dispose must resign the term');
  });

  test('a task that fails resigns the term before the selector ends', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const failure = new Error('The warehouse write failed');

    // Act
    const selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async () => {
          throw failure;
        },
      },
      { autoRequeue: { backoff, clock: globalThis } },
    );

    // Assert
    await assert.rejects(selector.ended, (error) => error === failure);
    await using next = await writerElection(directory.path).campaign();
    assert.equal(next?.epoch, 2n, 'The failed task must resign its term');
    await assert.rejects(
      selector[Symbol.asyncDispose](),
      (error) => error === failure,
    );
  });
});

describe('A requeue', () => {
  test('without autoRequeue, the selector waits for requeue after a resolved task, and two requeues in a row queue one round', async (t) => {
    // Arrange
    const election = new ScriptedElection(globalThis, { tries: [1n, 2n] });
    let rounds = 0;
    await using selector = LeaderSelector.start(election, {
      takeLeadership: async () => {
        rounds++;
      },
    });
    await waitFor(
      () => assert.deepEqual(endings(election), ['release 1', 'close 1']),
      { signal: t.signal },
    );

    // Act: a requeue that returns false during the resign queues nothing, so the wait may call it again.
    await waitFor(() => assert.equal(selector.requeue(), true), {
      signal: t.signal,
    });
    const second = selector.requeue();

    // Assert
    assert.equal(second, false, 'A requeue right after a requeue');
    await waitFor(
      () =>
        assert.deepEqual(endings(election), [
          'release 1',
          'close 1',
          'release 2',
          'close 2',
        ]),
      { signal: t.signal },
    );
    assert.equal(await settledSoon(selector.ended), false);
    assert.equal(rounds, 2, 'Two requeues in a row must run one round');
    assert.equal(tries(election), 2);
  });

  test('a dispose while the selector waits for requeue ends it clean', async (t) => {
    // Arrange: without autoRequeue, the first task resolves.
    const election = new ScriptedElection(globalThis, {});
    let rounds = 0;
    const selector = LeaderSelector.start(election, {
      takeLeadership: async () => {
        rounds++;
      },
    });
    // Only requeue() tells the wait for requeue from the resign before it, and it queues a round. This backend resigns in microtasks, so one turn after its close the selector waits.
    await waitFor(
      () => assert.deepEqual(endings(election), ['release 1', 'close 1']),
      { signal: t.signal },
    );
    await afterPendingReactions();

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    await selector.ended;
    assert.equal(rounds, 1);
    assert.deepEqual(endings(election), ['release 1', 'close 1']);
  });

  test('requeue throws after the dispose', async () => {
    // Arrange
    const selector = LeaderSelector.start(
      new ScriptedElection(globalThis, {}),
      { takeLeadership: async () => {} },
    );

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    assert.throws(() => selector.requeue(), {
      message: 'This leader selector is disposed.',
    });
  });

  test('requeue throws after a failure ended the selector, which leads no more', async () => {
    // Arrange: a task that fails ends the selector, with no dispose.
    const failure = new Error('The warehouse refused the write');
    const selector = LeaderSelector.start(
      new ScriptedElection(globalThis, {}),
      {
        takeLeadership: async () => {
          throw failure;
        },
      },
    );
    await assert.rejects(selector.ended, (error) => error === failure);

    // Act
    const requeueing = () => selector.requeue();

    // Assert
    assert.throws(requeueing, {
      message: 'This leader selector ended, so it leads no more.',
    });
  });

  test('over a SQLite election, without autoRequeue, a resolved task resigns, and the selector waits for requeue', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const epochs: bigint[] = [];
    await using selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async (term) => {
          epochs.push(term.epoch);
        },
      },
    );
    await waitFor(() => assert.equal(epochs.length, 1), { signal: t.signal });

    // Act
    const other = await writerElection(directory.path).campaign({
      timeout: 10_000,
    });
    await other?.resign();

    // Assert: the other candidate can win while the selector still closes its attempt, when requeue() returns false and queues nothing.
    assert.equal(other?.epoch, 2n, 'The selector must resign its term');
    await waitFor(() => assert.equal(selector.requeue(), true), {
      signal: t.signal,
    });
    await waitFor(() => assert.deepEqual(epochs, [1n, 3n]), {
      signal: t.signal,
    });
  });
});

describe('A campaign that fails', () => {
  test('without autoRequeue, it ends the selector with the failure, and the task never runs', async () => {
    // Arrange
    const failure = new Error('The backend is down');
    const election = new ScriptedElection(globalThis, { tries: [failure] });
    let ran = false;

    // Act
    const selector = LeaderSelector.start(election, {
      takeLeadership: async () => {
        ran = true;
      },
    });

    // Assert
    await assert.rejects(selector.ended, (error) => error === failure);
    await assert.rejects(
      selector[Symbol.asyncDispose](),
      (error) => error === failure,
    );
    assert.equal(ran, false);
    assert.equal(tries(election), 1);
  });

  test('with autoRequeue, it warns and waits the back-off of the failed campaigns since the last term', async (t) => {
    // Arrange: two campaigns fail, one wins, and the next fails again.
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    const [first, second, third] = [1, 2, 3].map(
      (attempt) => new Error(`The backend is down (${attempt})`),
    );
    const election = new ScriptedElection(globalThis, {
      tries: [first!, second!, 1n, third!, 2n],
    });
    const epochs: bigint[] = [];
    await using selector = LeaderSelector.start(
      election,
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          if (epochs.length > 1) await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );
    const backsOff = async (campaigns: number, warnings: number) =>
      waitFor(
        () => {
          assert.equal(tries(election), campaigns);
          assert.equal(emitWarning.mock.callCount(), warnings);
          assert.equal(clock.countTimers(), 1);
        },
        { signal: t.signal },
      );

    // Act and assert: 1 s after the first failure.
    await backsOff(1, 1);
    await clock.tickAsync(999);
    assert.equal(tries(election), 1, 'No campaign before the back-off');
    await clock.tickAsync(1);

    // 2 s after the second failure in a row.
    await backsOff(2, 2);
    await clock.tickAsync(1999);
    assert.equal(tries(election), 2, 'No campaign before the back-off');
    await clock.tickAsync(1);

    // The won term restarts the count: 1 s after the next failure.
    await backsOff(4, 3);
    assert.deepEqual(epochs, [1n]);
    await clock.tickAsync(999);
    assert.equal(tries(election), 4, 'No campaign before the back-off');
    await clock.tickAsync(1);
    await waitFor(() => assert.deepEqual(epochs, [1n, 2n]), {
      signal: t.signal,
    });

    assert.deepEqual(
      emitWarning.mock.calls.map(({ arguments: [warning] }) =>
        Error.isError(warning)
          ? {
              ...warning,
              message: warning.message,
              cause: warning.cause,
              isClass: warning instanceof LeaderSelectorWarning,
            }
          : warning,
      ),
      [first, second, third].map((failure) => ({
        name: 'LeaderSelectorWarning',
        code: 'ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED',
        detail: 'election: scripted',
        message: `The campaign failed, and the selector campaigns again: ${failure!.message}`,
        cause: failure,
        isClass: true,
      })),
    );
  });

  test('a dispose during the back-off ends the selector at once', async (t) => {
    // Arrange
    t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    const election = new ScriptedElection(globalThis, {
      tries: [new Error('The backend is down'), 1n],
    });
    const selector = LeaderSelector.start(
      election,
      { takeLeadership: async () => {} },
      { autoRequeue: { backoff, clock } },
    );
    await waitFor(() => assert.equal(clock.countTimers(), 1), {
      signal: t.signal,
    });

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    await selector.ended;
    assert.equal(clock.countTimers(), 0, 'The back-off timer must stop');
    assert.equal(tries(election), 1);
  });

  test('over a SQLite election, without autoRequeue, a failed campaign ends the selector with the failure', async () => {
    // Arrange: the directory of the election is under a file, so it cannot be made.
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const file = join(directory.path, 'not-a-directory');
    await writeFile(file, '');
    let ran = false;

    // Act
    const selector = LeaderSelector.start(
      writerElection(join(file, 'writer')),
      {
        takeLeadership: async () => {
          ran = true;
        },
      },
    );

    // Assert
    const failure: unknown = await selector.ended.then(
      () => assert.fail('A failed campaign must end the selector'),
      (error: unknown) => error,
    );
    assert.ok(Error.isError(failure));
    await assert.rejects(
      selector[Symbol.asyncDispose](),
      (error) => error === failure,
    );
    assert.equal(ran, false);
  });

  test('over a SQLite election, with autoRequeue, a failed campaign warns with the name of the election, waits the back-off, and campaigns again', async (t) => {
    // Arrange
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const file = join(directory.path, 'not-a-directory');
    await writeFile(file, '');
    const epochs: bigint[] = [];
    await using selector = LeaderSelector.start(
      writerElection(join(file, 'writer')),
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );

    await waitFor(
      () => {
        assert.equal(emitWarning.mock.callCount(), 1);
        assert.equal(clock.countTimers(), 1);
      },
      { signal: t.signal },
    );
    const [warning] = emitWarning.mock.calls[0]!.arguments;
    assert.ok(warning instanceof LeaderSelectorWarning);
    assert.deepEqual(
      { ...warning },
      {
        name: 'LeaderSelectorWarning',
        code: 'ZUKHRUF_ELECTION_LEADER_SELECTOR_CAMPAIGN_FAILED',
        detail: `election: ${join(file, 'writer', 'writer.lock')}`,
      },
    );
    assert.ok(Error.isError(warning.cause));

    // Act: the directory can be made now, and the back-off runs to its end.
    await rm(file);
    await clock.tickAsync(999);
    assert.equal(clock.countTimers(), 1, 'No campaign before the back-off');
    assert.deepEqual(epochs, []);
    await clock.tickAsync(1);

    // Assert
    await waitFor(() => assert.deepEqual(epochs, [1n]), {
      signal: t.signal,
    });
  });
});

describe('A lost term', () => {
  test('with autoRequeue, the task signal aborts with the loss, the lost term is not given up, and the next round starts at once with the next term', async (t) => {
    // Arrange
    const clock = createClock();
    const loss = new AbortController();
    const election = new ScriptedElection(globalThis, {
      tries: [1n, 2n],
      lose: loss.signal,
    });
    const epochs: bigint[] = [];
    const signals: AbortSignal[] = [];
    await using selector = LeaderSelector.start(
      election,
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          signals.push(signal);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );
    await waitFor(() => assert.equal(epochs.length, 1), { signal: t.signal });

    // Act
    loss.abort();

    // Assert
    await waitFor(() => assert.deepEqual(epochs, [1n, 2n]), {
      signal: t.signal,
    });
    assert.ok(signals[0]!.reason instanceof LeaseLostError);
    assert.equal(clock.countTimers(), 0, 'A loss waits no back-off');
    assert.equal(signals[1]!.aborted, false);
    assert.deepEqual(endings(election), ['close 1']);
  });

  test('without autoRequeue, the selector waits for requeue, and requeue runs one round', async (t) => {
    // Arrange
    const loss = new AbortController();
    const election = new ScriptedElection(globalThis, {
      tries: [1n, 2n],
      lose: loss.signal,
    });
    let rounds = 0;
    await using selector = LeaderSelector.start(election, {
      takeLeadership: async (_term, signal) => {
        rounds++;
        await untilStopped(signal);
      },
    });
    await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });

    // Act
    loss.abort();
    await waitFor(() => assert.deepEqual(endings(election), ['close 1']), {
      signal: t.signal,
    });

    // Assert
    assert.equal(await settledSoon(selector.ended), false);
    assert.equal(rounds, 1);
    assert.equal(selector.hasLeadership, false);
    assert.equal(selector.requeue(), true);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
  });

  void test.each(
    ['rejects with another error', 'resolves'] as const,
    (ending) =>
      test(`a task that ${ending} after a loss has a loss, not a failure, so the selector leads again`, async (t) => {
        // Arrange
        const loss = new AbortController();
        const election = new ScriptedElection(globalThis, {
          tries: [1n, 2n],
          lose: loss.signal,
        });
        let rounds = 0;
        await using selector = LeaderSelector.start(
          election,
          {
            takeLeadership: async (_term, signal) => {
              rounds++;
              if (rounds > 1) return untilStopped(signal);
              await aborted(signal);
              if (ending === 'rejects with another error')
                throw new Error('The write after the loss failed');
            },
          },
          { autoRequeue: { backoff, clock: createClock() } },
        );
        await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });

        // Act
        loss.abort();

        // Assert
        await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
      }),
  );
});

describe('An interrupt', () => {
  test('with autoRequeue, it aborts the task signal, resigns the term, and the next round starts at once', async (t) => {
    // Arrange
    const clock = createClock();
    const election = new ScriptedElection(globalThis, { tries: [1n, 2n] });
    const signals: AbortSignal[] = [];
    await using selector = LeaderSelector.start(
      election,
      {
        takeLeadership: async (_term, signal) => {
          signals.push(signal);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );
    await waitFor(() => assert.equal(signals.length, 1), { signal: t.signal });

    // Act
    selector.interruptLeadership();

    // Assert
    await waitFor(() => assert.equal(signals.length, 2), {
      signal: t.signal,
    });
    assert.equal(signals[0]!.aborted, true);
    assert.equal(signals[1]!.aborted, false);
    assert.deepEqual(endings(election), ['release 1', 'close 1']);
    assert.equal(clock.countTimers(), 0, 'An interrupt waits no back-off');
  });

  test('without autoRequeue, it ends the round clean, and the selector waits for requeue', async (t) => {
    // Arrange
    const election = new ScriptedElection(globalThis, { tries: [1n, 2n] });
    let rounds = 0;
    await using selector = LeaderSelector.start(election, {
      takeLeadership: async (_term, signal) => {
        rounds++;
        await untilStopped(signal);
      },
    });
    await waitFor(() => assert.equal(selector.hasLeadership, true), {
      signal: t.signal,
    });

    // Act
    selector.interruptLeadership();
    await waitFor(
      () => assert.deepEqual(endings(election), ['release 1', 'close 1']),
      { signal: t.signal },
    );

    // Assert
    assert.equal(selector.hasLeadership, false);
    assert.equal(await settledSoon(selector.ended), false);
    assert.equal(rounds, 1);
    assert.equal(selector.requeue(), true);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
  });

  test('an interrupt while the selector campaigns behind another leader does nothing', async (t) => {
    // Arrange: another candidate leads until the test pushes a won try.
    const answers: Array<bigint | 'busy' | Error> = ['busy'];
    const election = new ScriptedElection(globalThis, { tries: answers });
    const signals: AbortSignal[] = [];
    await using selector = LeaderSelector.start(election, {
      takeLeadership: async (_term, signal) => {
        signals.push(signal);
        await untilStopped(signal);
      },
    });
    await waitFor(() => assert.ok(tries(election) > 1), { signal: t.signal });

    // Act
    selector.interruptLeadership();
    answers.push(1n);

    // Assert
    await waitFor(() => assert.equal(signals.length, 1), {
      signal: t.signal,
    });
    assert.equal(signals[0]!.aborted, false);
  });

  test('over a SQLite election, with autoRequeue, an interrupt resigns the term and campaigns again', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const epochs: bigint[] = [];
    await using selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock: globalThis } },
    );
    await waitFor(() => assert.equal(epochs.length, 1), { signal: t.signal });

    // Act
    selector.interruptLeadership();

    // Assert
    await waitFor(() => assert.deepEqual(epochs, [1n, 2n]), {
      signal: t.signal,
    });
  });
});

describe('A campaign behind another leader', () => {
  void test.each(both, ([name, options]) =>
    test(`${name}, a dispose stops the campaign, frees its attempt, and the selector never takes the claim`, async (t) => {
      // Arrange
      const election = new ScriptedElection(globalThis, { tries: ['busy'] });
      let ran = false;
      const selector = LeaderSelector.start(
        election,
        {
          takeLeadership: async () => {
            ran = true;
          },
        },
        options,
      );
      await waitFor(() => assert.ok(tries(election) > 1), {
        signal: t.signal,
      });

      // Act
      await selector[Symbol.asyncDispose]();

      // Assert
      await selector.ended;
      assert.equal(ran, false);
      assert.deepEqual(endings(election), ['close 1']);
      assert.ok(!election.steps.some((step) => step.startsWith('watch ')));
    }),
  );

  test('over a SQLite election, a dispose stops the campaign, and the leader keeps its term', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    await using leader = await writerElection(directory.path).campaign();
    let ran = false;
    const selector = LeaderSelector.start(writerElection(directory.path), {
      takeLeadership: async () => {
        ran = true;
      },
    });
    // No public fact shows that the campaign waits behind the leader; the scripted twin above shows the dispose of a waiting campaign.
    await afterPendingReactions();

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    await selector.ended;
    assert.equal(ran, false);
    assert.equal(leader?.signal.aborted, false);
  });
});

describe('The state of the selector', () => {
  test('hasLeadership is true only while the task runs', async (t) => {
    // Arrange: another candidate leads until the test pushes a won try.
    const answers: Array<bigint | 'busy' | Error> = ['busy'];
    const election = new ScriptedElection(globalThis, { tries: answers });
    const release = Promise.withResolvers<void>();
    let running = false;
    await using selector = LeaderSelector.start(election, {
      takeLeadership: async () => {
        running = true;
        await release.promise;
        running = false;
      },
    });

    // Act and assert
    await waitFor(() => assert.ok(tries(election) > 1), { signal: t.signal });
    assert.equal(selector.hasLeadership, false, 'While it campaigns');
    answers.push(1n);
    await waitFor(() => assert.equal(running, true), { signal: t.signal });
    assert.equal(selector.hasLeadership, true, 'While the task runs');
    release.resolve();
    await waitFor(() => assert.equal(running, false), { signal: t.signal });
    await afterPendingReactions();
    assert.equal(selector.hasLeadership, false, 'After the task returned');
  });

  test('requeue returns false while a round campaigns, while it runs, and during the back-off', async (t) => {
    // Arrange: another candidate leads until the test pushes a won try.
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    const answers: Array<bigint | 'busy' | Error> = ['busy'];
    const election = new ScriptedElection(globalThis, { tries: answers });
    let rounds = 0;
    await using selector = LeaderSelector.start(
      election,
      {
        takeLeadership: async (_term, signal) => {
          rounds++;
          if (rounds === 1) {
            await aborted(signal);
            return;
          }
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );

    // Act and assert
    await waitFor(() => assert.ok(tries(election) > 1), { signal: t.signal });
    assert.equal(selector.requeue(), false, 'While it campaigns');
    answers.push(1n);
    await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });
    assert.equal(selector.requeue(), false, 'While the task runs');
    answers.push(new Error('The backend is down'));
    selector.interruptLeadership();
    await waitFor(() => assert.equal(emitWarning.mock.callCount(), 1), {
      signal: t.signal,
    });
    assert.equal(selector.requeue(), false, 'During the back-off');
    answers.push(2n);
    await clock.tickAsync(1000);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
  });
});
