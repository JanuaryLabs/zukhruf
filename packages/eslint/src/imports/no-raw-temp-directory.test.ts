import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-raw-temp-directory.ts';

test('no-raw-temp-directory reports a temporary directory that node:fs makes', () => {
  typescriptRuleTester().run('no-raw-temp-directory', rule, {
    valid: [
      {
        code: `import { TemporaryFiles } from '@zukhruf/fs';\nawait using dir = await new TemporaryFiles().directory('x-');`,
      },
      // A function of the same name that node:fs does not give.
      { code: `const mkdtemp = (prefix) => prefix;\nmkdtemp('x-');` },
      { code: `import { mkdtemp } from 'memfs';\nawait mkdtemp('x-');` },
      { code: `import * as memfs from 'memfs';\nmemfs.mkdtempSync('x-');` },
      // Other functions of node:fs.
      {
        code: `import * as fs from 'node:fs';\nimport { mkdir } from 'node:fs/promises';\nfs.mkdirSync('a');\nawait mkdir('b');`,
      },
      // A reference that is not a call.
      {
        code: `import { mkdtemp } from 'node:fs/promises';\nexport { mkdtemp };`,
      },
    ],
    invalid: [
      `import { mkdtemp } from 'node:fs/promises';\nawait mkdtemp('x-');`,
      `import { mkdtemp } from 'fs/promises';\nawait mkdtemp('x-');`,
      `import { mkdtempSync } from 'node:fs';\nmkdtempSync('x-');`,
      `import { mkdtempSync as makeTemp } from 'fs';\nmakeTemp('x-');`,
      `import { mkdtempDisposable } from 'node:fs/promises';\nawait using d = await mkdtempDisposable('x-');`,
      `import { mkdtempDisposableSync } from 'node:fs';\nusing d = mkdtempDisposableSync('x-');`,
      `import * as fs from 'node:fs';\nfs.mkdtempSync('x-');`,
      `import fs from 'node:fs';\nfs['mkdtempDisposableSync']('x-');`,
      `import * as fsp from 'node:fs/promises';\nawait fsp.mkdtemp('x-');`,
      `import fs from 'fs';\nawait fs.promises.mkdtemp('x-');`,
      `import { promises } from 'node:fs';\nawait promises.mkdtemp('x-');`,
      `import { promises as fsp } from 'node:fs';\nawait fsp.mkdtempDisposable('x-');`,
    ].map((code) => ({ code, errors: [{ messageId: 'matched' }] })),
  });
});

test('no-raw-temp-directory reports a path with a unique name under the temporary directory', () => {
  typescriptRuleTester().run('no-raw-temp-directory', rule, {
    valid: [
      // A persistent folder: the next run finds it again.
      `import { mkdir } from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nawait mkdir(join(tmpdir(), 'mteb-report'), { recursive: true });`,
      // A parent that is not the temporary directory.
      `import { mkdirSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), \`run-\${Date.now()}\`));`,
      // A subfolder of a folder that TemporaryFiles made and removes.
      `import { TemporaryFiles } from '@zukhruf/fs';\nimport { mkdir } from 'node:fs/promises';\nimport { join } from 'node:path';\nawait using folder = await new TemporaryFiles().directory('x-');\nawait mkdir(join(folder.path, crypto.randomUUID()));`,
      // A tmpdir that node:os does not give.
      `import { join } from 'node:path';\nconst tmpdir = () => '/scratch';\njoin(tmpdir(), crypto.randomUUID());`,
      // A join that node:path does not give.
      `import { tmpdir } from 'node:os';\nconst join = (...parts) => parts[0];\njoin(tmpdir(), crypto.randomUUID());`,
    ],
    invalid: [
      // sdk-it packages/cli/src/lib/generators/typescript.ts:153 (#4515): a
      // generator, not mkdir, makes the folder.
      `import { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst path = join(tmpdir(), crypto.randomUUID());\nawait emitLocal(spec, { output: path });`,
      `import { randomUUID } from 'node:crypto';\nimport { mkdir } from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nawait mkdir(join(tmpdir(), 'sdk-it-type-test', randomUUID()), { recursive: true });`,
      `import { mkdir } from 'node:fs/promises';\nimport * as os from 'node:os';\nimport * as path from 'node:path';\nawait mkdir(path.join(os.tmpdir(), String(Date.now())));`,
      `import { mkdirSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nmkdirSync(join(tmpdir(), 'runner-' + process.pid));`,
      // sdk-it core/file-system.test.ts before 9335bc1 (#3752).
      `import { mkdir } from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nlet testDir;\ntestDir = join(tmpdir(), \`fs-test-\${Date.now()}\`);\nawait mkdir(testDir, { recursive: true });`,
      `import fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nfs.mkdirSync(path.resolve(os.tmpdir(), \`x-\${performance.now()}\`));`,
      `import { writeFile } from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nawait writeFile(join(tmpdir(), Math.random().toString(36).slice(2)), '');`,
      // The name through a const.
      `import { randomUUID } from 'node:crypto';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst id = randomUUID();\nawait writeFiles(join(tmpdir(), id), files);`,
      // A parent folder under the temporary directory, through a const.
      `import { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst root = join(tmpdir(), 'sdk-it');\nawait writeFiles(join(root, crypto.randomUUID()), files);`,
      // Only the join that adds the unique name.
      `import { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst dir = join(tmpdir(), crypto.randomUUID());\nawait writeFiles(join(dir, 'src'), files);\nawait writeFiles(join(join(dir, 'a'), 'b'), files);`,
    ].map((code) => ({ code, errors: [{ messageId: 'uniquePath' }] })),
  });
});
