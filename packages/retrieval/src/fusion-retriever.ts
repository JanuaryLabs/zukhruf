import { untilAborted } from '@zukhruf/async';

import type { Fusion } from './fusion.ts';
import { NoRetrieverAnsweredError } from './no-retriever-answered-error.ts';
import type { Passage } from './passage.ts';
import type { QueryType } from './query-bundle.ts';
import { reciprocalRankFusion } from './reciprocal-rank-fusion.ts';
import type { RetrievalResult } from './retrieval-result.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import { RetrieverUnavailableError } from './retriever-unavailable-error.ts';
import type { Retriever } from './retriever.ts';

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

/** What a retriever gave: its result, or the error that left it out. */
type Answer<P extends Passage> =
  | Answered<P>
  | {
      readonly name: string;
      readonly error: RetrieverUnavailableError;
    };

type Answered<P extends Passage> = {
  readonly name: string;
  readonly weight: number;
  readonly result: RetrievalResult<P>;
};

/**
 * Asks each named retriever for `rankWindowSize` passages, fuses the lists on
 * `Passage.id` and gives the best `topK` (ADR 0007). Each retriever gets the
 * query unchanged and reads its own text, as LlamaIndex's
 * `QueryFusionRetriever` gives each retriever the same `QueryBundle`. So the
 * query type of the fusion is one that each retriever takes: TypeScript
 * infers the narrowest query type of the retrievers, and retrievers that
 * need two other fields take `new FusionRetriever<A & B>(…)` (ADR 0013). Its
 * passage type is one that each retriever gives: a fusion of engines gives
 * `StoredPassage`, and a fusion with a live source `Passage` (ADR 0015).
 *
 * The retrievers run at once, with one signal linked to the caller's (ADR
 * 0014). A retriever that throws `RetrieverUnavailableError` is left out and
 * named in `failures`, and the failures of a retriever's own result are named
 * by path, `name:inner`. When no retriever answered, the call throws
 * `NoRetrieverAnsweredError`. Any other error aborts the signal of every
 * other retriever, with the error as the reason, and the call rejects with
 * it. A caller that aborted before the call starts no retriever. When the
 * caller aborts, the call rejects at once with the signal's reason, whatever
 * the retrievers do.
 */
export class FusionRetriever<
  in Q extends QueryType = QueryType,
  // `in out P`: a filter puts P in a parameter as well, so TypeScript cannot
  // measure its variance and compares two composites by structure, where a
  // method checks its parameters both ways (ADR 0015).
  in out P extends Passage = Passage,
  // The names of the retrievers, which type the weights. A type argument
  // for Q or P makes it `string`: TypeScript infers all or none.
  K extends string = string,
> implements Retriever<Q, P> {
  readonly #retrievers: readonly (readonly [
    name: string,
    retriever: Retriever<Q, P>,
    weight: number,
  ])[];
  readonly #fusion: Fusion<P>;
  readonly #rankWindowSize: number | undefined;

  constructor(options: {
    /**
     * Each retriever by its name, the name that `failures` gives. The lists
     * fuse in the order of the record's keys.
     */
    readonly retrievers: Readonly<Record<K, Retriever<Q, NoInfer<P>>>> &
      Readonly<Record<K, Gives<P>>> &
      Names<K>;
    // `NoInfer`: P comes from the retrievers only. A fusion of the package
    // is generic in its `fuse`, so it takes P from there (ADR 0015).
    /** `reciprocalRankFusion()` when absent: k 60, ranks from 1. */
    readonly fusion?: Fusion<NoInfer<P>>;
    /** A weight for a retriever by its name: 1 for each name that is absent. */
    readonly weights?: Readonly<Partial<Record<NoInfer<K>, number>>>;
    /**
     * How many passages each retriever gives to the fusion: the `topK` of
     * the call when absent. It is at least that `topK`, as Elasticsearch's
     * `rank_window_size` is at least `size`.
     */
    readonly rankWindowSize?: number;
  }) {
    const retrievers: Readonly<Record<string, Retriever<Q, P>>> =
      options.retrievers;
    const weights: Readonly<Partial<Record<string, number>>> =
      options.weights ?? {};
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
    for (const name of Object.keys(weights)) {
      if (!Object.hasOwn(retrievers, name)) {
        throw new RangeError(
          `A FusionRetriever has no retriever named ${name} to weight: its retrievers are ${names.join(', ')}`,
        );
      }
    }
    this.#retrievers = Object.entries(retrievers).map(
      ([name, retriever]) =>
        [
          name,
          retriever,
          (Object.hasOwn(weights, name) ? weights[name] : undefined) ?? 1,
        ] as const,
    );
    this.#fusion = options.fusion ?? reciprocalRankFusion();
    this.#rankWindowSize = options.rankWindowSize;
  }

  async retrieve(
    query: Q,
    options: RetrieveOptions<P> = {},
  ): Promise<RetrievalResult<P>> {
    const topK = options.topK ?? 10;
    const rankWindowSize = this.#rankWindowSize ?? topK;
    if (rankWindowSize < topK) {
      throw new RangeError(
        `The rankWindowSize ${rankWindowSize} is smaller than the topK ${topK} of the call`,
      );
    }
    const caller = options.abortSignal;
    caller?.throwIfAborted();
    // A bug aborts the siblings with the bug as the reason, as Go's
    // errgroup.WithContext cancels with its cause.
    const siblings = new AbortController();
    const abortSignal =
      caller === undefined
        ? siblings.signal
        : AbortSignal.any([caller, siblings.signal]);
    const answers = await untilAborted(
      Promise.all(
        this.#retrievers.map(
          async ([name, retriever, weight]): Promise<Answer<P>> => {
            try {
              const result = await retriever.retrieve(query, {
                ...options,
                topK: rankWindowSize,
                abortSignal,
              });
              return { name, weight, result };
            } catch (error) {
              if (error instanceof RetrieverUnavailableError) {
                return { name, error };
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
    const answered: Answered<P>[] = [];
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
    return {
      passages: this.#fusion
        .fuse(
          answered.map(({ result }) => result.passages),
          answered.map(({ weight }) => weight),
        )
        .slice(0, topK),
      failures,
    };
  }
}
