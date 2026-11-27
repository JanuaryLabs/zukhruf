# Each end checks what it receives

Status: Accepted 2026-11-27 (backlog #4984).

Decision-makers: the zukhruf session mutex-91, which built step 1 of #4984. Paper v2 gave `Client(link, { errors })` and `Server(target, { methods: (keyof Local)[], errors })`; Ezz gave the go on the API as built on 2026-11-27.

An answer arrives from another thread or process. The mutex checks each message before it reads it (`isLockResponse`, mutex ADR 0017). The workspace's lint refuses `as` (`zukhruf/base/typescript`) and `any` (`island/no-explicit-any`), so a typed `call` cannot give an unchecked answer the type of its method.

## Decision

The `Client` takes `answers`: for each method of the peer, a check of its answer. A call whose answer fails its check rejects with a `TypeError`. The `Server` takes `methods`: for each method that it serves, a check of its parameters. A method with no check is not served, also when the target has it, and a request whose parameters fail the check rejects with a `TypeError` before the method runs.

## Considered Options

- **The types of paper v2, with an `as` at the answer.** The lint refuses it, and a wrong answer would flow on with a false type.
- **`Promise<unknown>` from `call`.** Each consumer would write the same narrowing after each call.
- **A list of method names on the server.** It names what is served, but the parameters would reach the method unchecked.

## Consequences

A consumer writes one check for each method. The keys of the server's checks are the list of served methods, so the two cannot disagree.

## Confirmation

`src/call/server.test.ts` and `src/call/client.test.ts`: mutations S10, S11 and C12 were CAUGHT (`mutate.mjs`, 2026-11-27).
