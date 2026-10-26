import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-process-env-write.ts';

test('no-process-env-write', () => {
  typescriptRuleTester().run('no-process-env-write', rule, {
    valid: [
      { code: `const url = process.env.DATABASE_URL;` },
      { code: `const value = process.env['DATABASE_URL'] ?? 'x';` },
      // A child process gets a copy of its own.
      {
        code: `spawn('node', ['x.ts'], { env: { ...process.env, DEBUG: '1' } });`,
      },
      { code: `const env = Object.assign({}, process.env, { DEBUG: '1' });` },
      { code: `options.env.DEBUG = '1';` },
      { code: `t.mock.method(api, 'fetch');` },
    ],
    invalid: [
      `process.env.DEBUG = '1';`,
      `process.env['DEBUG'] = '1';`,
      `process.env[key] = value;`,
      `process.env.PATH += ':/bin';`,
      `process.env.DEBUG ??= '1';`,
      `delete process.env.DEBUG;`,
      `delete process.env[key];`,
      `Object.assign(process.env, { DEBUG: '1' });`,
      `Object.defineProperty(process.env, 'DEBUG', { value: '1' });`,
      `process.env = { DEBUG: '1' };`,
      `vi.stubEnv('DEBUG', '1');`,
    ].map((code) => ({ code, errors: [{ messageId: 'matched' }] })),
  });
});
