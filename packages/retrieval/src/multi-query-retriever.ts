import { type LanguageModel, Output, generateText, jsonSchema } from 'ai';

import { untilAborted } from '@zukhruf/async';

import { asksForNoPassages, callTopK, positiveInteger } from './count.ts';
import { fusePassages } from './fuse-passages.ts';
import type { Fusion, RankedDoc } from './fusion.ts';
import type { Passage } from './passage.ts';
import { type QueryType, needOf, wordedNeed } from './query-bundle.ts';
import { RankFusion } from './rank-fusion.ts';
import type { RankedPassage } from './ranked-passage.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { RetrieverUnavailableError } from './retriever-unavailable-error.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * Asks the language model for `queryCount` other versions of the query,
 * searches the query and each version, and fuses the lists (ADR 0008, the
 * proposed amendment of 2026-11-23). The prompt, the JSON answer, the cut at
 * `queryCount` and the query searched once beside the versions are those of
 * Haystack's `QueryExpander` (haystack/components/query/query_expander.py:
 * DEFAULT_PROMPT_TEMPLATE, `n_expansions` 4, `include_original_query` True).
 * The list of the query comes first, as LlamaIndex's `QueryFusionRetriever`
 * puts the query first, so a tie goes to a passage that the query found.
 * The query is searched as the caller gives it, and each version as a plain
 * string: a version replaces the whole query, as in LlamaIndex, LangChain
 * and Haystack. So the retriever takes a plain query (ADR 0013). The
 * failures of the searches merge by name, in the order of the searches, and
 * a name that two searches give keeps the failure of the first (ADR 0014).
 * The lists fuse as the inputs `query`, `version 1` … `version n`, each with
 * the weight 1, so an error of the fusion names the search. It always gives
 * scored passages, the fused scores; under a `ScoreFusion` its retriever
 * gives scored passages, as a `FusionRetriever`'s retrievers do.
 *
 * The searches fan out as the retrievers of a `FusionRetriever` do: an
 * error of one search aborts the signal of the others, with the error as
 * the reason, and the call rejects with it; a caller that aborted before
 * the fan-out starts no search; when the caller aborts, the call rejects at
 * once with the signal's reason, while the model writes the versions too
 * (ADR 0017). It catches nothing, a
 * `RetrieverUnavailableError` too: every search reads one retriever, so an
 * unavailable retriever leaves nothing to answer (ADR 0014). An information
 * need that is empty or white space only is a `RangeError`, and a `topK` of
 * 0 gives no passages, both before the model or the retriever is called
 * (ADR 0023).
 */
export class MultiQueryRetriever<
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
  /** The fields a doc of the fusion has besides its id: unknown for a rank fusion, `{ score: number }` for a score fusion. */
  F = unknown,
> implements Retriever<QueryType, P, ScoredPassage<P>> {
  readonly #retriever: Retriever<QueryType, P, RankedPassage<P> & F>;
  readonly #model: LanguageModel;
  readonly #queryCount: number;
  readonly #fusion: Fusion<RankedDoc & F>;

  constructor(options: {
    // `NoInfer`: F comes from the fusion only.
    readonly retriever: Retriever<QueryType, P, RankedPassage<P> & NoInfer<F>>;
    readonly model: LanguageModel;
    /** How many versions the model writes, besides the query: 4 when absent. */
    readonly queryCount?: number;
    /** `new RankFusion()` when absent. */
    readonly fusion?: Fusion<RankedDoc & F>;
  }) {
    this.#retriever = options.retriever;
    this.#model = options.model;
    this.#queryCount = positiveInteger('queryCount', options.queryCount ?? 4);
    this.#fusion = options.fusion ?? new RankFusion();
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P, ScoredPassage<P>>> {
    const topK = callTopK(options.topK);
    const need = wordedNeed(needOf(query));
    const caller = options.signal;
    caller?.throwIfAborted();
    // A topK of 0 gives no passages, so the model call and the searches would
    // reach no caller (ADR 0023).
    if (asksForNoPassages(topK)) return { passages: [], failures: new Map() };
    // The model may ignore its signal: the caller's abort rejects at once.
    const { output } = await untilAborted(
      generateText({
        model: this.#model,
        prompt: expansionPrompt(need.trim(), this.#queryCount),
        output: Output.object({ schema: expansions }),
        // The AI SDK names the signal `abortSignal`.
        ...(caller === undefined ? {} : { abortSignal: caller }),
      }),
      caller,
    );
    const queries: QueryType[] = [
      query,
      ...output.queries
        .slice(0, this.#queryCount)
        .filter((version) => version.toLowerCase() !== need.toLowerCase()),
    ];
    // A caller that aborted before the fan-out starts no search, as a
    // FusionRetriever starts no retriever.
    caller?.throwIfAborted();
    // The first error aborts the other searches with the error as the
    // reason, as Go's errgroup.WithContext cancels with its cause.
    const siblings = new AbortController();
    const signal =
      caller === undefined
        ? siblings.signal
        : AbortSignal.any([caller, siblings.signal]);
    const results = await untilAborted(
      Promise.all(
        queries.map(async (version) => {
          try {
            return await this.#retriever.retrieve(version, {
              ...options,
              signal,
            });
          } catch (error) {
            siblings.abort(error);
            throw error;
          }
        }),
      ),
      caller,
    );
    return {
      passages: fusePassages(
        this.#fusion,
        results.map(({ passages }, index) => ({
          name: index === 0 ? 'query' : `version ${index}`,
          weight: 1,
          passages,
        })),
      ).slice(0, topK),
      failures: firstByName(results.map(({ failures }) => failures)),
    };
  }
}

const firstByName = (
  each: readonly ReadonlyMap<string, RetrieverUnavailableError>[],
): ReadonlyMap<string, RetrieverUnavailableError> => {
  const failures = new Map<string, RetrieverUnavailableError>();
  for (const [name, error] of each.flatMap((map) => [...map])) {
    if (!failures.has(name)) failures.set(name, error);
  }
  return failures;
};

const expansions = jsonSchema<{ readonly queries: readonly string[] }>(
  {
    type: 'object',
    properties: { queries: { type: 'array', items: { type: 'string' } } },
    required: ['queries'],
    additionalProperties: false,
  },
  {
    validate: (value) =>
      typeof value === 'object' &&
      value !== null &&
      'queries' in value &&
      Array.isArray(value.queries) &&
      value.queries.every((item) => typeof item === 'string')
        ? { success: true, value: { queries: value.queries } }
        : {
            success: false,
            error: new TypeError(
              `The model gave no "queries" array of strings: ${JSON.stringify(value)}`,
            ),
          },
  },
);

const expansionPrompt = (query: string, count: number): string =>
  `You are part of an information system that processes user queries for retrieval.
You have to expand a given query into ${count} queries that are
semantically similar to improve retrieval recall.

Structure:
Follow the structure shown below in examples to generate expanded queries.
These examples show the output when 3 queries are requested.

Examples:
1.  Query: "climate change effects"
    {"queries": ["impact of climate change", "consequences of global warming", "effects of environmental changes"]}

2.  Query: "machine learning algorithms"
    {"queries": ["neural networks", "clustering techniques", "supervised learning methods"]}

3.  Query: "open source NLP frameworks"
    {"queries": ["natural language processing tools", "free nlp libraries", "open-source NLP platforms"]}

Guidelines:
- Generate queries that use different words and phrasings
- Include synonyms and related terms
- Maintain the same core meaning and intent
- Make queries that are likely to retrieve relevant information the original might miss
- Focus on variations that would work well with keyword-based search
- Respond in the same language as the input query

Your Task:
Query: "${query}"

You *must* respond with a JSON object containing a "queries" array with exactly ${count} expanded queries.`;
