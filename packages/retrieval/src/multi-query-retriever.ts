import { type LanguageModel, Output, generateText, jsonSchema } from 'ai';

import type { Fusion } from './fusion.ts';
import { reciprocalRankFusion } from './reciprocal-rank-fusion.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
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
 */
export class MultiQueryRetriever implements Retriever {
  readonly #retriever: Retriever;
  readonly #model: LanguageModel;
  readonly #queryCount: number;
  readonly #fusion: Fusion;

  constructor(options: {
    readonly retriever: Retriever;
    readonly model: LanguageModel;
    /** How many versions the model writes, besides the query: 4 when absent. */
    readonly queryCount?: number;
    /** `reciprocalRankFusion()` when absent. */
    readonly fusion?: Fusion;
  }) {
    this.#retriever = options.retriever;
    this.#model = options.model;
    this.#queryCount = options.queryCount ?? 4;
    this.#fusion = options.fusion ?? reciprocalRankFusion();
    if (!Number.isInteger(this.#queryCount) || this.#queryCount < 1) {
      throw new RangeError(
        `The queryCount is a positive integer, not ${this.#queryCount}`,
      );
    }
  }

  async retrieve(
    query: string,
    options: RetrieveOptions = {},
  ): Promise<ScoredPassage[]> {
    const { output } = await generateText({
      model: this.#model,
      prompt: expansionPrompt(query.trim(), this.#queryCount),
      output: Output.object({ schema: expansions }),
      ...(options.abortSignal === undefined
        ? {}
        : { abortSignal: options.abortSignal }),
    });
    const queries = [
      query,
      ...output.queries
        .slice(0, this.#queryCount)
        .filter((version) => version.toLowerCase() !== query.toLowerCase()),
    ];
    const lists = await Promise.all(
      queries.map((version) => this.#retriever.retrieve(version, options)),
    );
    return this.#fusion
      .fuse(
        lists,
        lists.map(() => 1),
      )
      .slice(0, options.topK ?? 10);
  }
}

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
