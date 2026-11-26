import assert from 'node:assert/strict';

import type { RerankingModel } from 'ai';

import { test } from '@zukhruf/testing/node';

import {
  EmbeddingRerankRetriever,
  FusionRetriever,
  type Passage,
  PostprocessingRetriever,
  type Postprocessor,
  RerankRetriever,
  type RetrieveOptions,
  type Retriever,
  RetrieverUnavailableError,
} from './index.ts';
import { embeddingModel } from './testing/embedding-model.ts';
import { LiveRetriever } from './testing/live-retriever.ts';

// The rank window of every composite that reranks or diversifies a child
// retriever, as Elasticsearch's text_similarity_reranker and diversify
// retrievers take rank_window_size (#5728). A new composite with a window
// joins the tables below and gets the cases.

const query = 'rotate a key';

// 60 candidates in the retriever's order, c0 to c59. Each composite ranks c40
// first at 0.9, then the others in the retriever's order, from c0 at 0.5 down
// to c59 at 0.205.
const candidates = Array.from({ length: 60 }, (_, index) => `c${index}`);
const relevance = (text: string): number =>
  text === 'c40' ? 0.9 : 0.5 - Number(text.slice(1)) / 200;

// The embedding of a candidate has the cosine similarity of its relevance to
// the query's [1, 0].
const vectors = {
  [query]: [1, 0],
  ...Object.fromEntries(
    candidates.map((id) => {
      const r = relevance(id);
      return [id, [r, Math.sqrt(1 - r * r)]];
    }),
  ),
};

const unavailable = new RetrieverUnavailableError('HTTP 503');

/**
 * A host retriever of the candidates, of order only, that records the options
 * of each call and names one failure. With `ignoringTopK`, it gives every
 * candidate whatever topK it gets.
 */
const source = (ids: readonly string[] = candidates, ignoringTopK = false) => {
  const seen: RetrieveOptions<Passage>[] = [];
  const live = new LiveRetriever(ids, new Map([['news', unavailable]]));
  const retriever: Retriever<string, Passage> = {
    retrieve: async (text, options = {}) => {
      seen.push(options);
      return live.retrieve(
        text,
        ignoringTopK ? { ...options, topK: ids.length } : options,
      );
    },
  };
  return { retriever, seen };
};

type Window = { readonly rankWindowSize?: number };

type Made = {
  readonly composite: Retriever<string, Passage>;
  /** The ids that each call of its model or postprocessor ranked. */
  readonly ranked: () => readonly (readonly string[])[];
};

/** The options of a call that a composite passes to its retriever, but the topK. */
type PassedDown = (
  options: RetrieveOptions<Passage>,
) => RetrieveOptions<Passage>;

const unchanged: PassedDown = (options) => options;

type Composite = {
  readonly name: string;
  readonly passedDown: PassedDown;
  readonly make: (
    retriever: Retriever<string, Passage>,
    options: Window,
  ) => Made;
};

type Reranker = {
  readonly name: string;
  readonly passedDown: PassedDown;
  readonly make: (
    retriever: Retriever<string, Passage>,
    options: Window & {
      readonly topN?: number;
      readonly scoreThreshold?: number;
    },
  ) => Made;
};

const rerankers: readonly Reranker[] = [
  {
    name: 'RerankRetriever',
    passedDown: unchanged,
    make: (retriever, options) => {
      const ranked: string[][] = [];
      // A reranking model cannot run in CI: this one gives each text its
      // relevance, best first, cut at topN, as a provider does.
      const model: RerankingModel = {
        specificationVersion: 'v4',
        provider: 'test',
        modelId: 'rerank-mini',
        async doRerank({ documents, topN }) {
          const texts = documents.values.map(String);
          ranked.push(texts);
          return {
            ranking: texts
              .map((text, index) => ({
                index,
                relevanceScore: relevance(text),
              }))
              .toSorted((a, b) => b.relevanceScore - a.relevanceScore)
              .slice(0, topN),
          };
        },
      };
      return {
        composite: new RerankRetriever({ retriever, model, ...options }),
        ranked: () => ranked,
      };
    },
  },
  {
    name: 'EmbeddingRerankRetriever',
    // It embeds with its own model, so it never asks its retriever for
    // vectors.
    passedDown: ({ includeVectors: _asked, ...options }) => options,
    make: (retriever, options) => {
      const model = embeddingModel(vectors);
      return {
        composite: new EmbeddingRerankRetriever({
          retriever,
          model,
          ...options,
        }),
        // One call embeds the query, the other the texts it ranks.
        ranked: () =>
          model.doEmbedCalls
            .map(({ values }) => values)
            .filter((values) => values.join() !== query),
      };
    },
  },
];

const composites: readonly Composite[] = [
  ...rerankers,
  {
    name: 'PostprocessingRetriever',
    passedDown: unchanged,
    make: (retriever, { rankWindowSize }) => {
      const ranked: string[][] = [];
      // A host postprocessor that reranks by relevance.
      const rerank: Postprocessor<Passage> = {
        postprocess: async (passages) => {
          ranked.push(passages.map(({ passage }) => passage.id));
          return passages.toSorted(
            (a, b) => relevance(b.passage.text) - relevance(a.passage.text),
          );
        },
      };
      return {
        composite: new PostprocessingRetriever(
          rankWindowSize === undefined
            ? { retriever, postprocessors: [rerank] }
            : { retriever, postprocessors: [rerank], rankWindowSize },
        ),
        ranked: () => ranked,
      };
    },
  },
];

const ids = (passages: readonly { readonly passage: Passage }[]) =>
  passages.map(({ passage }) => passage.id);

void test.each(
  composites.map((composite) => [composite] as const),
  ([{ name, passedDown, make }]) =>
    test(`${name} with a rankWindowSize of 50 asks its retriever for 50 with the other options of the call unchanged, ranks the whole window and gives the best topK of it, though the best sits at position 40 of the retriever's order, and the failures of its retriever pass up unchanged`, async () => {
      // Arrange
      const { retriever, seen } = source();
      const { composite, ranked } = make(retriever, { rankWindowSize: 50 });
      const options: RetrieveOptions<Passage> = {
        topK: 3,
        includeVectors: true,
        filter: { field: 'metadata.lang', operator: '==', value: 'en' },
        signal: new AbortController().signal,
      };

      // Act
      const result = await composite.retrieve(query, options);

      // Assert
      assert.deepEqual(seen, [{ ...passedDown(options), topK: 50 }]);
      assert.deepEqual(ranked(), [candidates.slice(0, 50)]);
      assert.deepEqual(ids(result.passages), ['c40', 'c0', 'c1']);
      assert.deepEqual([...result.failures], [['news', unavailable]]);
    }),
);

void test.each(
  composites.flatMap((composite) =>
    (
      [
        [3, 3],
        [undefined, 10],
      ] as const
    ).map(([topK, asked]) => [composite, topK, asked] as const),
  ),
  ([{ name, make }, topK, asked]) =>
    test(`${name} with no rankWindowSize asks its retriever for ${asked} when the call gives the topK ${topK}`, async () => {
      // Arrange
      const { retriever, seen } = source();
      const { composite } = make(retriever, {});

      // Act
      const result = await composite.retrieve(
        query,
        topK === undefined ? {} : { topK },
      );

      // Assert
      assert.deepEqual(
        seen.map((options) => options.topK),
        [asked],
      );
      assert.equal(result.passages.length, asked);
    }),
);

void test.each(
  composites.map((composite) => [composite] as const),
  ([{ name, make }]) =>
    test(`${name} refuses a rankWindowSize smaller than the topK of the call before it calls its retriever or its model, as Elasticsearch refuses a rank_window_size smaller than size, and takes one equal to it`, async () => {
      // Arrange
      const { retriever, seen } = source();
      const narrow = make(retriever, { rankWindowSize: 5 });
      const equal = make(retriever, { rankWindowSize: 6 });

      // Act and Assert
      await assert.rejects(narrow.composite.retrieve(query, { topK: 6 }), {
        name: 'RangeError',
        message: 'The rankWindowSize 5 is smaller than the topK 6 of the call',
      });
      // A length, not deepEqual: deepEqual would narrow seen to never[].
      assert.equal(seen.length, 0);
      assert.deepEqual(narrow.ranked(), []);
      const result = await equal.composite.retrieve(query, { topK: 6 });
      assert.deepEqual(
        seen.map((options) => options.topK),
        [6],
      );
      assert.equal(result.passages.length, 6);
    }),
);

const constructors: readonly (readonly [
  name: string,
  make: (rankWindowSize: number) => unknown,
])[] = [
  ...composites.map(
    ({ name, make }) =>
      [
        name,
        (rankWindowSize: number) =>
          make(source().retriever, { rankWindowSize }),
      ] as const,
  ),
  [
    'FusionRetriever',
    (rankWindowSize: number) =>
      new FusionRetriever({
        retrievers: { live: { retriever: source().retriever } },
        rankWindowSize,
      }),
  ],
];

void test.each(
  constructors.flatMap(([name, make]) =>
    [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY].map(
      (rankWindowSize) => [name, make, rankWindowSize] as const,
    ),
  ),
  ([name, make, rankWindowSize]) =>
    test(`a rankWindowSize of ${rankWindowSize} is a RangeError when the ${name} is made`, () => {
      assert.throws(() => make(rankWindowSize), {
        name: 'RangeError',
        message: `The rankWindowSize is a positive integer, not ${rankWindowSize}`,
      });
    }),
);

// Every composite whose call's topK enters through its rank window: the
// composites above and the FusionRetriever, which has no model to rank with.
const windowed: readonly Composite[] = [
  ...composites,
  {
    name: 'FusionRetriever',
    passedDown: unchanged,
    make: (retriever, options) => ({
      composite: new FusionRetriever({
        retrievers: { live: { retriever } },
        ...options,
      }),
      ranked: () => [],
    }),
  },
];

void test.each(
  windowed.flatMap((composite) =>
    [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY].map(
      (topK) => [composite, topK] as const,
    ),
  ),
  ([{ name, make }, topK]) =>
    test(`${name} with a rankWindowSize of 50 refuses a topK of ${topK} in the call with a RangeError before it calls its retriever or its model, as Elasticsearch refuses a bad size`, async () => {
      // Arrange
      const { retriever, seen } = source();
      const { composite, ranked } = make(retriever, { rankWindowSize: 50 });

      // Act and Assert
      await assert.rejects(composite.retrieve(query, { topK }), {
        name: 'RangeError',
        message: `The topK is a whole number of 0 or more, not ${topK}`,
      });
      // A length, not deepEqual: deepEqual would narrow seen to never[].
      assert.equal(seen.length, 0);
      assert.deepEqual(ranked(), []);
    }),
);

void test.each(
  windowed.map((composite) => [composite] as const),
  ([{ name, make }]) =>
    test(`${name} gives no passages for a topK of 0, with or without a rankWindowSize, and calls no retriever, model or postprocessor, since no work can reach the call`, async () => {
      // Arrange: a retriever that gives every candidate whatever topK it
      // gets, so a model or a postprocessor after it would run.
      const { retriever, seen } = source(candidates, true);
      const windowed = make(retriever, { rankWindowSize: 50 });
      const plain = make(retriever, {});

      // Act
      const results = [
        await windowed.composite.retrieve(query, { topK: 0 }),
        await plain.composite.retrieve(query, { topK: 0 }),
      ];

      // Assert
      for (const result of results) {
        assert.deepEqual(result.passages, []);
        assert.deepEqual([...result.failures], []);
      }
      // A length, not deepEqual: deepEqual would narrow seen to never[].
      assert.equal(seen.length, 0);
      assert.deepEqual(windowed.ranked(), []);
      assert.deepEqual(plain.ranked(), []);
    }),
);

void test.each(
  composites.map((composite) => [composite] as const),
  ([{ name, make }]) =>
    test(`${name} with a rankWindowSize of 50 over a FusionRetriever with a rankWindowSize of 20 gets the fusion's RangeError, and over one of 100 each retriever of the fusion gets 100, as Elasticsearch nests windows`, async () => {
      // Arrange
      const first = source();
      const second = source();
      const fusion = (rankWindowSize: number) =>
        new FusionRetriever({
          retrievers: {
            first: { retriever: first.retriever },
            second: { retriever: second.retriever },
          },
          rankWindowSize,
        });
      const overNarrow = make(fusion(20), { rankWindowSize: 50 });
      const overWide = make(fusion(100), { rankWindowSize: 50 });

      // Act and Assert
      await assert.rejects(overNarrow.composite.retrieve(query, { topK: 3 }), {
        name: 'RangeError',
        message:
          'The rankWindowSize 20 is smaller than the topK 50 of the call',
      });
      const result = await overWide.composite.retrieve(query, { topK: 3 });
      assert.deepEqual(
        [...first.seen, ...second.seen].map((options) => options.topK),
        [100, 100],
      );
      assert.equal(result.passages.length, 3);
    }),
);

void test.each(
  composites.map((composite) => [composite] as const),
  ([{ name, make }]) =>
    test(`${name} with no rankWindowSize gives at most the topK of the call when its retriever gives more (ADR 0006)`, async () => {
      // Arrange
      const { retriever } = source(candidates, true);
      const { composite } = make(retriever, {});

      // Act
      const result = await composite.retrieve(query, { topK: 2 });

      // Assert: the composite ranked all 60.
      assert.deepEqual(ids(result.passages), ['c40', 'c0']);
    }),
);

void test.each(
  rerankers.map((reranker) => [reranker] as const),
  ([{ name, make }]) =>
    test(`${name} with a scoreThreshold in a window keeps the passages of the whole window at or above it, though they lie past the topK of the call in the retriever's order, and the cut to that topK does not refill, as Elasticsearch's min_score inside rank_window_size`, async () => {
      // Arrange: c40 at 0.9 and c0 at 0.5 are the only candidates at or above
      // the threshold (c1 is under it at 0.495), and in the reversed order
      // they sit at positions 20 and 60.
      const { retriever } = source(candidates.toReversed());
      const { composite } = make(retriever, {
        rankWindowSize: 60,
        scoreThreshold: 0.497,
      });

      // Act
      const result = await composite.retrieve(query, { topK: 3 });

      // Assert
      assert.deepEqual(ids(result.passages), ['c40', 'c0']);
    }),
);

void test.each(
  rerankers.map((reranker) => [reranker] as const),
  ([{ name, make }]) =>
    test(`${name} with a topN of 2 in a window gives 2 passages for a topK of 3, as Cohere's top_n keeps fewer`, async () => {
      // Arrange
      const { retriever } = source();
      const { composite } = make(retriever, { rankWindowSize: 50, topN: 2 });

      // Act
      const result = await composite.retrieve(query, { topK: 3 });

      // Assert
      assert.deepEqual(ids(result.passages), ['c40', 'c0']);
    }),
);
