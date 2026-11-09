# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## Test helpers in two places

**`outcome` that adds the code of the error, with the result of the call.**

- Places: `src/parity/fail.test.ts` and `src/parity/ids.test.ts`.
- Same: the call gives its result, or the class, the message and the `code` of the error.

**`outcome` that adds a code of type string.**

- Places: `src/parity/schedule.test.ts` and `src/parity/send-escapes.test.ts`.
- Same: the call gives `resolved`, or the class, the message and the `code` of the error when the code is a string.

## Same name, other knowledge

`src/testing/outcome.ts` gives `resolved`, or the class and the message of the error. These `outcome` functions compare a different result, so each stays in its test file:

- `src/parity/fence.test.ts` gives the result of the call.
- `src/parity/policies.test.ts` gives the result of the call, and the code of a driver error.
- `src/parity/queue-lifecycle.test.ts` gives `resolved`, and the code of a driver error.
- `src/parity/send-request.test.ts` gives the result of the call in a `resolved` field.
- `src/parity/transactional.test.ts` gives the fields of an `AssertionError`.
