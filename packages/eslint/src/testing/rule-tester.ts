import { RuleTester } from 'eslint';
import * as jsonc from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';

/**
 * RuleTester calls a global `describe`/`it` when one exists; node:test defines
 * none, so `ruleTester.run()` runs every case synchronously and throws on the
 * first failure. Call it inside a node:test `test()`.
 */
export function typescriptRuleTester(): RuleTester {
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });
}

/**
 * A tester for rules that read types. Each case names a `filename` under
 * `root`; the project service checks it with `root`'s tsconfig.json, so the
 * file does not have to exist.
 */
export function typedRuleTester(root: string): RuleTester {
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.ts'],
          defaultProject: 'tsconfig.json',
        },
        tsconfigRootDir: root,
      },
    },
  });
}

export function jsonRuleTester(): RuleTester {
  return new RuleTester({ languageOptions: { parser: jsonc } });
}
