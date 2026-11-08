import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { Ratio, Recall, ScorerSet } from '../index.ts';
import {
  ConfigCase,
  ParseSuccess,
  TreeWalk,
  ValueMatches,
} from '../structured/index.ts';
import { FailedCall } from './index.ts';

const execFileAsync = promisify(execFile);

type Exported = {
  readonly results: {
    readonly prompts: readonly {
      readonly metrics: {
        readonly namedScores: Readonly<Record<string, number>>;
        readonly namedScoreWeights: Readonly<Record<string, number>>;
        readonly testErrorCount: number;
      };
    }[];
    readonly results: readonly {
      readonly vars: { readonly q: string };
      readonly success: boolean;
      readonly failureReason: number;
      readonly error?: string;
      readonly response?: {
        readonly output?: unknown;
        readonly metadata?: Readonly<Record<string, unknown>>;
      };
    }[];
  };
};

// Runs promptfoo eval in the folder on two cases: a provider of the
// consumer's own answers case a, and its call of case b fails, so it answers
// FailedCall's response. A PromptfooAssertion scores the recall.
async function evaluate(folder: string): Promise<Exported> {
  const source = (path: string) => new URL(path, import.meta.url).href;
  await writeFile(
    join(folder, 'assertion.ts'),
    `import { Recall, ScorerSet } from '${source('../index.ts')}';
import { ConfigCase, TreeWalk, ValueMatches } from '${source('../structured/index.ts')}';
import { PromptfooAssertion } from '${source('./index.ts')}';

export default new PromptfooAssertion(
  new ScorerSet({ recall: new Recall(new ValueMatches()) }, { comparer: new TreeWalk() }),
  new ConfigCase(),
).grade;
`,
  );
  await writeFile(
    join(folder, 'provider.ts'),
    `import { FailedCall } from '${source('./index.ts')}';

export default class {
  id() {
    return 'fails-b';
  }
  async callApi(prompt: string) {
    if (prompt === 'b')
      return new FailedCall('the call of b timed out').response({ harness: 'h1' });
    return { output: '{"a": 1, "b": 2}', metadata: { harness: 'h1' } };
  }
}
`,
  );
  await writeFile(
    join(folder, 'promptfooconfig.ts'),
    `const recall = (expected: unknown) => ({
  type: 'javascript' as const,
  value: 'file://assertion.ts',
  config: { expected },
});

export default {
  prompts: ['{{q}}'],
  providers: ['file://provider.ts'],
  tests: [
    { vars: { q: 'a' }, assert: [recall({ a: 1, b: 2 })] },
    { vars: { q: 'b' }, assert: [recall({ a: 1 })] },
  ],
};
`,
  );
  const manifest = findPackageJSON('promptfoo', import.meta.url);
  assert.ok(manifest, 'promptfoo is a devDependency of the package');
  const { bin }: { bin: { promptfoo: string } } = JSON.parse(
    await readFile(manifest, 'utf8'),
  );
  await execFileAsync(
    process.execPath,
    [
      join(manifest, '..', bin.promptfoo),
      'eval',
      '-c',
      'promptfooconfig.ts',
      '--no-cache',
      '--no-table',
      '--no-progress-bar',
      '-o',
      'out.json',
    ],
    {
      cwd: folder,
      timeout: 120_000,
      env: {
        ...process.env,
        PROMPTFOO_CONFIG_DIR: join(folder, 'promptfoo'),
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
        PROMPTFOO_DISABLE_SHARING: 'true',
        PROMPTFOO_PASS_RATE_THRESHOLD: '0',
      },
    },
  );
  return JSON.parse(await readFile(join(folder, 'out.json'), 'utf8'));
}

test('a case whose provider answers with the response of a FailedCall keeps its expected values in the pooled whole', async () => {
  await using folder = await new TemporaryFiles().directory('failed-call-');

  const exported = await evaluate(folder.path);

  const [prompt] = exported.results.prompts;
  assert.ok(prompt);
  assert.deepEqual(
    [
      prompt.metrics.namedScores['recall'],
      prompt.metrics.namedScoreWeights['recall'],
    ],
    [2, 3],
  );
});

test('the result of a FailedCall response is graded, not an error result, and its metadata has the reason beside the metadata of the provider', async () => {
  await using folder = await new TemporaryFiles().directory('failed-call-');

  const exported = await evaluate(folder.path);

  const failed = exported.results.results.find((row) => row.vars.q === 'b');
  assert.ok(failed);
  // ResultFailureReason.NONE: promptfoo graded the answer, and the
  // assertion, which has no gate, passed. An error result would be ERROR (2).
  assert.equal(failed.failureReason, 0);
  assert.equal(failed.error, undefined);
  assert.equal(failed.response?.output, FailedCall.answer);
  assert.deepEqual(failed.response?.metadata, {
    harness: 'h1',
    failed: 'the call of b timed out',
  });
  assert.equal(exported.results.prompts[0]?.metrics.testErrorCount, 0);
});

test('./structured reads the answer null as an unparsed answer: no parse, and no stated value', () => {
  const scorer = new ScorerSet(
    {
      'parse success': new ParseSuccess(),
      recall: new Recall(new ValueMatches()),
    },
    { comparer: new TreeWalk() },
  );

  const scorecard = scorer.score(
    FailedCall.answer,
    new ConfigCase().from({ expected: { a: 1 } }),
  );

  assert.deepEqual(
    [...scorecard.ratios],
    [
      ['parse success', new Ratio(0, 1)],
      ['recall', new Ratio(0, 1)],
    ],
  );
});
