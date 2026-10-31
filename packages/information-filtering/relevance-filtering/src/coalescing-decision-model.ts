import type { Experimental_DecisionModel } from 'ai';

// The decision model of the provider interface (DecisionModelV4). The AI SDK
// also takes a model id string, which this decorator cannot call.
type DecisionModel = Extract<Experimental_DecisionModel, { doDecide: unknown }>;
type DecideOptions = Parameters<DecisionModel['doDecide']>[0];
type DecideResult = Awaited<ReturnType<DecisionModel['doDecide']>>;

// One call that waits for the window to close. Its promise settles once.
type Caller = {
  readonly options: DecideOptions;
  readonly resolve: (result: DecideResult) => void;
  readonly reject: (reason: unknown) => void;
};

// The calls of one window about one state with equal options. The signal of
// the merged call aborts when every caller has aborted.
type Group = { readonly callers: Caller[]; readonly abort: AbortController };

const aborted = ({ options }: Caller) => options.abortSignal?.aborted === true;

// Request coalescing, the pattern of Facebook's DataLoader: the calls that
// reach the model in one turn of the event loop, about the same text, go to
// the inner model as one call with all their questions. A decision model such
// as TypeSafe System One answers all the questions of a call in one pass over
// the state, so the scorers of several interests ask about one article for
// the cost of about one question (docs/adr/0008).
//
// The window closes on setImmediate. experimental_decide of ai 7 awaits only
// promises that settle in microtasks before it calls doDecide (the onStart
// callbacks, the preparation of a text state, the retry wrapper), so the
// calls of several scorers that start together with Promise.all all reach
// doDecide before the next macrotask. A probe on ai 7.0.154 with four calls
// in Promise.all saw all four before the first setImmediate.
//
// A call goes to the inner model unchanged, with its own signal, when it is
// alone in its window, when its state holds a part that is not text, or when
// its other options differ from those of every other call.
export class CoalescingDecisionModel implements DecisionModel {
  readonly specificationVersion = 'v4';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedQuestionTypes: DecisionModel['supportedQuestionTypes'];
  readonly #inner: DecisionModel;
  // The open window: the calls that wait, by their state and options.
  readonly #window = new Map<string, Group>();

  constructor(inner: DecisionModel) {
    this.#inner = inner;
    this.provider = inner.provider;
    this.modelId = inner.modelId;
    this.supportedQuestionTypes = inner.supportedQuestionTypes;
  }

  doDecide(options: DecideOptions): PromiseLike<DecideResult> {
    if (options.state.some((part) => part.type !== 'text'))
      return this.#inner.doDecide(options);
    const { state, maxOutputTokens, reasoning, headers, providerOptions } =
      options;
    const key = JSON.stringify({
      state,
      maxOutputTokens,
      reasoning,
      headers,
      providerOptions,
    });
    return new Promise((resolve, reject) => {
      const { abortSignal } = options;
      abortSignal?.throwIfAborted();
      const group = this.#group(key);
      // Removes the abort listener when the call settles.
      const listening = new AbortController();
      const caller: Caller = {
        options,
        resolve: (result) => {
          listening.abort();
          resolve(result);
        },
        reject: (reason) => {
          listening.abort();
          reject(reason);
        },
      };
      // A caller that aborts rejects at once with its reason.
      abortSignal?.addEventListener(
        'abort',
        () => {
          caller.reject(abortSignal.reason);
          if (group.callers.every(aborted))
            group.abort.abort(abortSignal.reason);
        },
        { once: true, signal: listening.signal },
      );
      group.callers.push(caller);
    });
  }

  // The group of the open window for the key. The first call of a window
  // opens it, and the next macrotask sends its groups.
  #group(key: string): Group {
    if (this.#window.size === 0)
      setImmediate(() => {
        const groups = [...this.#window.values()];
        this.#window.clear();
        for (const group of groups) this.#send(group);
      });
    const group = this.#window.get(key) ?? {
      callers: [],
      abort: new AbortController(),
    };
    this.#window.set(key, group);
    return group;
  }

  #send(group: Group): void {
    const callers = group.callers.filter((caller) => !aborted(caller));
    const [first] = callers;
    if (first === undefined) return;
    if (callers.length === 1) {
      Promise.try(() => this.#inner.doDecide(first.options)).then(
        first.resolve,
        first.reject,
      );
      return;
    }
    // The ids of the merged call start with the index of their caller, so
    // two callers' ids never collide.
    const merged = (index: number, id: string) => `${index}.${id}`;
    Promise.try(() =>
      this.#inner.doDecide({
        ...first.options,
        abortSignal: group.abort.signal,
        questions: Object.fromEntries(
          callers.flatMap(({ options }, index) =>
            Object.entries(options.questions).map(([id, question]) => [
              merged(index, id),
              question,
            ]),
          ),
        ),
      }),
    ).then(
      ({ answers, usage, ...result }) => {
        for (const [index, { options, resolve }] of callers.entries())
          resolve({
            ...result,
            answers: Object.fromEntries(
              Object.keys(options.questions).flatMap((id) => {
                const answer = answers[merged(index, id)];
                return answer === undefined ? [] : [[id, answer]];
              }),
            ),
            // The inner model used these tokens once for all the callers.
            // Only the first caller reports them, so a sum over the callers
            // equals the real usage.
            ...(index === 0 && { usage }),
          });
      },
      (error: unknown) => {
        for (const { reject } of callers) reject(error);
      },
    );
  }
}
