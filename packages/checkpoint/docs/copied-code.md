# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## In two places

A third place is the time to move these formats into `src/testing` (backlog #6201).

**The position and text formats of the tests (test data).**

- Places: `src/consumer-group.test.ts` and `src/testing/contract/checkpoint-store.ts`.
- Same: `position`, a `Format<number>` of version 1, and `text`, a `Format<string>` of version 1, each of which throws a `TypeError` for any other version or JSON type.
