import { untilAborted } from '@zukhruf/async';

import { fusePassages } from './fuse-passages.ts';
import { checkWeights } from './fuse.ts';
import type { Fusion, RankedDoc } from './fusion.ts';
import { NoRetrieverAnsweredError } from './no-retriever-answered-error.ts';
import type { Passage } from './passage.ts';
import type { QueryType } from './query-bundle.ts';
import { RankFusion } from './rank-fusion.ts';
import { RankWindow } from './rank-window.ts';
import type { RankedPassage } from './ranked-passage.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import { RetrieverUnavailableError } from './retriever-unavailable-error.ts';
import type { Retriever } from './retriever.ts';
import type { ScoredPassage } from './scored-passage.ts';

/**
 * The names of a fusion's retrievers, as the compiler checks them: at least
 * one, and none holds ':', the separator of a nested failure's path (ADR
 * 0014). A record typed by `string` passes, and the constructor checks it.
 */
type Names<K extends string> = ([K] extends [never]
  ? { readonly 'a FusionRetriever takes at least one retriever': never }
  : unknown) &
  Readonly<Record<Extract<K, `${string}:${string}`>, never>>;

/**
 * Where P is inferred: only from the passages each retriever gives, so a
 * live source beside an engine infers their common passage type, as an
 * array of both does. A filter puts P in a parameter too, and inferred from
 * there per name, P took the engine's `StoredPassage`, and the live source
 * did not compile.
 */
type Gives<P extends Passage> = {
  readonly retrieve: (
    query: never,
    options?: never,
  ) => Promise<RetrievalResult<P>>;
};

/** A retriever of the fusion by its name, with its weight. */
type Weighted<Q extends QueryType, P extends Passage, F> = {
  readonly retriever: Retriever<Q, P, RankedPassage<P> & F>;
  /** 1 when absent, as Elasticsearch's rrf `weight` and MongoDB's `weights`. A finite number of 0 or more, and at least one retriever's is above 0 (ADR 0007, amendment 2026-11-25). */
  readonly weight?: number;
};

/** What a retriever gave: its result, or the error that left it out. */
type Answer<P extends Passage, F> =
  | Answered<P, F>
  | {
      readonly name: string;
      readonly weight: number;
      readonly error: RetrieverUnavailableError;
    };

type Answered<P extends Passage, F> = {
  readonly name: string;
  readonly weight: number;
  readonly result: RetrievalResult<P, RankedPassage<P> & F>;
};

/**
 * Asks each named retriever for `rankWindowSize` passages, fuses the lists on
 * `Passage.id` and gives the best `topK` with their fused scores (ADR 0007). Each retriever gets the
 * query unchanged and reads its own text, as LlamaIndex's
 * `QueryFusionRetriever` gives each retriever the same `QueryBundle`. So the
 * query type of the fusion is one that each retriever takes: TypeScript
 * infers the narrowest query type of the retrievers, and retrievers that
 * need two other fields take `new FusionRetriever<A & B>(…)` (ADR 0013). Its
 * passage type is one that each retriever gives: a fusion of engines gives
 * `StoredPassage`, and a fusion with a live source `Passage` (ADR 0015). A
 * score fusion reads scores, so under a `ScoreFusion` each retriever gives
 * scored passages, and a retriever of order only does not compile, as
 * MongoDB's `$scoreFusion` refuses an input pipeline that gives no score.
 *
 * The retrievers run at once, with one signal linked to the caller's (ADR
 * 0014). A retriever that throws `RetrieverUnavailableError` is left out and
 * named in `failures`, and the failures of a retriever's own result are named
 * by path, `name:inner`. When no retriever answered, the call throws
 * `NoRetrieverAnsweredError`. Any other error aborts the signal of every
 * other retriever, with the error as the reason, and the call rejects with
 * it. A caller that aborted before the call starts no retriever, and a
 * `topK` of 0 gives no passages and starts none (ADR 0023). When the
 * caller aborts, the call rejects at once with the signal's reason, whatever
 * the retrievers do.
 */
export class FusionRetriever<
  in Q extends QueryType = QueryType,
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
  /** The fields a doc of the fusion has besides its id: unknown for a rank fusion, `{ score: number }` for a score fusion. */
  F = unknown,
  // The names of the retrievers. A type argument for Q or P makes it
  // `string`: TypeScript infers all or none.
  K extends string = string,
> implements Retriever<Q, P, ScoredPassage<P>> {
  readonly #retrievers: readonly (readonly [
    name: string,
    retriever: Retriever<Q, P, RankedPassage<P> & F>,
    weight: number,
  ])[];
  readonly #fusion: Fusion<RankedDoc & F>;
  readonly #window: RankWindow;

  constructor(options: {
    /**
     * Each retriever by its name, the name that `failures` and the errors of
     * the fusion give, with its weight. The lists fuse in the order of the
     * record's keys.
     */
    // `NoInfer`: P comes from the passages that each retriever gives (Gives),
    // and F from the fusion only. Gives comes first: after Weighted, a
    // retriever made in place with a query type of its own, such as
    // `new LiveRetriever(ids)`, took `never` from the `query: never` of Gives,
    // and so did Q.
    readonly retrievers: Readonly<Record<K, { readonly retriever: Gives<P> }>> &
      Readonly<Record<K, Weighted<Q, NoInfer<P>, NoInfer<F>>>> &
      Names<K>;
    /** `new RankFusion()` when absent: reciprocal rank fusion, k 60, ranks from 1. */
    readonly fusion?: Fusion<RankedDoc & F>;
    /**
     * How many passages each retriever gives to the fusion: the `topK` of
     * the call when absent. A positive integer, at least that `topK`, as
     * Elasticsearch's `rank_window_size` is at least `size`.
     */
    readonly rankWindowSize?: number;
  }) {
    const retrievers: Readonly<Record<string, Weighted<Q, P, F>>> =
      options.retrievers;
    const names = Object.keys(retrievers);
    if (names.length === 0) {
      throw new RangeError('A FusionRetriever takes at least one retriever');
    }
    for (const name of names) {
      if (name.includes(':')) {
        throw new RangeError(
          `A retriever's name holds no ':', the separator of a nested failure's path: ${name}`,
        );
      }
    }
    this.#retrievers = Object.entries(retrievers).map(
      ([name, { retriever, weight = 1 }]) => [name, retriever, weight],
    );
    checkWeights(
      this.#retrievers.map(([name, , weight]) => ({ name, weight })),
    );
    this.#fusion = options.fusion ?? new RankFusion();
    this.#window = RankWindow.of(options.rankWindowSize);
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P, ScoredPassage<P>>> {
    const call = this.#window.forCall(options.topK);
    const caller = options.signal;
    caller?.throwIfAborted();
    if (call === undefined) return { passages: [], failures: new Map() };
    const { topK, window } = call;
    // A bug aborts the siblings with the bug as the reason, as Go's
    // errgroup.WithContext cancels with its cause.
    const siblings = new AbortController();
    const signal =
      caller === undefined
        ? siblings.signal
        : AbortSignal.any([caller, siblings.signal]);
    const answers = await untilAborted(
      Promise.all(
        this.#retrievers.map(
          async ([name, retriever, weight]): Promise<Answer<P, F>> => {
            try {
              const result = await retriever.retrieve(query, {
                ...options,
                topK: window,
                signal,
              });
              return { name, weight, result };
            } catch (error) {
              if (error instanceof RetrieverUnavailableError) {
                return { name, weight, error };
              }
              siblings.abort(error);
              throw error;
            }
          },
        ),
      ),
      caller,
    );
    const failures = new Map<string, RetrieverUnavailableError>();
    const answered: Answered<P, F>[] = [];
    for (const answer of answers) {
      if ('result' in answer) {
        answered.push(answer);
        for (const [path, error] of answer.result.failures) {
          failures.set(`${answer.name}:${path}`, error);
        }
      } else if (
        answer.error instanceof NoRetrieverAnsweredError &&
        answer.error.failures.size > 0
      ) {
        for (const [path, error] of answer.error.failures) {
          failures.set(`${answer.name}:${path}`, error);
        }
      } else {
        failures.set(answer.name, answer.error);
      }
    }
    if (answered.length === 0) throw new NoRetrieverAnsweredError(failures);
    // One list for each retriever, empty for one that did not answer, so the
    // fusion gets the weights that the constructor checked (#5720).
    return {
      passages: fusePassages(
        this.#fusion,
        answers.map((answer) => ({
          name: answer.name,
          weight: answer.weight,
          passages: 'result' in answer ? answer.result.passages : [],
        })),
      ).slice(0, topK),
      failures,
    };
  }
}
