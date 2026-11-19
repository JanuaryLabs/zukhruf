import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-node-env.ts';

const errors = [{ messageId: 'nodeEnv' }];

test('no-node-env reports each form of reading NODE_ENV', () => {
  typescriptRuleTester().run('no-node-env', rule, {
    valid: [],
    invalid: [
      { code: `if (process.env.NODE_ENV === 'development') run();`, errors },
      { code: `const mode = process.env['NODE_ENV'];`, errors },
      { code: 'const mode = process.env[`NODE_ENV`];', errors },
      { code: `const mode = process.env?.NODE_ENV;`, errors },
      { code: `const mode = process['env'].NODE_ENV;`, errors },
      { code: `const mode = import.meta.env.NODE_ENV;`, errors },
      { code: `const { NODE_ENV } = process.env;`, errors },
      { code: `const { NODE_ENV: mode, PORT } = process.env;`, errors },
      { code: `const { ['NODE_ENV']: mode } = process.env;`, errors },
      { code: `const { NODE_ENV } = import.meta.env;`, errors },
      { code: `let mode; ({ NODE_ENV: mode } = process.env);`, errors },
      {
        // Assigning when unset reads the current value first.
        code: `process.env.NODE_ENV ??= 'production';`,
        errors,
      },
    ],
  });
});

test('no-node-env follows a variable bound to the environment object', () => {
  typescriptRuleTester().run('no-node-env', rule, {
    valid: [
      {
        // A local `env` that is not the environment object.
        code: `const env = { NODE_ENV: 'x' }; const mode = env.NODE_ENV;`,
      },
      {
        code: `function f(env) { return env.NODE_ENV; }`,
      },
    ],
    invalid: [
      { code: `const env = process.env; const mode = env.NODE_ENV;`, errors },
      {
        code: `const env = process.env; const { NODE_ENV } = env;`,
        errors,
      },
      { code: `const { env } = process; if (env.NODE_ENV) run();`, errors },
      {
        code: `const { env: vars } = process; const mode = vars['NODE_ENV'];`,
        errors,
      },
      {
        code: `import { env } from 'node:process'; const mode = env.NODE_ENV;`,
        errors,
      },
      {
        code: `const vars = import.meta.env; const mode = vars.NODE_ENV;`,
        errors,
      },
      {
        code: `const env = process.env; function f() { return env.NODE_ENV; }`,
        errors,
      },
    ],
  });
});

test('no-node-env passes NODE_ENV that is not a read', () => {
  typescriptRuleTester().run('no-node-env', rule, {
    valid: [
      // A target or a script sets NODE_ENV for a tool.
      { code: `process.env.NODE_ENV = 'production';` },
      { code: `delete process.env.NODE_ENV;` },
      { code: `spawn('vite', { env: { ...process.env, NODE_ENV: 'test' } });` },
      // Generators write files as template strings.
      { code: `const file = 'process.env.NODE_ENV';` },
      {
        code: 'const file = `if (process.env.NODE_ENV === "development") {}`;',
      },
      {
        code: 'const file = `const { NODE_ENV } = process.env;\\n${body}`;',
      },
      { code: `// process.env.NODE_ENV decides nothing\nconst a = 1;` },
      { code: `/* const { NODE_ENV } = process.env; */ const a = 1;` },
      // Other variables and other objects.
      { code: `const level = process.env.LOG_LEVEL;` },
      { code: `const mode = config.env.NODE_ENV;` },
      { code: `const mode = options.NODE_ENV;` },
      { code: `const { NODE_ENV } = options;` },
    ],
    invalid: [],
  });
});
