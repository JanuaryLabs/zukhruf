import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { Assertion } from 'promptfoo';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  ExactMatch,
  PathMatches,
  Recall,
  type Scorer,
  ScorerAssertion,
} from '../structured/index.ts';
import { AssertionModule } from './index.ts';

const execFileAsync = promisify(execFile);

test('a row that promptfoo eval --retry-errors runs again gets the named scores of its file references, from defaultTest and from its own assert', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('structured-eval-');
  const source = (path: string) => new URL(path, import.meta.url).href;
  await writeFile(
    join(folder.path, 'scorers.ts'),
    `import { ExactMatch, PathMatches, Recall, ScorerAssertion } from '${source('../structured/index.ts')}';
import { AssertionModule } from '${source('./index.ts')}';

export const scorers = new AssertionModule(import.meta.url, {
  exact_match: new ScorerAssertion(new ExactMatch(), { weight: 1, threshold: 1 }),
  key_recall_b: new ScorerAssertion(new Recall(new PathMatches()), {
    metric: 'key_recall',
    weight: 1,
    threshold: 0,
  }),
});
export default scorers.functions;
`,
  );
  await writeFile(
    join(folder.path, 'promptfooconfig.ts'),
    `import { scorers } from './scorers.ts';

export default {
  prompts: ['{{q}}'],
  providers: ['file://provider.mjs'],
  defaultTest: { assert: scorers.assert('exact_match') },
  tests: [
    { vars: { q: 'a', expected: '{"a": 1}' } },
    { vars: { q: 'b', expected: '{"a": 1}' }, assert: scorers.assert('key_recall_b') },
  ],
};
`,
  );
  // Answers every row with the expected record, but fails row b on its
  // first call.
  await writeFile(
    join(folder.path, 'provider.mjs'),
    `import { existsSync, writeFileSync } from 'node:fs';

export default class {
  id() {
    return 'fails-b-once';
  }
  async callApi(prompt) {
    const failed = new URL('./failed-b', import.meta.url);
    if (prompt === 'b' && !existsSync(failed)) {
      writeFileSync(failed, '');
      return { error: 'the first call of b fails' };
    }
    return { output: '{"a": 1}' };
  }
}
`,
  );
  const manifest = findPackageJSON('promptfoo', import.meta.url);
  assert.ok(manifest, 'promptfoo is a devDependency of the package');
  const { bin }: { bin: { promptfoo: string } } = JSON.parse(
    await readFile(manifest, 'utf8'),
  );
  const cli = join(manifest, '..', bin.promptfoo);
  const promptfoo = (...args: string[]) =>
    execFileAsync(process.execPath, [cli, ...args], {
      cwd: folder.path,
      timeout: 120_000,
      env: {
        ...process.env,
        PROMPTFOO_CONFIG_DIR: join(folder.path, 'promptfoo'),
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
        PROMPTFOO_DISABLE_SHARING: 'true',
        PROMPTFOO_PASS_RATE_THRESHOLD: '0',
      },
    });
  const rows = async (file: string) => {
    await promptfoo('export', 'eval', 'latest', '--output', file);
    const exported: {
      results: {
        results: {
          vars: { q: string };
          error?: string;
          success: boolean;
          namedScores: Record<string, number>;
        }[];
      };
    } = JSON.parse(await readFile(join(folder.path, file), 'utf8'));
    return new Map(exported.results.results.map((row) => [row.vars.q, row]));
  };
  const flags = ['--no-cache', '--no-table', '--no-progress-bar'];
  await promptfoo('eval', '-c', 'promptfooconfig.ts', ...flags);
  const first = await rows('first.json');

  // Act
  await promptfoo('eval', '--retry-errors', ...flags);
  const retried = await rows('retried.json');

  // Assert
  assert.equal(
    first.get('b')?.error,
    'the first call of b fails',
    'Row b must fail on its first run, so that --retry-errors runs it again',
  );
  assert.deepEqual(
    retried.get('b')?.namedScores,
    { exact_match: 1, key_recall: 1 },
    'The retried row must get the score of each of its assertions',
  );
  assert.equal(retried.get('b')?.success, true);
  assert.deepEqual(retried.get('a')?.namedScores, { exact_match: 1 });
});

test('assert gives each name a promptfoo javascript assertion of JSON only: the metric, the weight, the threshold and a file reference to the function of the name in the module', () => {
  const module = new AssertionModule('file:///evals/scorers.ts', {
    exact_match: new ScorerAssertion(new ExactMatch(), {
      weight: 2,
      threshold: 0.5,
    }),
    key_recall_text: new ScorerAssertion(new Recall(new PathMatches()), {
      metric: 'key_recall',
      weight: 0,
      threshold: 0,
    }),
  });

  const assertions = module.assert('key_recall_text', 'exact_match');

  assert.deepEqual(JSON.parse(JSON.stringify(assertions)), [
    {
      type: 'javascript',
      metric: 'key_recall',
      weight: 0,
      threshold: 0,
      value: 'file:///evals/scorers.ts:key_recall_text',
    },
    {
      type: 'javascript',
      metric: 'exact_match',
      weight: 2,
      threshold: 0.5,
      value: 'file:///evals/scorers.ts:exact_match',
    },
  ]);
  assert.deepEqual(
    ['{"a": 1}', '{"a": 2}'].map((output) =>
      module.functions['exact_match']?.(output, {
        vars: { expected: '{"a": 1}' },
      }),
    ),
    [1, 0],
  );
});

test('a config cannot list a scorer assertion as a promptfoo assertion, a scorer assertion has no name and may give a metric, and assert takes only the names of its module', () => {
  const module = new AssertionModule('file:///evals/scorers.ts', {
    exact_match: new ScorerAssertion(new ExactMatch(), {
      weight: 1,
      threshold: 1,
    }),
  });
  type Names = Parameters<typeof module.assert>[number];
  type Rule = ConstructorParameters<typeof ScorerAssertion>[1];

  const scorerIsAssertion: [ScorerAssertion] extends [Assertion]
    ? true
    : false = false;
  const referenceIsAssertion: [
    ReturnType<typeof module.assert>[number],
  ] extends [Assertion]
    ? true
    : false = true;
  const ownNameAllowed: ['exact_match'] extends [Names] ? true : false = true;
  const otherNameAllowed: ['key_f1'] extends [Names] ? true : false = false;
  const firstIsScorer: [
    ConstructorParameters<typeof ScorerAssertion>[0],
  ] extends [Scorer]
    ? true
    : false = true;
  const metricIsOptional: [undefined] extends [Rule['metric']] ? true : false =
    true;

  assert.deepEqual(
    [
      scorerIsAssertion,
      referenceIsAssertion,
      ownNameAllowed,
      otherNameAllowed,
      firstIsScorer,
      metricIsOptional,
    ],
    [false, true, true, false, true, true],
  );
});
