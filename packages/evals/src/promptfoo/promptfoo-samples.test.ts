import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import { Bootstrap, Ratio, RunLog } from '../index.ts';
import {
  type PromptfooReaders,
  type PromptfooResult,
  PromptfooSamples,
} from './index.ts';

const execFileAsync = promisify(execFile);

type Exported = {
  readonly results: {
    readonly prompts: readonly {
      readonly metrics: {
        readonly namedScores: Readonly<Record<string, number>>;
        readonly namedScoreWeights: Readonly<Record<string, number>>;
      };
    }[];
    readonly results: readonly PromptfooResult[];
  };
};

// The readers of these tests: the test id is the var q, the case is the
// expected value of the vars with weight 1, and the answer is the output.
const readers: PromptfooReaders<
  unknown,
  { readonly expected: unknown; readonly weight: number }
> = {
  test: (result) => String(result.vars['q']),
  cases: { from: (vars) => ({ expected: vars['expected'], weight: 1 }) },
  answer: (output) => output,
};

// Runs `promptfoo eval` in the folder with the provider given as the body of
// its callApi(prompt), on a test for each q of `tests`, each scored by a
// PromptfooAssertion of the recall against its expected value, and gives
// the export of the run.
async function evaluate(
  folder: string,
  {
    callApi,
    tests,
    prompts = ['{{q}}'],
    args = [],
    extensions = [],
  }: {
    readonly callApi: string;
    readonly tests: readonly {
      readonly q: string;
      readonly expected: unknown;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }[];
    readonly prompts?: readonly string[];
    readonly args?: readonly string[];
    readonly extensions?: readonly string[];
  },
): Promise<Exported> {
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
    return 'provider';
  }
  async callApi(prompt: string) {
    void FailedCall;
    ${callApi}
  }
}
`,
  );
  await writeFile(
    join(folder, 'promptfooconfig.ts'),
    `export default {
  prompts: ${JSON.stringify(prompts)},
  providers: ['file://provider.ts'],
  extensions: ${JSON.stringify(extensions)},
  tests: ${JSON.stringify(
    tests.map(({ q, expected, metadata }) => ({
      vars: { q, expected },
      ...(metadata === undefined ? {} : { metadata }),
      assert: [
        {
          type: 'javascript',
          value: 'file://assertion.ts',
          config: { expected },
        },
      ],
    })),
  )},
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
      ...args,
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
  ).catch((cause: unknown) => {
    // promptfoo exits 100 when a test fails or errs; the export is written.
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 100
    )
      return;
    throw cause;
  });
  return JSON.parse(await readFile(join(folder, 'out.json'), 'utf8'));
}

test('an answered row is a sample with its case, its answer, its ratios, its metadata and the usage of its call', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return {
      output: '{"a": 1}',
      tokenUsage: {
        prompt: 10,
        completion: 5,
        total: 15,
        completionDetails: { cacheReadInputTokens: 3 },
      },
      cost: 0.01,
    };`,
    tests: [
      {
        q: 'a',
        expected: { a: 1, b: 2 },
        // An object in the metadata is not a fact that a page can show.
        metadata: {
          labels: 4,
          split: 'tuning',
          source: { file: 'pages.jsonl' },
        },
      },
    ],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  const [sample] = [
    ...new PromptfooSamples(exported.results.results, {
      ...readers,
      cases: { from: (vars) => ({ expected: vars['expected'], weight: 3 }) },
    }),
  ];

  assert.ok(sample);
  assert.deepEqual(
    {
      test: sample.test,
      epoch: sample.epoch,
      weight: sample.weight,
      case: sample.case,
      outcome: sample.outcome,
      answer: sample.answer,
      ratios: sample.scorecard.ratios,
      metadata: sample.metadata,
      latencyMs: sample.latencyMs,
      call: sample.call,
    },
    {
      test: 'a',
      epoch: 0,
      weight: 3,
      case: { expected: { a: 1, b: 2 }, weight: 3 },
      outcome: 'answered',
      answer: '{"a": 1}',
      // One of the two expected values is stated.
      ratios: new Map([['recall', new Ratio(1, 2)]]),
      metadata: { labels: 4, split: 'tuning' },
      latencyMs: row.latencyMs,
      call: {
        replayed: false,
        usage: { input: 10, output: 5, cachedInput: 3, cost: 0.01 },
      },
    },
  );
});

test('a row whose provider answered with a FailedCall is a failed sample with the reason', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return new FailedCall('the call timed out').response();`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });

  const [sample] = [...new PromptfooSamples(exported.results.results, readers)];

  assert.ok(sample);
  assert.deepEqual(
    {
      outcome: sample.outcome,
      answer: sample.answer,
      error: sample.outcome === 'failed' ? sample.error : undefined,
    },
    { outcome: 'failed', answer: null, error: 'the call timed out' },
  );
});

test('the repeats of a test are its epochs, in the order of the tests and then of the epochs, whatever the order of the rows', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
    ],
    args: ['--repeat', '2'],
  });

  const samples = [
    ...new PromptfooSamples(exported.results.results.toReversed(), readers),
  ];

  // The provider measured no tokens, so no answer has a usage.
  assert.deepEqual(
    samples.map(({ test, epoch, call }) => [test, epoch, call.usage]),
    [
      ['a', 0, undefined],
      ['a', 1, undefined],
      ['b', 0, undefined],
      ['b', 1, undefined],
    ],
  );
});

test('a row that the provider replayed keeps the usage that the provider gave, and a replay with no tokens and no cost has no usage', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `if (prompt === 'a')
      return { output: '{"a": 1}', cached: true, tokenUsage: { prompt: 10, completion: 5, total: 15 }, cost: 0.01 };
    if (prompt === 'b')
      return { output: '{"a": 1}', cached: true, tokenUsage: { cached: 15, total: 15 } };
    return { output: '{"a": 1}', cached: true, tokenUsage: { cached: 15, total: 15 }, cost: 0.02 };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
      { q: 'c', expected: { a: 1 } },
    ],
  });

  const samples = [...new PromptfooSamples(exported.results.results, readers)];

  assert.deepEqual(
    samples.map(({ test, call }) => [test, call]),
    [
      [
        'a',
        {
          replayed: true,
          usage: { input: 10, output: 5, cachedInput: 0, cost: 0.01 },
        },
      ],
      ['b', { replayed: true, usage: undefined }],
      [
        'c',
        {
          replayed: true,
          usage: { input: 0, output: 0, cachedInput: 0, cost: 0.02 },
        },
      ],
    ],
  );
});

test('the ratio of sums of the samples is the number that promptfoo gives the run', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: prompt === 'a' ? '{"a": 1}' : '{"b": 9}' };`,
    tests: [
      { q: 'a', expected: { a: 1, b: 2 } },
      { q: 'b', expected: { a: 1, b: 2, c: 3 } },
    ],
  });
  const log = new RunLog(
    { id: 'eval', label: 'provider', createdAt: new Date(0) },
    new PromptfooSamples(exported.results.results, readers),
  );
  let draw = 0;
  const bootstrap = new Bootstrap({
    nResamples: 1,
    // Draw each test once, in order: the resample is the run itself.
    randomIndex: () => draw++,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(log.run(), 'recall');

  const [prompt] = exported.results.prompts;
  assert.ok(prompt);
  // a states 1 of 2 values and b none of 3: 1 / 5.
  assert.deepEqual(
    [interval.low, interval.high],
    [
      prompt.metrics.namedScores['recall'] ?? Number.NaN,
      prompt.metrics.namedScores['recall'] ?? Number.NaN,
    ].map(
      (score) =>
        score / (prompt.metrics.namedScoreWeights['recall'] ?? Number.NaN),
    ),
  );
  assert.equal(interval.low, 1 / 5);
});

test('the rows of two prompts are refused, since a run of two providers is two logs', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [{ q: 'a', expected: { a: 1 } }],
    prompts: ['{{q}}', 'again {{q}}'],
  });

  assert.throws(() => new PromptfooSamples(exported.results.results, readers), {
    name: 'RangeError',
    message: 'The samples of a run are the rows of one prompt. Prompts: 0, 1',
  });
});

test('a run whose error rows were not retried is refused, and the error names each of their tests', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `if (prompt !== 'a') throw new Error('401 Unauthorized');
    return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
      { q: 'c', expected: { a: 1 } },
    ],
  });

  assert.throws(
    () => new PromptfooSamples(exported.results.results, readers),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message.startsWith(
        'A run with an error row was not retried; run promptfoo eval with --retry-errors. Errors: b (epoch 0): ',
      ) &&
      error.message.includes(', c (epoch 0): ') &&
      error.message.includes('401 Unauthorized'),
  );
});

test('after --retry-errors, the stale error row of each retried epoch gives way to its retried row', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  await writeFile(
    join(folder.path, 'extension.ts'),
    `import { writeFileSync } from 'node:fs';

// afterAll gets every row of the eval, after a retry the stale error rows too.
export async function afterAll(context: { results: unknown[] }) {
  writeFileSync('after-all.json', JSON.stringify(context.results));
}
`,
  );
  // The call of b fails while the file "fail" exists, as a 503 would.
  await writeFile(join(folder.path, 'fail'), '');
  const run = {
    callApi: `const { existsSync } = await import('node:fs');
    if (prompt === 'b' && existsSync('fail')) throw new Error('503 Service Unavailable');
    return { output: '{"a": 1}' };`,
    tests: [
      { q: 'a', expected: { a: 1 } },
      { q: 'b', expected: { a: 1 } },
    ],
    extensions: ['file://extension.ts:afterAll'],
  };
  await evaluate(folder.path, { ...run, args: ['--repeat', '2'] });
  await rm(join(folder.path, 'fail'));
  await evaluate(folder.path, { ...run, args: ['--retry-errors'] });
  const rows: PromptfooResult[] = JSON.parse(
    await readFile(join(folder.path, 'after-all.json'), 'utf8'),
  );

  const samples = [...new PromptfooSamples(rows, readers)];

  assert.ok(
    rows.filter((row) => row.vars['q'] === 'b').length > 1,
    'afterAll of the retry got the stale row of b beside its retried row',
  );
  assert.deepEqual(
    samples.map(({ test, epoch, outcome }) => [test, epoch, outcome]),
    [
      ['a', 0, 'answered'],
      ['a', 1, 'answered'],
      ['b', 0, 'answered'],
      ['b', 1, 'answered'],
    ],
  );
});

// The guards below read rows that promptfoo does not write for one run, so
// each test builds them from a row that promptfoo wrote.

test('two rows of one test that are not errors are refused, since promptfoo does not tell which is the newest', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  assert.throws(() => new PromptfooSamples([row, { ...row }], readers), {
    name: 'RangeError',
    message:
      'Test 0 (epoch 0) has 2 rows, and promptfoo does not tell which is the newest',
  });
});

test('two error rows of one test with other scores are refused, since promptfoo does not tell which is the newest', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `throw new Error('503 Service Unavailable');`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  assert.throws(
    () =>
      new PromptfooSamples(
        [row, { ...row, namedScores: { recall: 0.5 } }],
        readers,
      ),
    {
      name: 'RangeError',
      message:
        'Test 0 (epoch 0) has 2 rows, and promptfoo does not tell which is the newest',
    },
  );
});

test('a score with no weight is refused, since promptfoo writes the weight of each score', async () => {
  await using folder = await new TemporaryFiles().directory('samples-');
  const exported = await evaluate(folder.path, {
    callApi: `return { output: '{"a": 1}' };`,
    tests: [{ q: 'a', expected: { a: 1 } }],
  });
  const [row] = exported.results.results;
  assert.ok(row);

  assert.throws(
    () =>
      new PromptfooSamples(
        [
          {
            ...row,
            gradingResult: { ...row.gradingResult, namedScoreWeights: {} },
          },
        ],
        readers,
      ),
    {
      name: 'RangeError',
      message: 'Score recall of test a has no weight in namedScoreWeights',
    },
  );
});
