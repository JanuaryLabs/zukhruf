# A score takes a signal

**Superseded in part by [ADR 0008](./0008-a-decision-scorer-keeps-eight-calls-in-flight-and-a-coalescing-model-asks-one-article-once.md).** The decision scorer now keeps up to 8 calls in flight. After a stop, no question starts and the calls that run abort, in place of "the scorer asks about no later article". The required signal of this record is still valid.

A scorer can ask a model once for each article of the stream. The decision scorer asks d1-2B one article at a time. The news reader of context-compiler (#3430) scores its reports for each interest when the reports arrive. On its first pass, the reader has 1,129 reports and 2 interests, so it asks the model about 2,258 times. elt's watch waits for a running refresh before it stops, so a stop of the reader (Ctrl-C or SIGTERM) waited for all of these questions. A page that the viewer leaves also kept its questions to the model. The AI SDK's `experimental_decide` takes an `abortSignal`, but `Scorer.score(stream)` had no input for one. On 2026-10-30 the user chose a required signal on the port.

## Decision

**A score takes a signal, and the signal is required.** The port is `Scorer.score(stream, { signal })`. When the signal aborts, the score rejects with the reason of the signal. This follows the DOM Standard's guidance for an API that takes an `AbortSignal`: reject with the reason of the signal, also when the signal is aborted before the call. `fetch(url, { signal })` is the usual example.

- `DecisionScorer` gives the signal to `experimental_decide`. When the signal aborts, the question that runs stops, and the scorer asks about no later article.
- `KeywordScorer` and `SimilarityScorer` ask no model. They check the signal once, before they read a vector.
- A host that cannot stop a score gives a signal that never aborts, for example `new AbortController().signal`.

## Considered Options

- **An optional signal.** A host can forget the signal, and the type check does not tell it. A score that cannot stop holds the host's stop for as long as the model answers.
- **A signal for the scorer, in its constructor.** A host can keep one scorer for many scores. A stop belongs to one score: one page request, or one refresh.
- **The host checks its signal between interests.** A stop then waits for every question about one interest, and a page that the viewer leaves keeps its questions.

## Consequences

- Each call of `score` gives `{ signal }`. A host changes each of its calls.
- `src/api.test.ts` holds a score without a signal as a `@ts-expect-error` line, so the type check fails if the signal becomes optional.
- The decision scorer test stops a score from a timer while the model answers, and checks that the model gets no question about a later article.
