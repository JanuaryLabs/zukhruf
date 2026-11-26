import { fanOut } from './fan-out.ts';
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
import type { Rescored } from './scored-passage.ts';

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
 * Where P and I are inferred: only from the items each retriever gives, so a
 * live source beside an engine infers their common passage type and item,
 * as an array of both does. A filter puts P in a parameter too, and inferred
 * from there per name, P took the engine's `StoredPassage`, and the live
 * source did not compile. P comes from the passage of each item and I from
 * the whole item, so a host item keeps its own fields.
 */
type Gives<P extends Passage, I> = {
  readonly retrieve: (
    query: never,
    options?: never,
  ) => Promise<RetrievalResult<P, RankedPassage<P> & I>>;
};

/** A retriever of the fusion by its name, with its weight. */
type Weighted<
  Q extends QueryType,
  P extends Passage,
  I extends RankedPassage<P>,
  F,
> = {
  readonly retriever: Retriever<Q, P, I & F>;
  /** 1 when absent, as Elasticsearch's rrf `weight` and MongoDB's `weights`. A finite number of 0 or more, and at least one retriever's is above 0 (ADR 0007, amendment 2026-11-25). */
  readonly weight?: number;
};

/** What a retriever gave: its result, or the error that left it out. */
type Answer<P extends Passage, I extends RankedPassage<P>, F> =
  | Answered<P, I, F>
  | {
      readonly name: string;
      readonly weight: number;
      readonly error: RetrieverUnavailableError;
    };

type Answered<P extends Passage, I extends RankedPassage<P>, F> = {
  readonly name: string;
  readonly weight: number;
  readonly result: RetrievalResult<P, I & F>;
};

/**
 * Asks each named retriever for `rankWindowSize` passages, fuses the lists on
 * `Passage.id` and gives the best `topK` with their fused scores (ADR 0007).
 * Each fused item is the item of the first retriever, in the order of the
 * record's keys, that gives its id, with every field of that item but its
 * score, as Elasticsearch's rrf retriever keeps the one document of an id and
 * Haystack's `DocumentJoiner` keeps the other fields of the first document
 * with that id; its vector is the first that a retriever gives (ADR 0024).
 * No fields of two retrievers' items are merged. Each retriever gets the
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
  /**
   * The item that each retriever gives, whose fields the fused item keeps
   * but its score (ADR 0024): the common item of the retrievers when
   * inferred, as P is their common passage type. Retrievers whose items
   * differ in a field of their own fuse with a type argument that names
   * their union, as two metadata types do (ADR 0015).
   */
  // `out I`: I is only in what the composite gives. Unannotated, the
  // variance of `Rescored<I>` is not measured, so TypeScript compares two
  // composites by structure, where the method `retrieve` checks its
  // parameters both ways, and a host composite widened to a plain one.
  out I extends RankedPassage<P> = RankedPassage<P>,
> implements Retriever<Q, P, Rescored<I>> {
  readonly #retrievers: readonly (readonly [
    name: string,
    retriever: Retriever<Q, P, I & F>,
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
    // `NoInfer`: P and I come from the items that each retriever gives
    // (Gives), and F from the fusion only. Gives comes first: after Weighted, a
    // retriever made in place with a query type of its own, such as
    // `new LiveRetriever(ids)`, took `never` from the `query: never` of Gives,
    // and so did Q.
    readonly retrievers: Readonly<
      Record<K, { readonly retriever: Gives<P, I> }>
    > &
      Readonly<Record<K, Weighted<Q, NoInfer<P>, NoInfer<I>, NoInfer<F>>>> &
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
    const retrievers: Readonly<Record<string, Weighted<Q, P, I, F>>> =
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
  ): Promise<RetrievalResult<P, Rescored<I>>> {
    const call = this.#window.forCall(options.topK);
    const caller = options.signal;
    caller?.throwIfAborted();
    if (call === undefined) return { passages: [], failures: new Map() };
    const { topK, window } = call;
    // A bug aborts the siblings (fanOut); an unavailable retriever does not.
    const answers = await fanOut(
      caller,
      this.#retrievers.map(
        ([name, retriever, weight]) =>
          async (signal: AbortSignal): Promise<Answer<P, I, F>> => {
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
              throw error;
            }
          },
      ),
    );
    const failures = new Map<string, RetrieverUnavailableError>();
    const answered: Answered<P, I, F>[] = [];
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
      passages: fusePassages<I, F>(
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
