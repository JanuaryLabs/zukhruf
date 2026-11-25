import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { MockLanguageModelV4 } from 'ai/test';

import { open } from '@zukhruf/sqlite-open';
import { test } from '@zukhruf/testing/node';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

import {
  type Fusion,
  type FusionInput,
  FusionRetriever,
  MultiQueryRetriever,
  NoRetrieverAnsweredError,
  type Passage,
  type QueryType,
  RankFusion,
  type RankedDoc,
  type RetrievalResult,
  type RetrieveOptions,
  type Retriever,
  RetrieverUnavailableError,
  type ScoreDoc,
  ScoreFusion,
  type ScoredPassage,
  distributionBased,
  max,
  minMax,
  none,
  sum,
} from './index.ts';
import {
  SqliteBM25Retriever,
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from './sqlite.ts';
import { embeddingModel } from './testing/embedding-model.ts';
import { writeKeywordContract } from './testing/keyword-contract.ts';
import { LiveRetriever } from './testing/live-retriever.ts';
import {
  type EntrezQueryBundle,
  RecordingRetriever,
} from './testing/recording-retriever.ts';
import { settledThisTurn } from './testing/settled-this-turn.ts';

type Row = {
  readonly id: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly product?: string;
};

// The passage contract as elt writes it: the passages, an FTS5 keyword index
// with a keywords table as its external content, as ADR 0004 has it, and
// the passage vectors.
function contract(rows: readonly Row[]): DatabaseSync {
  const database = open(':memory:');
  install(database);
  writeKeywordContract(
    database,
    rows.map(({ id, text, product }) => ({
      id,
      text,
      product: product ?? 'a',
    })),
  );
  database.exec(
    'CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT',
  );
  const vector = database.prepare(
    `INSERT INTO docs_passage_vectors VALUES (?, ?, 'test/mini (4 dimensions)')`,
  );
  for (const row of rows) vector.run(row.id, toSql(Vector.from(row.vector)));
  return database;
}

// The keyword search ranks kw before both; the vector search ranks vec,
// both, kw, far, with cosines 1, 0.5, 0 and -1 to the query [1, 0, 0, 0].
const rows: readonly Row[] = [
  { id: 'kw', text: 'rotate key key key', vector: [0, 1, 0, 0] },
  { id: 'both', text: 'rotate the signing key', vector: [1, 1, 1, 1] },
  { id: 'vec', text: 'unrelated words', vector: [1, 0, 0, 0] },
  { id: 'far', text: 'nothing here', vector: [-1, 0, 0, 0] },
];

// The one query of these tests has the vector [1, 0, 0, 0].
const model = (signals: (AbortSignal | undefined)[]) =>
  embeddingModel({ 'rotate key': [1, 0, 0, 0] }, { signals });

const keywords = (database: DatabaseSync) =>
  new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

const retrievers = (
  database: DatabaseSync,
  signals: (AbortSignal | undefined)[] = [],
) => ({
  keywords: { retriever: keywords(database) },
  meaning: {
    retriever: new SqliteEmbeddingRetriever({
      store: new SqlitePassageStore({
        database,
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
      vectors: 'docs_passage_vectors',
      model: model(signals),
    }),
  },
});

const scores = (
  results: readonly {
    readonly passage: { readonly id: string };
    readonly score?: number;
  }[],
) => results.map(({ passage, score }) => [passage.id, score]);

// A host adapter whose source cannot answer throws RetrieverUnavailableError
// (ADR 0014).
const unavailable = (error: RetrieverUnavailableError): Retriever => ({
  retrieve: () => Promise.reject(error),
});

// A retriever that is still searching: it records the signal it gets and
// never settles, so only the fusion can settle the call.
class SignalRecordingRetriever implements Retriever {
  readonly signals: (AbortSignal | undefined)[] = [];

  retrieve = (
    _query: QueryType,
    options: RetrieveOptions = {},
  ): Promise<RetrievalResult> => {
    this.signals.push(options.signal);
    return new Promise(() => {});
  };
}

test('a FusionRetriever refuses a record of no retriever and a name that holds the path separator ":", by type for a literal record and at construction for a record typed by string', () => {
  // Arrange
  using database = contract(rows);
  const empty: Readonly<Record<string, { readonly retriever: Retriever }>> = {};
  const nested: Readonly<Record<string, { readonly retriever: Retriever }>> = {
    keywords: { retriever: keywords(database) },
    'labels:dailymed': { retriever: keywords(database) },
  };

  // Act and Assert
  assert.throws(() => new FusionRetriever({ retrievers: empty }), {
    name: 'RangeError',
    message: 'A FusionRetriever takes at least one retriever',
  });
  assert.throws(() => new FusionRetriever({ retrievers: nested }), {
    name: 'RangeError',
    message:
      "A retriever's name holds no ':', the separator of a nested failure's path: labels:dailymed",
  });
  // Each line after a directive is a compile error, which the typecheck
  // target proves; the function never runs.
  const refused = () => [
    // @ts-expect-error: a fusion takes at least one retriever
    new FusionRetriever({ retrievers: {} }),
    new FusionRetriever({
      retrievers: {
        keywords: { retriever: keywords(database) },
        // @ts-expect-error: ':' separates the names of a nested failure
        'labels:dailymed': { retriever: keywords(database) },
      },
    }),
  ];
  assert.equal(typeof refused, 'function');
});

test('each retriever takes its weight in its entry, 1 when absent', async () => {
  // Arrange
  using database = contract(rows);
  const { keywords, meaning } = retrievers(database);
  const retriever = new FusionRetriever({
    retrievers: { keywords, meaning: { ...meaning, weight: 3 } },
  });

  // Act
  const results = (await retriever.retrieve('rotate key')).passages;

  // Assert: keywords [kw, both] at weight 1, meaning [vec, both, kw, far] at
  // weight 3.
  //   both = 1 / 62 + 3 / 62 = 0.064516
  //   kw   = 1 / 61 + 3 / 63 = 0.064012
  //   vec  =          3 / 61 = 0.049180
  //   far  =          3 / 64 = 0.046875
  assert.deepEqual(scores(results), [
    ['both', 1 / 62 + 3 / 62],
    ['kw', 1 / 61 + 3 / 63],
    ['vec', 3 / 61],
    ['far', 3 / 64],
  ]);
});

test('a retriever that throws RetrieverUnavailableError is left out and named in failures, and the others still answer (#5582)', async () => {
  // Arrange
  using database = contract(rows);
  const down = new RetrieverUnavailableError('web search answered HTTP 503');
  const retriever = new FusionRetriever({
    retrievers: {
      web: { retriever: unavailable(down) },
      keywords: { retriever: keywords(database) },
    },
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert: the keyword list alone, [kw, both].
  assert.deepEqual(scores(result.passages), [
    ['kw', 1 / 61],
    ['both', 1 / 62],
  ]);
  assert.deepEqual([...result.failures], [['web', down]]);
});

test('a RetrieverUnavailableError leaves its siblings running: a sibling that answers on a later turn keeps its signal unaborted, and its passages are in the result', async () => {
  // Arrange: the sibling answers after setImmediate, when the unavailable
  // retriever has long rejected.
  const down = new RetrieverUnavailableError('web search answered HTTP 503');
  const signals: (AbortSignal | undefined)[] = [];
  const live = new LiveRetriever(['doi-1', 'doi-2']);
  const late: Retriever = {
    retrieve: async (query, options = {}) => {
      signals.push(options.signal);
      await nextTurn();
      return live.retrieve(query, options);
    },
  };
  const retriever = new FusionRetriever({
    retrievers: {
      web: { retriever: unavailable(down) },
      late: { retriever: late },
    },
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);
  assert.deepEqual(scores(result.passages), [
    ['doi-1', 1 / 61],
    ['doi-2', 1 / 62],
  ]);
  assert.deepEqual([...result.failures], [['web', down]]);
});

test("a nested fusion's failure beside a failure of the outer fusion: each is named, the nested one by its path, outer:inner, the outer one by its name", async () => {
  // Arrange
  const pubmed = new RetrieverUnavailableError('HTTP 429');
  const web = new RetrieverUnavailableError('HTTP 503');
  const retriever = new FusionRetriever({
    retrievers: {
      literature: {
        retriever: new FusionRetriever({
          retrievers: {
            pubmed: { retriever: unavailable(pubmed) },
            crossref: { retriever: new LiveRetriever(['doi-1']) },
          },
        }),
      },
      web: { retriever: unavailable(web) },
    },
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert
  assert.deepEqual(scores(result.passages), [['doi-1', 1 / 61]]);
  assert.deepEqual(
    [...result.failures],
    [
      ['literature:pubmed', pubmed],
      ['web', web],
    ],
  );
});

test('a nested fusion names each failure by its path, outer:inner, for an inner fusion that answered in part and for one where no retriever answered', async () => {
  // Arrange
  using database = contract(rows);
  const pubmed = new RetrieverUnavailableError('HTTP 429');
  const trials = new RetrieverUnavailableError('timeout');
  const preprints = new RetrieverUnavailableError('HTTP 503');
  const retriever = new FusionRetriever({
    retrievers: {
      literature: {
        retriever: new FusionRetriever({
          retrievers: {
            pubmed: { retriever: unavailable(pubmed) },
            crossref: { retriever: new LiveRetriever(['doi-1']) },
          },
        }),
      },
      registries: {
        retriever: new FusionRetriever({
          retrievers: {
            trials: { retriever: unavailable(trials) },
            preprints: { retriever: unavailable(preprints) },
          },
        }),
      },
      keywords: { retriever: keywords(database) },
    },
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert: literature [doi-1] and keywords [kw, both]; a tie keeps the
  // order of the lists.
  assert.deepEqual(scores(result.passages), [
    ['doi-1', 1 / 61],
    ['kw', 1 / 61],
    ['both', 1 / 62],
  ]);
  assert.deepEqual(
    [...result.failures],
    [
      ['literature:pubmed', pubmed],
      ['registries:trials', trials],
      ['registries:preprints', preprints],
    ],
  );
});

test('when no retriever answered, the call throws NoRetrieverAnsweredError, a RetrieverUnavailableError that names each failure, not an empty list', async () => {
  // Arrange
  const pubmed = new RetrieverUnavailableError('HTTP 429');
  const web = new RetrieverUnavailableError('HTTP 503');
  const retriever = new FusionRetriever({
    retrievers: {
      pubmed: { retriever: unavailable(pubmed) },
      web: { retriever: unavailable(web) },
    },
  });

  // Act
  const error = await retriever.retrieve('rotate key').then(
    () => assert.fail('the call answered'),
    (reason: unknown) => reason,
  );

  // Assert
  assert.ok(error instanceof NoRetrieverAnsweredError);
  assert.ok(error instanceof RetrieverUnavailableError);
  assert.equal(error.message, 'No retriever answered: pubmed, web');
  assert.deepEqual(
    [...error.failures],
    [
      ['pubmed', pubmed],
      ['web', web],
    ],
  );
  assert.ok(error.cause instanceof AggregateError);
  assert.deepEqual(error.cause.errors, [pubmed, web]);
});

test('an error that is no RetrieverUnavailableError is a bug: it aborts the signal of every other retriever, with the bug as the reason, and the call rejects with it at once (#5588)', async () => {
  // Arrange: the sibling never settles.
  const bug = new TypeError(
    "Cannot read properties of undefined (reading 'id')",
  );
  const sibling = new SignalRecordingRetriever();
  const retriever = new FusionRetriever({
    retrievers: {
      slow: { retriever: sibling },
      buggy: { retriever: { retrieve: () => Promise.reject(bug) } },
    },
  });

  // Act
  const outcome = await settledThisTurn(retriever.retrieve('rotate key'));

  // Assert
  assert.equal(outcome, bug);
  assert.equal(sibling.signals.length, 1);
  assert.equal(sibling.signals[0]?.aborted, true);
  assert.equal(sibling.signals[0]?.reason, bug);
});

test("the caller's abort rejects the call at once with the signal's reason, while the retrievers never settle, one ignoring its signal and one recording it; the recorded signal sees the abort (#5588)", async () => {
  // Arrange
  const caller = new AbortController();
  const reason = new Error('the turn ended');
  const recording = new SignalRecordingRetriever();
  const retriever = new FusionRetriever({
    retrievers: {
      deaf: { retriever: { retrieve: () => new Promise(() => {}) } },
      recording: { retriever: recording },
    },
  });

  // Act
  const call = retriever.retrieve('rotate key', {
    signal: caller.signal,
  });
  caller.abort(reason);
  const outcome = await settledThisTurn(call);

  // Assert: no retriever settles, so the call settles only by the abort.
  assert.equal(outcome, reason);
  assert.equal(recording.signals.length, 1);
  assert.equal(recording.signals[0]?.aborted, true);
  assert.equal(recording.signals[0]?.reason, reason);
});

test('a rankWindowSize smaller than the topK of the call is refused, as Elasticsearch refuses a rank_window_size smaller than size', async () => {
  // Arrange
  using database = contract(rows);
  const retriever = new FusionRetriever({
    retrievers: retrievers(database),
    rankWindowSize: 2,
  });

  // Act and Assert
  await assert.rejects(retriever.retrieve('rotate key', { topK: 3 }), {
    name: 'RangeError',
    message: 'The rankWindowSize 2 is smaller than the topK 3 of the call',
  });
});

test('by default the lists are fused by reciprocal rank fusion with k 60 and a weight of 1 each', async () => {
  // Arrange
  using database = contract(rows);
  const retriever = new FusionRetriever({ retrievers: retrievers(database) });

  // Act
  const results = (await retriever.retrieve('rotate key')).passages;

  // Assert: keywords [kw, both], meaning [vec, both, kw, far].
  //   kw   = 1 / 61 + 1 / 63 = 0.032266
  //   both = 1 / 62 + 1 / 62 = 0.032258
  //   vec  = 1 / 61          = 0.016393
  //   far  = 1 / 64          = 0.015625
  assert.deepEqual(scores(results), [
    ['kw', 1 / 61 + 1 / 63],
    ['both', 1 / 62 + 1 / 62],
    ['vec', 1 / 61],
    ['far', 1 / 64],
  ]);
});

test('each retriever gives rankWindowSize passages, the topK of the call when absent, and the call gives the best topK of the fused list', async () => {
  // Arrange
  using database = contract(rows);
  const windowOfTopK = new FusionRetriever({
    retrievers: retrievers(database),
  });
  const windowOfTwo = new FusionRetriever({
    retrievers: retrievers(database),
    rankWindowSize: 2,
  });

  // Act
  const fromTops = (await windowOfTopK.retrieve('rotate key', { topK: 1 }))
    .passages;
  const fromTwo = (await windowOfTwo.retrieve('rotate key', { topK: 1 }))
    .passages;

  // Assert: with one passage each, kw and vec tie at 1 / 61 and kw comes
  // first; with two each, both is second in each list: 2 / 62 > 1 / 61.
  assert.deepEqual(scores(fromTops), [['kw', 1 / 61]]);
  assert.deepEqual(scores(fromTwo), [['both', 1 / 62 + 1 / 62]]);
});

test('ten passages come back when the call gives no topK', async () => {
  // Arrange
  using database = contract(
    Array.from({ length: 12 }, (_, index) => ({
      id: `p${String(index).padStart(2, '0')}`,
      text: `rotate key ${'word '.repeat(index)}`,
      vector: [1, index, 0, 0],
    })),
  );
  const retriever = new FusionRetriever({ retrievers: retrievers(database) });

  // Act
  const results = (await retriever.retrieve('rotate key')).passages;

  // Assert: both lists rank p00 to p11 in the same order.
  assert.deepEqual(
    scores(results),
    Array.from({ length: 10 }, (_, index) => [
      `p${String(index).padStart(2, '0')}`,
      2 / (61 + index),
    ]),
  );
});

test('the filter and includeVectors of the call reach each retriever, and a passage gets the vector that one of the lists gives', async () => {
  // Arrange
  using database = contract(
    rows.map((row) => (row.id === 'both' ? { ...row, product: 'b' } : row)),
  );
  const retriever = new FusionRetriever({ retrievers: retrievers(database) });

  // Act
  const results = (
    await retriever.retrieve('rotate key', {
      filter: { field: 'metadata.product', operator: '==', value: 'a' },
      includeVectors: true,
    })
  ).passages;

  // Assert: keywords [kw], meaning [vec, kw, far]; the keyword list gives no
  // vectors, so kw has the one of the meaning list.
  assert.deepEqual(
    results.map(({ passage, score, vector }) => [passage.id, score, vector]),
    [
      ['kw', 1 / 61 + 1 / 62, [0, 1, 0, 0]],
      ['vec', 1 / 61, [1, 0, 0, 0]],
      ['far', 1 / 63, [-1, 0, 0, 0]],
    ],
  );
});

test("each retriever gets a signal that aborts when the call's signal aborts, with its reason, and an aborted signal rejects the call", async () => {
  // Arrange
  using database = contract(rows);
  const signals: (AbortSignal | undefined)[] = [];
  const both = new FusionRetriever({
    retrievers: retrievers(database, signals),
  });
  const keywordsOnly = new FusionRetriever({
    retrievers: { keywords: { retriever: keywords(database) } },
  });
  const given = new AbortController();
  const reason = new Error('the turn ended');
  const aborted = new AbortController();
  aborted.abort();

  // Act
  await both.retrieve('rotate key', { signal: given.signal });
  given.abort(reason);

  // Assert: the embedding model of the second retriever got the signal of
  // the fusion, linked to the call's, and the keyword retriever, which
  // calls no model, stops on an aborted one.
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[0]?.reason, reason);
  await assert.rejects(
    keywordsOnly.retrieve('rotate key', { signal: aborted.signal }),
    { name: 'AbortError' },
  );
});

test('the fusion and the weights that the caller gives fuse the lists', async () => {
  // Arrange
  using database = contract(rows);
  const { keywords, meaning } = retrievers(database);
  const retriever = new FusionRetriever({
    retrievers: {
      keywords: { ...keywords, weight: 0.75 },
      meaning: { ...meaning, weight: 0.25 },
    },
    fusion: new ScoreFusion({ normalizer: minMax(), combination: sum() }),
  });

  // Act
  const results = (await retriever.retrieve('rotate key')).passages;

  // Assert: keywords kw 1, both 0 after min-max; meaning 1, 0.5, 0, -1
  // become vec 1, both 0.75, kw 0.5, far 0.
  //   kw   = 0.75 * 1 + 0.25 * 0.5  = 0.875
  //   vec  =            0.25 * 1    = 0.25
  //   both = 0.75 * 0 + 0.25 * 0.75 = 0.1875
  //   far  =            0.25 * 0    = 0
  assert.deepEqual(scores(results), [
    ['kw', 0.875],
    ['vec', 0.25],
    ['both', 0.1875],
    ['far', 0],
  ]);
});

test('each retriever gets the query bundle unchanged and reads its own text: the keyword search its keywords, the embedding search its query or its customEmbeddings, and a host source its own field', async () => {
  // Arrange: no passage has the words "how" or "do" of the question, so a
  // keyword search of its words finds nothing.
  using database = contract(rows);
  const embeddings = embeddingModel({
    'how do I rotate the key?': [1, 0, 0, 0],
    'A key is rotated with a new one.': [0, 1, 0, 0],
  });
  const source = new RecordingRetriever<EntrezQueryBundle>(['pmid-1']);
  const federation = new FusionRetriever({
    retrievers: {
      source: { retriever: source },
      keywords: {
        retriever: new SqliteBM25Retriever({
          store: new SqlitePassageStore({
            database,
            passages: 'docs_passages',
            metadata: (columns) => columns,
          }),
          index: 'docs_passages_fts',
          matching: { operator: 'AND' },
        }),
      },
      meaning: {
        retriever: new SqliteEmbeddingRetriever({
          store: new SqlitePassageStore({
            database,
            passages: 'docs_passages',
            metadata: (columns) => columns,
          }),
          vectors: 'docs_passage_vectors',
          model: embeddings,
        }),
      },
    },
  });
  const question = {
    query: 'how do I rotate the key?',
    entrez: 'rotate AND key[Title]',
  };
  const withKeywords: EntrezQueryBundle = {
    ...question,
    keywords: ['rotate', 'key'],
  };
  const withEmbeddings: EntrezQueryBundle = {
    ...withKeywords,
    customEmbeddings: ['A key is rotated with a new one.'],
  };

  // Act
  const byKeywords = (await federation.retrieve(withKeywords)).passages;
  const byQuery = (await federation.retrieve(question)).passages;
  const byEmbeddings = (await federation.retrieve(withEmbeddings)).passages;

  // Assert
  assert.deepEqual(source.queries, [withKeywords, question, withEmbeddings]);
  assert.deepEqual(
    embeddings.doEmbedCalls.map(({ values }) => values),
    [
      ['how do I rotate the key?'],
      ['how do I rotate the key?'],
      ['A key is rotated with a new one.'],
    ],
  );
  // keywords [kw, both]; meaning of the query [vec, both, kw, far]; the
  // source [pmid-1].
  assert.deepEqual(scores(byKeywords), [
    ['kw', 1 / 61 + 1 / 63],
    ['both', 1 / 62 + 1 / 62],
    ['pmid-1', 1 / 61],
    ['vec', 1 / 61],
    ['far', 1 / 64],
  ]);
  // keywords of the words of the question []; the rest as above.
  assert.deepEqual(scores(byQuery), [
    ['pmid-1', 1 / 61],
    ['vec', 1 / 61],
    ['both', 1 / 62],
    ['kw', 1 / 63],
    ['far', 1 / 64],
  ]);
  // meaning of the custom embedding [0, 1, 0, 0]: [kw, both, far, vec].
  assert.deepEqual(scores(byEmbeddings), [
    ['kw', 1 / 61 + 1 / 61],
    ['both', 1 / 62 + 1 / 62],
    ['pmid-1', 1 / 61],
    ['far', 1 / 63],
    ['vec', 1 / 64],
  ]);
});

test('a fusion of plain retrievers takes a string as a query bundle with only query, and a fusion with a retriever that needs its own field takes neither, nor goes under MultiQueryRetriever', async () => {
  // Arrange
  using database = contract(rows);
  const plain = new FusionRetriever({ retrievers: retrievers(database) });
  const federation = new FusionRetriever({
    retrievers: {
      source: { retriever: new RecordingRetriever<EntrezQueryBundle>([]) },
      keywords: { retriever: keywords(database) },
    },
  });

  // Act
  const byString = (await plain.retrieve('rotate key')).passages;
  const byBundle = (await plain.retrieve({ query: 'rotate key' })).passages;

  // Assert
  assert.deepEqual(byString, byBundle);
  // Each line after a directive is a compile error, which the typecheck
  // target proves; the function never runs.
  const refused = () => [
    // @ts-expect-error: the source needs entrez, and a string has none
    federation.retrieve('rotate key'),
    // @ts-expect-error: the source needs entrez
    federation.retrieve({ query: 'rotate key', keywords: ['rotate'] }),
    // @ts-expect-error: keywords is a list of one or more words
    plain.retrieve({ query: 'rotate key', keywords: [] }),
    new MultiQueryRetriever({
      // @ts-expect-error: a version carries only query, so entrez is missing
      retriever: federation,
      model: new MockLanguageModelV4(),
    }),
  ];
  assert.equal(typeof refused, 'function');
});

test('a live source of order only fuses beside an engine search by reciprocal rank fusion, so its passages take their places among the scored ones (#5583); a score fusion over it does not compile (type-tests)', async () => {
  // Arrange
  using database = contract(rows);
  const byRank = new FusionRetriever({
    retrievers: {
      web: { retriever: new LiveRetriever(['web-1', 'web-2']) },
      keywords: { retriever: keywords(database) },
    },
  });

  // Act
  const ranked = (await byRank.retrieve('rotate key')).passages;

  // Assert: the keyword search ranks kw, both; each list's rank 1 gives
  // 1 / 61 and rank 2 1 / 62, and a tie keeps the order of the lists.
  assert.deepEqual(scores(ranked), [
    ['web-1', 1 / 61],
    ['kw', 1 / 61],
    ['web-2', 1 / 62],
    ['both', 1 / 62],
  ]);
});

test('a FusionRetriever whose only retriever with a weight above 0 is unavailable answers with the passages of the other retrievers, which add nothing to a score, and names the failure (#5720)', async () => {
  // Arrange
  const down = new RetrieverUnavailableError('HTTP 503');
  const retriever = new FusionRetriever({
    retrievers: {
      kept: { retriever: new LiveRetriever(['a', 'b']), weight: 0 },
      weighted: { retriever: unavailable(down) },
    },
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert
  assert.deepEqual(scores(result.passages), [
    ['a', 0],
    ['b', 0],
  ]);
  assert.deepEqual([...result.failures], [['weighted', down]]);
});

void test.each(
  [
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
    [-1],
  ] as const,
  ([weight]) =>
    test(`a FusionRetriever refuses a weight of ${weight} when it is made, with a RangeError that names the retriever (#5720)`, () => {
      // Arrange
      const retrievers = {
        kept: { retriever: new LiveRetriever(['a']) },
        weighted: { retriever: new LiveRetriever(['b']), weight },
      };

      // Act and Assert
      assert.throws(() => new FusionRetriever({ retrievers }), {
        name: 'RangeError',
        message: `The weight of weighted is a finite number of 0 or more, not ${weight}`,
      });
    }),
);

test('a FusionRetriever refuses weights of which none is above 0 when it is made (#5720)', () => {
  // Arrange
  const retrievers = {
    kept: { retriever: new LiveRetriever(['a']), weight: 0 },
    weighted: { retriever: new LiveRetriever(['b']), weight: 0 },
  };

  // Act and Assert
  assert.throws(() => new FusionRetriever({ retrievers }), {
    name: 'RangeError',
    message: 'A fusion takes at least one weight above 0: every weight is 0',
  });
});

test('a FusionRetriever takes a weight of 0 beside a weight above 0, and the retriever of weight 0 adds nothing to a score (#5720)', async () => {
  // Arrange
  const retriever = new FusionRetriever({
    retrievers: {
      kept: { retriever: new LiveRetriever(['x']), weight: 0 },
      weighted: { retriever: new LiveRetriever(['y', 'z']) },
    },
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert
  assert.deepEqual(scores(result.passages), [
    ['y', 1 / 61],
    ['z', 1 / 62],
    ['x', 0],
  ]);
});

// A host retriever that gives the scored passages it is made with, as an
// engine of the host would.
const giving = (
  ...passages: readonly ScoredPassage[]
): Retriever<QueryType, Passage, ScoredPassage> => ({
  retrieve: async () => ({ passages, failures: new Map() }),
});

const passageOf = (id: string, text = `text of ${id}`): Passage => ({
  id,
  text,
  metadata: {},
});

void test.each(
  [
    ['new RankFusion()', new RankFusion()],
    [
      'ScoreFusion(minMax, sum)',
      new ScoreFusion({ normalizer: minMax(), combination: sum() }),
    ],
    [
      'ScoreFusion(distributionBased, sum)',
      new ScoreFusion({ normalizer: distributionBased(), combination: sum() }),
    ],
  ] satisfies readonly (readonly [string, Fusion<ScoreDoc>])[],
  ([name, fusion]) =>
    test(`under ${name}, equal fused scores keep the order in which their ids first appear, a passage is the one of the first retriever that gives it, and its vector the first that a retriever gives`, async () => {
      // Arrange: q and p swap ranks and scores, so each fusion gives them
      // equal sums; q comes first, against the order of the ids. The core's
      // tie order has its own test in fusion.test.ts, both ways. Both
      // retrievers give q a vector; only meaning gives p one.
      const retriever = new FusionRetriever({
        retrievers: {
          keywords: {
            retriever: giving(
              { passage: passageOf('q'), score: 9, vector: [5, 5] },
              {
                passage: passageOf('p', 'p as the keywords list has it'),
                score: 8,
              },
            ),
          },
          meaning: {
            retriever: giving(
              {
                passage: passageOf('p', 'p as the meaning list has it'),
                score: 9,
                vector: [1, 0],
              },
              { passage: passageOf('q'), score: 8, vector: [0, 1] },
            ),
          },
        },
        fusion,
      });

      // Act
      const { passages } = await retriever.retrieve('rotate key');

      // Assert
      assert.deepEqual(
        passages.map(({ passage, vector }) => ({ passage, vector })),
        [
          { passage: passageOf('q'), vector: [5, 5] },
          {
            passage: passageOf('p', 'p as the keywords list has it'),
            vector: [1, 0],
          },
        ],
      );
      assert.equal(passages[0]?.score, passages[1]?.score);
    }),
);

test('a host Fusion<RankedDoc> gets one input for each retriever, named by it, with its weight, 1 when absent, and its passages as docs with their ids, and an empty input for a retriever that was unavailable; the call gives the passages in the order and with the scores of the fusion', async () => {
  // Arrange: the host fusion ranks the ids in the reverse order of their
  // first appearance.
  const down = new RetrieverUnavailableError('HTTP 503');
  const inputs: FusionInput<RankedDoc>[] = [];
  const reversed: Fusion<RankedDoc> = {
    fuse: (given) => {
      inputs.push(...given);
      return given
        .flatMap(({ docs }) => docs)
        .toReversed()
        .map(({ id }, index) => ({ id, score: 10 - index }));
    },
  };
  const retriever = new FusionRetriever({
    retrievers: {
      labels: {
        retriever: giving(
          { passage: passageOf('a'), score: 0.9 },
          { passage: passageOf('b'), score: 0.4 },
        ),
        weight: 2,
      },
      web: { retriever: new LiveRetriever(['c']) },
      pubmed: { retriever: unavailable(down) },
    },
    fusion: reversed,
  });

  // Act
  const result = await retriever.retrieve('rotate key');

  // Assert
  assert.deepEqual(inputs, [
    {
      name: 'labels',
      weight: 2,
      docs: [
        { id: 'a', passage: passageOf('a'), score: 0.9 },
        { id: 'b', passage: passageOf('b'), score: 0.4 },
      ],
    },
    {
      name: 'web',
      weight: 1,
      docs: [{ id: 'c', passage: { id: 'c', text: 'c', metadata: {} } }],
    },
    { name: 'pubmed', weight: 1, docs: [] },
  ]);
  assert.deepEqual(result.passages, [
    { passage: { id: 'c', text: 'c', metadata: {} }, score: 10 },
    { passage: passageOf('b'), score: 9 },
    { passage: passageOf('a'), score: 8 },
  ]);
  assert.deepEqual([...result.failures], [['pubmed', down]]);
});

test('a host fusion that gives an id that no retriever gave rejects the call with a TypeError that names the id, as no passage can go with it', async () => {
  // Arrange
  const invented: Fusion<RankedDoc> = {
    fuse: () => [{ id: 'x', score: 1 }],
  };
  const retriever = new FusionRetriever({
    retrievers: { web: { retriever: new LiveRetriever(['a']) } },
    fusion: invented,
  });

  // Act and Assert
  await assert.rejects(retriever.retrieve('rotate key'), {
    name: 'TypeError',
    message:
      'The fusion gave x, which no list holds: a fusion gives only the ids of its inputs',
  });
});

test('under ScoreFusion(none, max), a passage that two retrievers give keeps its greatest weighted score, not the sum, and a weight of 2 on 0.3 ranks above 0.5; the passage is the one of the first retriever that gives it, and its vector the first that a retriever gives (#5585)', async () => {
  // Arrange
  const retriever = new FusionRetriever({
    retrievers: {
      labels: {
        retriever: giving({
          passage: passageOf('x', 'x as the labels have it'),
          score: 0.3,
        }),
        weight: 2,
      },
      pubmed: {
        retriever: giving(
          { passage: passageOf('y'), score: 0.5, vector: [0, 1] },
          {
            passage: passageOf('x', 'x as pubmed has it'),
            score: 0.4,
            vector: [1, 0],
          },
        ),
      },
    },
    fusion: new ScoreFusion({ normalizer: none(), combination: max() }),
  });

  // Act
  const { passages } = await retriever.retrieve('rotate key');

  // Assert: x = max(2 * 0.3, 1 * 0.4) = 0.6; the sum would be 1.
  assert.deepEqual(passages, [
    {
      passage: passageOf('x', 'x as the labels have it'),
      score: 0.6,
      vector: [1, 0],
    },
    { passage: passageOf('y'), score: 0.5, vector: [0, 1] },
  ]);
});
