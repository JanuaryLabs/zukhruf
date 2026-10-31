import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AbsTaskRetrieval } from '../../abstasks/retrieval.ts';
import { TaskMetadata } from '../../abstasks/task-metadata.ts';
import { Tokenizer } from '../../dependencies/tokenizers.ts';
import { evaluate } from '../../evaluate.ts';
import type { ISOLanguageScript } from '../../types/metadata.ts';
import { type BM25Kwargs, bm25SSubword } from './bm25.ts';

// The tests of this file read tokenizer.json of Qwen/Qwen3-0.6B at "main"
// from the HuggingFace Hub, as MTEB does, into the default cache. nx runs
// them in the target test-network, without the nx cache, because the file
// can change on the Hub with no change in this repository.
//
// fixtures/bm25-subword/ holds what MTEB gave with the same file: the tokens
// and ids of each text, and the scores and main score of each run of
// mteb/baseline-bm25s-subword on a folder dataset of the BM25 fixtures. Its
// generate.py makes it.
const FIXTURES = join(import.meta.dirname, 'fixtures');

const expected: {
  readonly repository: string;
  readonly texts: readonly {
    readonly text: string;
    readonly tokens: readonly string[];
    readonly ids: readonly number[];
  }[];
  readonly runs: readonly {
    readonly folder: string;
    readonly eval_langs: ISOLanguageScript[];
    readonly kwargs: BM25Kwargs;
    readonly full: [string, [string, number][]][];
    readonly main_score: number;
  }[];
} = JSON.parse(
  readFileSync(join(FIXTURES, 'bm25-subword', 'expected.json'), 'utf8'),
);

class FolderTask extends AbsTaskRetrieval {
  constructor(folder: string, evalLangs: ISOLanguageScript[]) {
    super({
      metadata: new TaskMetadata({
        name: 'Bm25SubwordFixture',
        description: 'The BM25 fixture of @zukhruf/mteb.',
        dataset: { path: join(FIXTURES, folder), revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs,
        mainScore: 'ndcg_at_10',
      }),
    });
  }
}

test('the tokenizer of Qwen3 gives the tokens and ids of Python tokenizers for each text', async () => {
  const tokenizer = await Tokenizer.fromPretrained(expected.repository, {});

  const encodings = expected.texts.map(({ text }) => ({
    text,
    ...tokenizer.encode(text, { addSpecialTokens: false }),
  }));

  assert.deepEqual(
    encodings,
    expected.texts.map(({ text, tokens, ids }) => ({ text, ids, tokens })),
  );
});

for (const run of expected.runs) {
  const name = `${run.folder} ${JSON.stringify(run.kwargs)}`;

  test(`mteb/baseline-bm25s-subword gives the float32 scores of MTEB in ${name}, to the last bit`, async () => {
    const task = new FolderTask(run.folder, run.eval_langs);
    await task.loadData();
    const split = task.dataset?.get('default')?.get('test');
    assert.ok(split);
    const location = {
      taskMetadata: task.metadata,
      hfSplit: 'test',
      hfSubset: 'default',
      encodeKwargs: {},
    };
    const model = bm25SSubword.loadModel(run.kwargs);

    await model.index(split.corpus, location);
    const results = await model.search(split.queries, {
      ...location,
      topK: 100,
      topRanked: null,
    });

    assert.deepEqual(
      results,
      new Map(run.full.map(([query, docs]) => [query, new Map(docs)])),
    );
  });

  test(`evaluate gives the main score of MTEB for mteb/baseline-bm25s-subword in ${name}`, async () => {
    const result = await evaluate(
      bm25SSubword.loadModel(run.kwargs),
      new FolderTask(run.folder, run.eval_langs),
      { cache: null },
    );

    assert.equal(
      result.taskResults[0]?.scores['test']?.[0]?.['main_score'],
      run.main_score,
    );
  });
}
