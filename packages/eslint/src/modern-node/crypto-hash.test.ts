import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './crypto-hash.ts';

const oneShot = [{ messageId: 'oneShot' }];
const hashTaken = [{ messageId: 'hashTaken' }];

// RuleTester applies one pass. `eslint --fix` runs this loop until no fix is
// left, and a file with several chains needs more than one pass.
function fixAllPasses(code: string): string {
  return new Linter({ configType: 'flat' }).verifyAndFix(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { 'modern-node': { rules: { 'crypto-hash': rule } } },
        rules: { 'modern-node/crypto-hash': 'error' },
      },
    ],
    { filename: 'file.ts' },
  ).output;
}

function outputOfProgram(code: string): string {
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', code],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test('eslint --fix on three chains removes createHash from the import', () => {
  // Arrange
  const code = `import { createHash } from 'node:crypto';\nconst a = createHash('sha1').update(x).digest('hex');\nconst b = createHash('md5').update(y).digest('hex');\nconst c = createHash('sha256').update(z).digest('hex');`;

  // Act
  const fixed = fixAllPasses(code);

  // Assert
  assert.equal(
    fixed,
    `import { hash } from 'node:crypto';\nconst a = hash('sha1', x);\nconst b = hash('md5', y);\nconst c = hash('sha256', z);`,
  );
});

test('the fixed program prints what the original program prints', () => {
  // Arrange
  const code = [
    `import { createHash } from 'node:crypto';`,
    `const text = 'é€😀';`,
    `const bytes = Buffer.from('abc');`,
    `console.log(createHash('sha256').update(text).digest('hex'));`,
    `console.log(createHash('sha256').update(text, 'utf8').digest('hex'));`,
    `console.log(createHash('sha1').update(bytes).digest('base64url'));`,
    `console.log(createHash('md5').update(new Uint8Array([1, 2, 3])).digest('base64'));`,
    `console.log(createHash('sha256').update(text).digest('hex').slice(0, 40));`,
    `console.log(createHash('sha1').update(text).digest('latin1'));`,
    `const key = createHash('sha512').update(bytes).digest();`,
    `console.log(Buffer.isBuffer(key), key.toString('hex'));`,
  ].join('\n');

  // Act
  const fixed = fixAllPasses(code);

  // Assert
  assert.doesNotMatch(fixed, /createHash/u);
  assert.equal(outputOfProgram(fixed), outputOfProgram(code));
});

test('a digest with no encoding stays a Buffer, because hash() defaults to hex', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [],
    invalid: [
      {
        code: `import { createHash } from 'node:crypto';\nexport const key = createHash('sha256').update(data).digest();`,
        output: `import { hash } from 'node:crypto';\nexport const key = hash('sha256', data, 'buffer');`,
        errors: oneShot,
      },
    ],
  });
});

test('an encoding that is not a known literal is left alone, because undefined gives a Buffer from digest and hex from hash', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data).digest(encoding);`,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data).digest('');`,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data).digest('nonsense');`,
      },
    ],
    invalid: [],
  });
});

test('an input encoding other than UTF-8 is left alone, because hash() has none and would digest other bytes', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data, 'hex').digest('hex');`,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data, encoding).digest('hex');`,
      },
    ],
    invalid: [],
  });
});

test('const hash = createHash(...) is reported with no fix, because the fix would read hash before it exists', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [],
    invalid: [
      {
        code: `import { createHash } from 'node:crypto';\nconst hash = createHash('sha256').update(data).digest('hex');`,
        output: null,
        errors: hashTaken,
      },
    ],
  });
});

test('a hash that the chain or the import would meet blocks the fix, because the fix would call the wrong function', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [],
    invalid: [
      {
        code: `import { createHash } from 'node:crypto';\nimport { hash } from 'bcrypt';\ncreateHash('sha256').update(data).digest('hex');\nhash(data);`,
        output: null,
        errors: hashTaken,
      },
      {
        code: `import { createHash } from 'node:crypto';\nfunction show(hash) { return createHash('sha256').update(hash).digest('hex'); }`,
        output: null,
        errors: hashTaken,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data).digest('hex');\nhash();`,
        output: null,
        errors: hashTaken,
      },
      {
        code: `import { createHash, hash as digest } from 'node:crypto';\nfunction show(digest) { return createHash('sha256').update(digest).digest('hex'); }`,
        output: null,
        errors: hashTaken,
      },
    ],
  });
});

test('a hash in a different function does not block the fix, because that function keeps its own hash', () => {
  // Arrange
  const code = `import { createHash } from 'node:crypto';\nfunction show({ hash }) { return hash; }\nconst digest = createHash('sha256').update(data).digest('hex');`;

  // Act
  const fixed = fixAllPasses(code);

  // Assert
  assert.equal(
    fixed,
    `import { hash } from 'node:crypto';\nfunction show({ hash }) { return hash; }\nconst digest = hash('sha256', data);`,
  );
});

test('a comment inside the chain blocks the fix, because the fix would delete it', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [],
    invalid: [
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256')\n  // The key of the cache.\n  .update(data)\n  .digest('hex');`,
        output: null,
        errors: oneShot,
      },
      {
        code: `import * as crypto from 'node:crypto';\ncrypto.createHash('sha256')\n  // The key of the cache.\n  .update(data)\n  .digest('hex');`,
        output: null,
        errors: oneShot,
      },
    ],
  });
});

test('createHash stays for several updates, a stored Hash and an output length', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(a).update(b).digest('hex');`,
      },
      {
        code: `import { createHash } from 'node:crypto';\nconst digest = createHash('sha256');\nfor (const chunk of chunks) digest.update(chunk);\ndigest.digest('hex');`,
      },
      {
        code: `import { createHash } from 'node:crypto';\nconst stored = createHash('sha256');\nstored.update(data).digest('hex');`,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('shake128', { outputLength: 8 }).update(data).digest('hex');`,
      },
    ],
    invalid: [],
  });
});

test('a createHash that is not the one of node:crypto is left alone', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [
      {
        code: `import createHash from 'create-hash';\ncreateHash('sha256').update(data).digest('hex');`,
      },
      {
        code: `import { createHash } from 'hash-wasm';\ncreateHash('sha256').update(data).digest('hex');`,
      },
      {
        code: `function createHash(name) { return make(name); }\ncreateHash('sha256').update(data).digest('hex');`,
      },
      {
        code: `import { createHash } from 'node:crypto';\nexport function digest(createHash) { return createHash('sha256').update(data).digest('hex'); }`,
      },
      {
        code: `import * as other from 'other';\nother.createHash('sha256').update(data).digest('hex');`,
      },
      {
        code: `crypto.createHash('sha256').update(data).digest('hex');`,
      },
      {
        code: `import { createHmac } from 'node:crypto';\ncreateHmac('sha256', key).update(data).digest('hex');`,
      },
      {
        code: `import { createSign } from 'node:crypto';\ncreateSign('sha256').update(data).digest('hex');`,
      },
      {
        code: `import * as crypto from 'node:crypto';\ncrypto.createSign('sha256').update(data).digest('hex');`,
      },
    ],
    invalid: [],
  });
});

test('the import keeps createHash while another use remains, and adds hash', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [],
    invalid: [
      {
        code: `import { createHash } from 'node:crypto';\nconst digest = createHash('sha1').update(a).digest('hex');\nconst stream = createHash('sha1');`,
        output: `import { createHash, hash } from 'node:crypto';\nconst digest = hash('sha1', a);\nconst stream = createHash('sha1');`,
        errors: oneShot,
      },
    ],
  });
});

test('each form of the one-shot chain is reported and fixed', () => {
  typescriptRuleTester().run('crypto-hash', rule, {
    valid: [],
    invalid: [
      {
        code: `import { createHash } from 'node:crypto';\nconst diff = createHash('sha256')\n  .update(text)\n  .digest('hex')\n  .slice(0, 40);`,
        output: `import { hash } from 'node:crypto';\nconst diff = hash('sha256', text)\n  .slice(0, 40);`,
        errors: oneShot,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data).digest('base64url');`,
        output: `import { hash } from 'node:crypto';\nhash('sha256', data, 'base64url');`,
        errors: oneShot,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data, 'utf8').digest('hex');`,
        output: `import { hash } from 'node:crypto';\nhash('sha256', data);`,
        errors: oneShot,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data, 'utf-8').digest('hex');`,
        output: `import { hash } from 'node:crypto';\nhash('sha256', data);`,
        errors: oneShot,
      },
      {
        code: `import { createHash } from 'node:crypto';\ncreateHash('sha256').update(data, 'UTF-8').digest('hex');`,
        output: `import { hash } from 'node:crypto';\nhash('sha256', data);`,
        errors: oneShot,
      },
      {
        code: `import { createHash } from 'crypto';\ncreateHash('md5').update(data).digest('hex');`,
        output: `import { hash } from 'crypto';\nhash('md5', data);`,
        errors: oneShot,
      },
      {
        code: `import { createHash as make } from 'node:crypto';\nmake('sha1').update(data).digest('hex');`,
        output: `import { hash } from 'node:crypto';\nhash('sha1', data);`,
        errors: oneShot,
      },
      {
        code: `import * as crypto from 'node:crypto';\ncrypto.createHash('sha1').update(data).digest('hex');`,
        output: `import * as crypto from 'node:crypto';\ncrypto.hash('sha1', data);`,
        errors: oneShot,
      },
      {
        code: `import crypto from 'node:crypto';\ncrypto.createHash('sha1').update(data).digest('hex');`,
        output: `import crypto from 'node:crypto';\ncrypto.hash('sha1', data);`,
        errors: oneShot,
      },
      {
        code: `import { createHash, hash } from 'node:crypto';\ncreateHash('sha1').update(data).digest('hex');\nhash('md5', data);`,
        output: `import { hash } from 'node:crypto';\nhash('sha1', data);\nhash('md5', data);`,
        errors: oneShot,
      },
      {
        code: `import { hash, createHash } from 'node:crypto';\ncreateHash('sha1').update(data).digest('hex');\nhash('md5', data);`,
        output: `import { hash } from 'node:crypto';\nhash('sha1', data);\nhash('md5', data);`,
        errors: oneShot,
      },
      {
        code: `import { createHash } from 'node:crypto';\nimport { hash } from 'crypto';\ncreateHash('sha1').update(data).digest('hex');\nhash('md5', data);`,
        output: `\nimport { hash } from 'crypto';\nhash('sha1', data);\nhash('md5', data);`,
        errors: oneShot,
      },
      {
        code: `import { createHash, hash as digest } from 'node:crypto';\ncreateHash('sha1').update(data).digest('hex');\ndigest('md5', data);`,
        output: `import { hash as digest } from 'node:crypto';\ndigest('sha1', data);\ndigest('md5', data);`,
        errors: oneShot,
      },
    ],
  });
});
