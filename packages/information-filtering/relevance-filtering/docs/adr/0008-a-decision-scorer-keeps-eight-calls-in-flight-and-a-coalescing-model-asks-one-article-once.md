# A decision scorer keeps eight calls in flight, and a coalescing model asks about one article once

The decision scorer asked the decision model about one article at a time. The news reader of context-compiler (#3430) makes one scorer for each interest ([ADR 0006](./0006-a-scorer-is-made-for-one-interest-and-its-inputs-rule-out-illegal-states.md)), and its first fill asks d1-2B about 1,129 reports for each of 2 interests. Two facts make this slow:

- The llama.cpp server answers more than one call at a time. With `--parallel -1` (the default at b11960), it makes 4 slots with one unified KV cache. A scorer that sends one call at a time keeps 3 slots empty.
- TypeSafe System One answers all the questions of one call in one pass over the state. Its provider docs say: "It sends all questions in one request against the same state". A call with 16 questions took 1.97 s, and 16 calls with one question took about 4.5 s. The scorers of two interests ask about the same text, but each scorer sends its own call.

On 2026-10-31 the user chose two changes.

## Decision

**A decision scorer keeps up to 8 calls in flight.** The number is a constant of the package. It is not an option. The server owns its capacity: the count of its slots and what fits in its memory. The client only keeps the slots fed. Eight is two times the 4 slots that llama.cpp makes by default, so a slot does not wait while an answer travels back.

- Eight workers take the articles from one iterator of the stream, so the scorer asks about each article once.
- Every call gets the signal of the score. When the signal aborts, the calls that run abort, no new call starts, and the score rejects with the reason of the signal ([ADR 0007](./0007-a-score-takes-a-signal.md)).
- When a call fails, the scorer aborts the other calls and starts no new call. The score rejects with the error of the call.
- The scorer sorts the answers when all are in. The ranking does not depend on the order in which the answers arrive.

**A coalescing decision model asks about one article once for all interests.** `new CoalescingDecisionModel(model)` wraps a decision model and is a decision model too (the AI SDK's `DecisionModelV4`). The standard term is request coalescing. Facebook's DataLoader is the usual example: it collects the loads of one tick of the event loop and sends them as one batch.

- The calls that reach the model before the next macrotask (`setImmediate`), with the same text state and equal other options (`maxOutputTokens`, `reasoning`, `headers`, `providerOptions`), go to the wrapped model as one call with all their questions. The wrapper puts the index of the caller before each question id, so the ids of two callers do not collide. Each caller gets only its own answers, under its own ids.
- The AI SDK's `experimental_decide` (ai 7.0.154) waits only for promises that settle in microtasks before it calls `doDecide`. A probe started four calls with `Promise.all`, and all four reached `doDecide` before the first `setImmediate`. Thus the scorers of several interests that start together with `Promise.all` send their calls about one article in one window.
- A call that is alone in its window, a state with a part that is not text, or other options go to the wrapped model without a change, with the signal of the caller.
- A caller whose signal aborts rejects at once with the reason. The merged call aborts only when every caller in it has aborted.
- When the wrapped model fails, every caller of that call rejects with the same error. A refusal of one question fails only the caller of that question.
- Each caller gets the warnings, the rounding, the provider metadata and the response. Only the first caller gets the usage, so a sum over the callers is the real usage.

The host wraps its model once, makes one scorer for each interest with the wrapped model, and scores the interests with `Promise.all`.

## Considered Options

- **A `DecisionRouter` class that takes many interests and asks about each article once.** It changes the port for one adapter, and it helps only the fill of a host. The coalescing model keeps one scorer for each interest (ADR 0006).
- **A limit that adapts to the latency of the server.** Backlog #3472 holds it. A fixed limit is enough while the measured server is llama.cpp with 4 slots.
- **A constructor option for the limit.** The user's rule: a gain in speed only changes the default of the package, and adds no option at the call site.

## Consequences

- `DecisionScorer` asks about up to 8 articles at once. ADR 0007 said that the scorer asks about no later article after a stop. Now no question starts after a stop, and the calls that run abort.
- A failed call stops the other calls of its score.
- The decision scorer tests count the calls in flight on a stream of 20 articles, answer in another order than the questions, and stop the score from a timer while 8 calls run.
- The coalescing model tests use two scorers with one wrapped model. They check that the wrapped model gets one call for each article, with both questions, and that each scorer gets the scores that it gets without the wrapper.
- A host that wants one call for each article and each interest does not wrap its model.
