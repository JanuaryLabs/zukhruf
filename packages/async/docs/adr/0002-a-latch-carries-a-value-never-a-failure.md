# A latch carries a value, never a failure

A class that waits until something happened keeps a latch in a field (`@zukhruf/mutex` ADR 0009). The latch opened with no value. A flight of `@zukhruf/single-flight` must also give its callers the outcome of its work: a value or an error. It kept that outcome in a promise from `Promise.withResolvers()`, which rejected when the work failed. A promise in a field can reject before anybody awaits it. Node.js then stops the process with an unhandled rejection. The flight was safe only because another class attached a handler in the same step that made the flight.

What makes such a promise dangerous is the failure, not the value. Thus the latch carries a value, and it never carries a failure. `Latch<T>` opens with a value of type `T`, and every wait gets that value. The latch keeps the value in a box, so its promise never adopts a promise and never rejects, whatever `T` is. A latch whose type names a promise refuses one at compile time, because a wait would adopt it. Work that can fail puts its outcome into the latch as data: a `PromiseSettledResult` from `Promise.allSettled`. Each caller reads the outcome and throws the error for itself.

## Considered Options

- **Keep the outcome in a promise that can reject, and attach a handler when the promise is made.** DataLoader, lru-cache and abortable-promise-cache do this. The handler must come in the same step that makes the promise, and nothing in the code keeps that order.
- **Keep the outcome as data, and open a latch when it is there.** Other runtimes do this:

  | Tool                                       | What waits         | What it keeps                          |
  | ------------------------------------------ | ------------------ | -------------------------------------- |
  | Go `golang.org/x/sync/singleflight` `call` | `sync.WaitGroup`   | `val` and `err`, written before `Done` |
  | Rust `futures::future::Shared`             | a list of wakers   | the output, often a `Result`           |
  | Rust `tokio::sync::OnceCell`               | a closed semaphore | the value                              |
  | Scala `Promise`                            | callbacks          | a `Try`                                |
  | Effect `Deferred`                          | callbacks          | an `Exit`                              |

  p-memoize removed its option to cache a rejection. Its documentation now tells callers to keep the outcome as data with `p-reflect`. This option was selected.

- **Let a latch carry a failure too.** That is a future, and it has the danger of a promise in a field.

## Consequences

- A latch never rejects. `zukhruf/no-promise-field` cannot know this, so the field in `Latch` is the one place that holds a promise and is exempt from the rule.
- A wait that must stop early cancels with `untilAborted(latch.wait(), signal)`.
- `Latch` moved from `@zukhruf/mutex` to this package, because `@zukhruf/single-flight` uses it too.
