# Recipe: Give each test its own temporary directory

**Use case.** A test writes files: a report, a config, a spec file that the code under test reads. When two tests share one directory, a file of one test changes the result of the other. When a test does not remove its directory, the files stay in `os.tmpdir()` after the run. Each test needs an empty directory of its own, and the test must remove it at the end, also when an assertion fails.

**What you need.** `TemporaryFiles` from `@zukhruf/fs`, and a test runner. The program uses `node:test`.

## The steps

1. In each test, acquire the temporary directory with `await using dir = await new TemporaryFiles().directory(prefix)`. Give a prefix that names the test file, for example `'report-'`.
2. Write the files of the test below `dir.path`.
3. Let the test end. At the end of the test's scope, `await using` disposes the handle, and disposal removes the directory and all that it holds.

## The program

This program has four tests. Each test acquires its own temporary directory. The tests show that a directory starts empty, that `path` is the real path, and that disposal removes the directory and its files.

```ts title="own-directory.test.ts"
import assert from 'node:assert/strict';
import { readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

test('a report is written to report.json', async () => {
  await using dir = await new TemporaryFiles().directory('report-');
  assert.deepEqual(await readdir(dir.path), []);

  await writeFile(join(dir.path, 'report.json'), '{"passed":3}');

  assert.deepEqual(await readdir(dir.path), ['report.json']);
});

test('a second test starts with an empty directory of its own', async () => {
  await using dir = await new TemporaryFiles().directory('report-');

  assert.deepEqual(await readdir(dir.path), []);
});

test('the path is the real path', async () => {
  await using dir = await new TemporaryFiles().directory('report-');

  assert.equal(await realpath(dir.path), dir.path);
});

test('disposal removes the directory and all that it holds', async () => {
  let path: string;
  {
    await using dir = await new TemporaryFiles().directory('report-');
    path = dir.path;
    await writeFile(join(path, 'report.json'), '{"passed":3}');
  }

  await assert.rejects(stat(path), { code: 'ENOENT' });
});
```

Run it with `node --conditions=@zukhruf/source --test own-directory.test.ts`.

Output on a Mac with Node 26.13 (the durations change from run to run):

```
✔ a report is written to report.json (6.071208ms)
✔ a second test starts with an empty directory of its own (7.859125ms)
✔ the path is the real path (5.243875ms)
✔ disposal removes the directory and all that it holds (4.526792ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 155.953584
```

## Why it works

Each call of `directory(prefix)` makes a new, empty directory with `mkdtemp`, so no two tests get the same directory. The second test does not see the `report.json` of the first test. The handle is `AsyncDisposable`. `await using` disposes it when the scope ends: when the test returns, and also when an assertion throws. The last test shows this with a block: after the block, `stat` of the path rejects with `ENOENT` (`src/temporary-files.test.ts`, "disposal removes the directory and all that it holds").

The acquisition resolves symbolic links, so `realpath` of `dir.path` gives `dir.path` again. On macOS, `os.tmpdir()` is below `/var`, a link to `/private/var`. git and a child process give the resolved path, so a test can compare their output with `dir.path` directly ([ADR 0006](../adr/0006-a-temporary-directory-retries-its-removal-and-gives-its-real-path.md)).

## Things to know

- **Acquire the directory in the test that uses it.** Then the test holds its own arrange step and its own teardown, and a test that fails still removes its directory.
- **Use `TemporaryFiles`, not `mkdtemp` of `node:fs`.** Node's `mkdtempDisposable` does not retry the removal, and it gives the path as you wrote it. On Windows, a process that still holds a file open stops the removal for a short time. Disposal of a temporary directory retries the removal for 1.8 s at most ([ADR 0006](../adr/0006-a-temporary-directory-retries-its-removal-and-gives-its-real-path.md)). Tests and production code make a temporary directory with `TemporaryFiles` ([root ADR 0006](../../../../docs/adr/0006-production-code-and-tests-make-a-temporary-directory-with-temporaryfiles-of-zukhruf-fs.md)).
- **Give a `parent` when the place matters**: `directory('socket-', { parent: '/tmp' })`. A Unix socket path has a limit of 104 bytes on macOS, and a file in the directory that imports a package of the repository needs a parent in the repository. See [Make a temporary directory](../../README.md#make-a-temporary-directory).
- **For a synchronous `Symbol.dispose`, use `directorySync(prefix)`.** Its handle is `Disposable`, so it goes with `using`.
- **When the last retry of the removal fails, disposal rejects with the error.** The test then fails with that error.
