import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/testing/fs';

const main = fileURLToPath(new URL('main.ts', import.meta.url));

// A helper of about 20 lines, the size that the check reports.
const helper = `
export function totals(rows: readonly { name: string; amount: number }[]) {
  const totalByName = new Map<string, number>();
  for (const row of rows) {
    const before = totalByName.get(row.name) ?? 0;
    totalByName.set(row.name, before + row.amount);
  }
  const names = [...totalByName.keys()].sort();
  const lines = names.map((name) => {
    const amount = totalByName.get(name) ?? 0;
    return name + ' has ' + amount.toFixed(2) + ' in total';
  });
  if (lines.length === 0) {
    throw new Error('The rows hold no name, so there is no total.');
  }
  return lines.join('; ');
}
`;

function check(workspace: string) {
  return spawnSync(process.execPath, ['--no-warnings', main], {
    cwd: workspace,
    encoding: 'utf8',
  });
}

async function write(workspace: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
}

test('a helper copied between two test files with no ledger line fails, and names both files', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  await write(workspace.path, {
    'packages/a/src/a.test.ts': helper,
    'packages/b/src/b.test.ts': helper,
  });

  // Act
  const { status, stderr } = check(workspace.path);

  // Assert
  assert.equal(status, 1);
  assert.match(stderr, /packages\/a\/src\/a\.test\.ts:\d+-\d+/);
  assert.match(stderr, /packages\/b\/src\/b\.test\.ts:\d+-\d+/);
});

test('a helper copied from a test file into src/testing with no ledger line fails', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  await write(workspace.path, {
    'packages/a/src/a.test.ts': helper,
    'packages/b/src/testing/totals.ts': helper,
  });

  // Act
  const { status, stderr } = check(workspace.path);

  // Assert
  assert.equal(status, 1);
  assert.match(stderr, /packages\/b\/src\/testing\/totals\.ts/);
});

for (const ledger of ['docs/copied-code.md', 'docs/copied-from-a.md']) {
  test(`one line of ${ledger} that names both files records the copy`, async () => {
    // Arrange
    await using workspace = await new TemporaryFiles().directory('copy-check-');
    await write(workspace.path, {
      'packages/a/src/a.test.ts': helper,
      'packages/b/src/b.test.ts': helper,
      [`packages/b/${ledger}`]:
        '- Places: `totals` in `src/b.test.ts` and in `packages/a/src/a.test.ts`.\n',
    });

    // Act
    const { status, stderr } = check(workspace.path);

    // Assert
    assert.equal(stderr, '');
    assert.equal(status, 0);
  });
}

test('a ledger that names the two files on two lines records nothing', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  await write(workspace.path, {
    'packages/a/src/a.test.ts': helper,
    'packages/b/src/b.test.ts': helper,
    'packages/b/docs/copied-code.md':
      '- Places: `one` in `src/b.test.ts` and in `src/c.test.ts`.\n- Places: `two` in `packages/a/src/a.test.ts` and in `src/d.test.ts`.\n',
  });

  // Act
  const { status } = check(workspace.path);

  // Assert
  assert.equal(status, 1);
});

test('a ledger line records a file by a whole path segment, so the end of another name does not count', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  await write(workspace.path, {
    'packages/a/src/data-a.test.ts': helper,
    'packages/b/src/data-b.test.ts': helper,
    'packages/b/docs/copied-code.md':
      '- Places: `totals` in `a.test.ts` and in `b.test.ts`.\n',
  });

  // Act
  const { status } = check(workspace.path);

  // Assert
  assert.equal(status, 1);
});

test('a block that repeats inside one test file is not a copy', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  await write(workspace.path, {
    'packages/a/src/a.test.ts': `${helper}\nexport const gap = 1;\n${helper}`,
  });

  // Act
  const { status, stderr } = check(workspace.path);

  // Assert
  assert.equal(stderr, '');
  assert.equal(status, 0);
});

test('a block smaller than a helper, such as the imports of each test file, is not a copy', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  const imports = `import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
`;
  await write(workspace.path, {
    'packages/a/src/a.test.ts': `${imports}\nexport const a = 1;\n`,
    'packages/b/src/b.test.ts': `${imports}${helper}`,
  });

  // Act
  const { status, stderr } = check(workspace.path);

  // Assert
  assert.equal(stderr, '');
  assert.equal(status, 0);
});

test('a copy between two shipped files is not reported', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  await write(workspace.path, {
    'packages/a/src/a.test.ts': helper,
    'packages/a/src/a.ts': helper,
    'packages/b/src/b.ts': helper,
  });

  // Act
  const { status, stderr } = check(workspace.path);

  // Assert
  assert.equal(stderr, '');
  assert.equal(status, 0);
});

test('a workspace with no test file fails, because a wrong glob would otherwise read as no copies', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('copy-check-');
  await write(workspace.path, { 'packages/a/src/a.ts': helper });

  // Act
  const { status } = check(workspace.path);

  // Assert
  assert.notEqual(status, 0);
});
