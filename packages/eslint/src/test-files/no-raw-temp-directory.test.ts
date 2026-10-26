import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-raw-temp-directory.ts';

test('no-raw-temp-directory reports a temporary directory that node:fs makes', () => {
  typescriptRuleTester().run('no-raw-temp-directory', rule, {
    valid: [
      {
        code: `import { TemporaryFiles } from '@zukhruf/testing/fs';\nawait using dir = await new TemporaryFiles().directory('x-');`,
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
