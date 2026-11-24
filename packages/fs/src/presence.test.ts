import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { text } from 'node:stream/consumers';
import { describe, test } from 'node:test';

import { Presence } from './presence.ts';
import { TemporaryFiles } from './temporary-files.ts';

const importPresence = `import { Presence } from ${JSON.stringify(new URL('./presence.ts', import.meta.url).href)};`;

/**
 * Starts an owner in a new process that opens the presence at `path` and
 * stays until it is killed. Resolves once the owner says that it holds it.
 */
async function startOwner(path: string) {
  const owner = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        ${importPresence}
        const presence = Presence.tryOpen(${JSON.stringify(path)});
        if (!presence) throw new Error('The owner must get its presence');
        setInterval(() => presence, 1000);
        console.log('present');
      `,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(owner, 'exit');
  const [line] = await Promise.race([
    once(createInterface({ input: owner.stdout }), 'line'),
    exited.then(([code]) => {
      throw new Error(`The owner exited with ${code} before it was present`);
    }),
  ]);
  assert.equal(line, 'present');
  return {
    exited,
    kill: () => owner.kill('SIGKILL'),
  };
}

/**
 * Runs `expression` in a new process that imports `Presence`, and gives what
 * it printed. Only another process sees a lock that the kernel dropped.
 */
async function inAnotherProcess(expression: string): Promise<string> {
  const other = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `${importPresence} console.log(${expression});`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [output, [code]] = await Promise.all([
    text(other.stdout),
    once(other, 'close'),
  ]);
  assert.equal(code, 0, 'The other process must exit cleanly');
  return output.trimEnd();
}

/**
 * Opens a presence at each of `count` paths in `directory`, and ends each one
 * with its file kept: the file of an owner that stopped.
 */
function endedPresences(directory: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const path = join(directory, `${index}.presence`);
    const presence = Presence.tryOpen(path);
    assert.ok(presence, 'The owner must get its presence');
    presence[Symbol.dispose]();
    return path;
  });
}

/**
 * Starts `count` processes that check each of `paths` in turn, again and
 * again until it is missing, as a reader that waits for the file to go: for
 * at most 10 seconds. Resolves once each one checked the first path.
 * Disposing the result stops them.
 */
async function startCheckers(paths: string[], count: number) {
  const checkers = Array.from({ length: count }, () =>
    spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          ${importPresence}
          const paths = ${JSON.stringify(paths)};
          const end = Date.now() + 10_000;
          Presence.check(paths[0]);
          console.log('checking');
          for (const path of paths) {
            while (Date.now() < end && Presence.check(path) !== 'missing');
          }
        `,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  );
  const exited = checkers.map((checker) => once(checker, 'exit'));
  const stop = {
    async [Symbol.asyncDispose]() {
      for (const checker of checkers) checker.kill('SIGKILL');
      await Promise.all(exited);
    },
  };
  try {
    await Promise.all(
      checkers.map(async (checker) => {
        const [line] = await once(
          createInterface({ input: checker.stdout }),
          'line',
        );
        assert.equal(line, 'checking');
      }),
    );
  } catch (error) {
    await stop[Symbol.asyncDispose]();
    throw error;
  }
  return stop;
}

/**
 * Starts a process that calls `removeIfEnded` on each of `paths` once it
 * reads a line, and prints the results. `answer` gives its next line.
 */
function startDeleter(paths: string[]) {
  const deleter = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { once } from 'node:events';
        ${importPresence}
        console.log('ready');
        await once(process.stdin, 'data');
        const results = [];
        for (const path of ${JSON.stringify(paths)}) {
          results.push(await Presence.removeIfEnded(path, { clock: globalThis }));
        }
        console.log(JSON.stringify(results));
        process.exit(0);
      `,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: deleter.stdout })[
    Symbol.asyncIterator
  ]();
  return {
    go: () => deleter.stdin.write('go\n'),
    async answer(): Promise<string> {
      const { value } = await lines.next();
      if (typeof value !== 'string') {
        throw new Error('The deleter exited before it answered');
      }
      return value;
    },
    kill: () => deleter.kill('SIGKILL'),
  };
}

/** Starts two deleters of `paths`, lets both start at once, and gives the results of each. */
async function removeInTwoProcesses(
  paths: string[],
): Promise<[string[], string[]]> {
  const deleters = [startDeleter(paths), startDeleter(paths)] as const;
  try {
    for (const deleter of deleters) {
      assert.equal(await deleter.answer(), 'ready');
    }
    for (const deleter of deleters) deleter.go();
    const [first, second] = await Promise.all([
      deleters[0].answer(),
      deleters[1].answer(),
    ]);
    return [JSON.parse(first), JSON.parse(second)];
  } finally {
    for (const deleter of deleters) deleter.kill();
  }
}

describe('Presence', () => {
  test('a check tells an owner that runs from one that was killed and from a file that is missing, and creates no file', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const path = join(directory.path, 'owner.presence');
    const absent = join(directory.path, 'absent.presence');
    const owner = await startOwner(path);
    try {
      // Act
      const whileOwnerRuns = Presence.check(path);
      owner.kill();
      await owner.exited;
      const afterOwnerWasKilled = Presence.check(path);
      const ofAbsent = Presence.check(absent);

      // Assert
      assert.equal(whileOwnerRuns, 'present');
      assert.equal(afterOwnerWasKilled, 'ended');
      assert.equal(ofAbsent, 'missing');
      assert.deepEqual(
        await readdir(directory.path),
        ['owner.presence'],
        'A check must not create the file that it checks',
      );
    } finally {
      owner.kill();
    }
  });

  test('an open of a presence that another process holds returns undefined, and the open of an ended one gets it and keeps the same file', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const path = join(directory.path, 'owner.presence');
    const owner = await startOwner(path);
    try {
      // Act
      const whileOwnerRuns = Presence.tryOpen(path);
      owner.kill();
      await owner.exited;
      using afterOwnerWasKilled = Presence.tryOpen(path);

      // Assert
      assert.equal(
        whileOwnerRuns,
        undefined,
        'A presence that another process holds must not open',
      );
      assert.ok(
        afterOwnerWasKilled,
        'The presence of a killed owner must open with no clean-up',
      );
      assert.equal(afterOwnerWasKilled.path, path);
      assert.equal(
        await inAnotherProcess(`Presence.check(${JSON.stringify(path)})`),
        'present',
      );
    } finally {
      owner.kill();
    }
  });

  test('removeIfEnded removes the file of an ended presence that other processes check in a loop', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const paths = endedPresences(directory.path, 50);
    await using checkers = await startCheckers(paths, 3);

    // Act
    const results = [];
    for (const path of paths) {
      results.push(await Presence.removeIfEnded(path, { clock: globalThis }));
    }

    // Assert
    assert.deepEqual(
      results,
      paths.map(() => 'removed'),
      'A check holds the lock for a moment; the deleter must wait it out',
    );
    assert.deepEqual(await readdir(directory.path), []);
  });

  test('removeIfEnded keeps the file of an owner that runs', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const path = join(directory.path, 'owner.presence');
    const owner = await startOwner(path);
    try {
      // Act
      const result = await Presence.removeIfEnded(path, { clock: globalThis });

      // Assert
      assert.equal(result, 'present');
      assert.deepEqual(await readdir(directory.path), ['owner.presence']);
      assert.equal(Presence.check(path), 'present');
    } finally {
      owner.kill();
    }
  });

  test('removeIfEnded of a path with no file resolves missing and creates no file', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const path = join(directory.path, 'absent.presence');

    // Act
    const result = await Presence.removeIfEnded(path, { clock: globalThis });

    // Assert
    assert.equal(result, 'missing');
    assert.deepEqual(await readdir(directory.path), []);
  });

  test('two processes that remove the same ended presences at once remove each file one time and leave no file', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const paths = endedPresences(directory.path, 20);

    // Act
    const [first, second] = await removeInTwoProcesses(paths);

    // Assert
    for (const [index, path] of paths.entries()) {
      const results = [first[index], second[index]].sort();
      assert.equal(
        results.filter((result) => result === 'removed').length,
        1,
        `${path}: ${results.join(', ')}. A deleter that creates the file again removes it a second time`,
      );
    }
    assert.deepEqual(await readdir(directory.path), []);
  });

  test('remove ends the presence and deletes its file, and a disposal after it does nothing', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const path = join(directory.path, 'owner.presence');
    const presence = Presence.tryOpen(path);
    assert.ok(presence, 'The owner must get its presence');

    // Act
    await presence.remove({ clock: globalThis });
    const disposing = () => presence[Symbol.dispose]();

    // Assert
    assert.doesNotThrow(disposing);
    assert.deepEqual(await readdir(directory.path), []);
    assert.equal(
      await inAnotherProcess(`Presence.check(${JSON.stringify(path)})`),
      'missing',
    );
  });

  test('a disposal ends the presence for other processes and keeps its file, and a second disposal does nothing', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const path = join(directory.path, 'owner.presence');
    const presence = Presence.tryOpen(path);
    assert.ok(presence, 'The owner must get its presence');
    const whileOpen = await inAnotherProcess(
      `Presence.check(${JSON.stringify(path)})`,
    );

    // Act
    presence[Symbol.dispose]();
    const disposingAgain = () => presence[Symbol.dispose]();

    // Assert
    assert.equal(whileOpen, 'present');
    assert.doesNotThrow(disposingAgain);
    assert.equal(
      await inAnotherProcess(`Presence.check(${JSON.stringify(path)})`),
      'ended',
    );
    assert.deepEqual(await readdir(directory.path), ['owner.presence']);
  });

  test("a check and an open in the owner's own process see the presence, and other processes still see it after them", async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('zukhruf-fs-');
    const path = join(directory.path, 'owner.presence');
    using presence = Presence.tryOpen(path);
    assert.ok(presence, 'The owner must get its presence');

    // Act
    const checked = Presence.check(path);
    const opened = Presence.tryOpen(path);

    // Assert
    assert.equal(checked, 'present');
    assert.equal(
      opened,
      undefined,
      "A deleter in the owner's process must not get a presence that runs",
    );
    assert.equal(
      await inAnotherProcess(`Presence.check(${JSON.stringify(path)})`),
      'present',
      'A check or an open in the owner process dropped the kernel lock',
    );
  });
});
