import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  TASK_TYPES,
  TASK_TYPE_TO_SIMPLIFIED_TASK_TYPE,
  TaskMetadata,
  type TaskMetadataInput,
  ValidationError,
  checkLanguageCode,
} from './task-metadata.ts';

// A minimal valid input.
function base(): TaskMetadataInput {
  return {
    name: 'T',
    dataset: { path: 'p', revision: 'r' },
    description: 'd',
    type: 'Retrieval',
    evalLangs: ['eng-Latn'],
    mainScore: 'ndcg_at_10',
  };
}

// Ported from tests/test_abstasks/test_task_metadata.py of MTEB 2.26.28. The
// expected values of the other tests come from MTEB 2.26.28 in Python.
describe('TaskMetadata', () => {
  test('a dataset with a path and a revision is valid', () => {
    const metadata = new TaskMetadata({
      name: 'MyTask',
      dataset: { path: 'test/dataset', revision: '1.0' },
      description: 'testing',
      reference: null,
      type: 'Classification',
      category: 't2t',
      modalities: ['text'],
      evalSplits: ['test'],
      evalLangs: ['eng-Latn'],
      mainScore: 'map_at_1000',
      bibtexCitation: '',
    });

    assert.equal(metadata.dataset.path, 'test/dataset');
    assert.equal(metadata.dataset.revision, '1.0');
  });

  test('metadata without a dataset throws a ValidationError that names the dataset', () => {
    const input = {
      name: 'MyTask',
      description: 'testing',
      type: 'Classification',
      evalLangs: ['eng-Latn'],
      mainScore: 'map_at_1000',
    };

    assert.throws(
      // @ts-expect-error -- the dataset is missing on purpose.
      () => new TaskMetadata(input),
      (error: unknown) =>
        error instanceof ValidationError && /^dataset$/mu.test(error.message),
    );
  });

  test('a dataset without a revision throws a ValidationError that names dataset.revision', () => {
    const input = {
      name: 'MyTask',
      dataset: { path: 'test/dataset' },
      description: 'testing',
      type: 'Classification',
      evalLangs: ['eng-Latn'],
      mainScore: 'map_at_1000',
    };

    assert.throws(
      // @ts-expect-error -- the revision is missing on purpose.
      () => new TaskMetadata(input),
      (error: unknown) =>
        error instanceof ValidationError &&
        error.message.includes('dataset.revision') &&
        error.message.includes('Field required'),
    );
  });

  test('a null revision throws a ValidationError', () => {
    const input = {
      name: 'MyTask',
      dataset: { path: 'test/dataset', revision: null },
      description: 'testing',
      type: 'Classification',
      evalLangs: ['eng-Latn'],
      mainScore: 'map_at_1000',
    };

    assert.throws(
      // @ts-expect-error -- the revision is null on purpose.
      () => new TaskMetadata(input),
      ValidationError,
    );
  });

  test('metadata with unset fields is not filled', () => {
    const metadata = new TaskMetadata({
      name: 'MyTask',
      dataset: { path: 'test/dataset', revision: '1.0' },
      description: 'testing',
      reference: null,
      type: 'Classification',
      category: 't2t',
      modalities: ['text'],
      evalSplits: ['test'],
      evalLangs: ['eng-Latn'],
      mainScore: 'map_at_1000',
      date: null,
      domains: null,
      license: null,
      taskSubtypes: null,
      annotationsCreators: null,
      dialect: null,
      sampleCreation: null,
      bibtexCitation: '',
    });

    assert.equal(metadata.isFilled(), false);
  });

  test('metadata with every field set is filled', () => {
    const metadata = new TaskMetadata({
      name: 'MyTask',
      dataset: { path: 'test/dataset', revision: '1.0' },
      description: 'testing',
      reference: 'https://aclanthology.org/W19-6138/',
      type: 'Classification',
      category: 't2t',
      modalities: ['text'],
      evalSplits: ['test'],
      evalLangs: ['eng-Latn'],
      mainScore: 'map_at_1000',
      date: ['2021-01-01', '2021-12-31'],
      domains: ['Non-fiction', 'Written'],
      license: 'mit',
      taskSubtypes: ['Thematic clustering'],
      annotationsCreators: 'expert-annotated',
      dialect: [],
      sampleCreation: 'found',
      bibtexCitation: 'Someone et al',
    });

    assert.equal(metadata.isFilled(), true);
  });

  test('toDict gives the JSON of pydantic model_dump_json, key for key and in its order', () => {
    const metadata = new TaskMetadata({
      name: 'T',
      dataset: { path: 'p', revision: 'r' },
      description: 'd',
      type: 'Retrieval',
      evalLangs: ['eng-Latn'],
      mainScore: 'ndcg_at_10',
      reference: 'https://Example.com',
      date: ['2021-01-01', '2021-12-31'],
      license: 'https://example.com/lic',
    });

    const json = JSON.stringify(metadata.toDict());

    assert.equal(
      json,
      '{"dataset":{"path":"p","revision":"r"},"name":"T","description":"d","prompt":null,"type":"Retrieval","modalities":["text"],"category":null,"reference":"https://example.com/","eval_splits":["test"],"eval_langs":["eng-Latn"],"main_score":"ndcg_at_10","date":["2021-01-01","2021-12-31"],"domains":null,"task_subtypes":null,"license":"https://example.com/lic","annotations_creators":null,"dialect":null,"sample_creation":null,"bibtex_citation":null,"adapted_from":null,"is_public":true,"contributed_by":null,"superseded_by":null,"is_beta":false}',
    );
  });

  test('fromDict reads the JSON form back, with the subsets of multilingual languages and the snake_case dataset keys', () => {
    const dict = {
      dataset: {
        path: 'p',
        revision: 'r',
        name: 'cfg',
        trust_remote_code: true,
      },
      name: 'T',
      description: 'd',
      type: 'Retrieval',
      eval_langs: { en: ['eng-Latn'], 'de-en': ['deu-Latn', 'eng-Latn'] },
      main_score: 'ndcg_at_10',
    };

    const metadata = TaskMetadata.fromDict(dict);

    assert.deepEqual(metadata.dataset, {
      path: 'p',
      revision: 'r',
      name: 'cfg',
      trustRemoteCode: true,
    });
    assert.deepEqual(metadata.toDict()['dataset'], dict.dataset);
    assert.deepEqual(metadata.toDict()['eval_langs'], dict.eval_langs);
  });

  test('a multilingual task gives the language views of MTEB', () => {
    const metadata = new TaskMetadata({
      name: 'T',
      dataset: { path: 'p', revision: 'r' },
      description: 'd',
      type: 'Retrieval',
      evalLangs: new Map([
        ['en', ['eng-Latn']],
        ['de-en', ['deu-Latn', 'eng-Latn']],
      ]),
      mainScore: 'ndcg_at_10',
    });

    assert.deepEqual(metadata.bcp47Codes, ['deu-Latn', 'eng-Latn']);
    assert.deepEqual(metadata.languages, ['deu', 'eng']);
    assert.deepEqual(metadata.scripts, new Set(['Latn']));
    assert.deepEqual(metadata.hfSubsets, ['en', 'de-en']);
    assert.deepEqual(
      metadata.hfSubsetsToLangscripts,
      new Map([
        ['en', ['eng-Latn']],
        ['de-en', ['deu-Latn', 'eng-Latn']],
      ]),
    );
    assert.equal(metadata.isMultilingual, true);
    assert.deepEqual(metadata.getModalities(), ['text']);
    assert.equal(metadata.simplifiedTaskType, 'retrieval');
  });

  test('a task with one language list has the subset "default"', () => {
    const metadata = new TaskMetadata({
      name: 'T',
      dataset: { path: 'p', revision: 'r' },
      description: 'd',
      type: 'Retrieval',
      evalLangs: ['eng-Latn'],
      mainScore: 'ndcg_at_10',
    });

    assert.deepEqual(
      metadata.hfSubsetsToLangscripts,
      new Map([['default', ['eng-Latn']]]),
    );
    assert.equal(metadata.isMultilingual, false);
    assert.equal(metadata.revision, 'r');
  });

  test('the category gives the modalities of the queries and of the documents', () => {
    const metadata = new TaskMetadata({
      name: 'T',
      dataset: { path: 'p', revision: 'r' },
      description: 'd',
      type: 'Retrieval',
      category: 'it2t',
      evalLangs: ['eng-Latn'],
      mainScore: 'ndcg_at_10',
    });

    assert.deepEqual(metadata.getModalities('query'), ['image', 'text']);
    assert.deepEqual(metadata.getModalities('document'), ['text']);
  });

  test('intextCitation gives the key of the BibTeX citation', () => {
    const metadata = new TaskMetadata({
      name: 'T',
      dataset: { path: 'p', revision: 'r' },
      description: 'd',
      type: 'Retrieval',
      evalLangs: ['eng-Latn'],
      mainScore: 'ndcg_at_10',
      bibtexCitation: '@article{smith2020, title={x}}',
    });

    assert.equal(metadata.intextCitation(), '\\cite{smith2020}');
    assert.equal(metadata.intextCitation(false), 'smith2020');
  });

  test('URLs and dates are normalized as pydantic normalizes them', () => {
    const urls = {
      'https://example.com': 'https://example.com/',
      'http://a.b/c?d=1#f': 'http://a.b/c?d=1#f',
      'https://example.com/a b': 'https://example.com/a%20b',
      'ftp://x.y': 'ftp://x.y/',
      'https://ex.com:443/x': 'https://ex.com/x',
      'HTTPS://EX.COM/Path': 'https://ex.com/Path',
    };
    const normalized = Object.keys(urls).map(
      (reference) => new TaskMetadata({ ...base(), reference }).reference,
    );

    assert.deepEqual(normalized, Object.values(urls));
    assert.throws(
      () => new TaskMetadata({ ...base(), reference: 'example.com' }),
      /reference/u,
    );
    assert.throws(
      () => new TaskMetadata({ ...base(), date: ['2021-1-1', '2021-12-31'] }),
      /date\.0/u,
    );
    assert.deepEqual(
      new TaskMetadata({
        ...base(),
        date: ['2021-01-01T00:00:00', '2099-01-01'],
      }).date,
      ['2021-01-01', '2099-01-01'],
    );
    assert.throws(
      () =>
        new TaskMetadata({
          ...base(),
          date: ['2021-01-01T10:00:00', '2021-12-31'],
        }),
      /date\.0/u,
    );
  });

  test('unknown fields, also in the dataset, are not permitted', () => {
    assert.throws(
      () =>
        TaskMetadata.fromDict({
          name: 'T',
          dataset: { path: 'p', revision: 'r' },
          description: 'd',
          type: 'Retrieval',
          eval_langs: ['eng-Latn'],
          main_score: 'ndcg_at_10',
          extra_field: 1,
        }),
      /extraField\n {2}Extra inputs are not permitted/u,
    );
    assert.throws(
      () =>
        new TaskMetadata({
          ...base(),
          // @ts-expect-error -- an unknown dataset key on purpose.
          dataset: { path: 'p', revision: 'r', foo: 1 },
        }),
      /dataset\.foo\n {2}Extra inputs are not permitted/u,
    );
    assert.throws(
      () =>
        new TaskMetadata({
          ...base(),
          // @ts-expect-error -- a prompt key that is not a prompt type.
          prompt: { passage: 'x' },
        }),
      ValidationError,
    );
  });

  test('modelCopy changes fields without validation and keeps the original', () => {
    const metadata = new TaskMetadata({
      name: 'T',
      dataset: { path: 'p', revision: 'r' },
      description: 'd',
      type: 'Retrieval',
      evalLangs: ['eng-Latn'],
      mainScore: 'ndcg_at_10',
    });

    const copy = metadata.modelCopy({ evalSplits: ['dev'] });

    assert.ok(copy instanceof TaskMetadata);
    assert.deepEqual(copy.evalSplits, ['dev']);
    assert.deepEqual(metadata.evalSplits, ['test']);
    assert.equal(copy.hashKey() === metadata.hashKey(), false);
  });
});

describe('checkLanguageCode', () => {
  test('accepts the codes that MTEB accepts and rejects the ones it rejects, with its messages', () => {
    const valid = ['eng-Latn', 'eng', 'Latn', 'python-Code'];
    const invalid = {
      'eng-Xxxx': 'Invalid script code: Xxxx',
      'foo-Code':
        'Programming language foo is not a valid programming language.',
      Code: 'Programming language None is not a valid programming language.',
      'ENG-Latn': 'Invalid language code: ENG',
      'en-Latn': 'Invalid language code: en',
      '': "Invalid language code: '', code must not be empty.",
    };

    for (const code of valid) checkLanguageCode(code);

    for (const [code, message] of Object.entries(invalid))
      assert.throws(
        () => checkLanguageCode(code),
        (error: unknown) =>
          error instanceof Error && error.message.startsWith(message),
      );
  });
});
