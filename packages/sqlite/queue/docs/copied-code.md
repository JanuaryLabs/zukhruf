# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each file.

## Test helpers in more than two places

**`id`, `flush` and `outcome`.** More than ten places.

- Places: all three are in `src/parity/fail.test.ts`, `src/parity/fence.test.ts`, `src/parity/transactional.test.ts` and `src/parity/work.test.ts`. Each other test file in `src/parity` holds one or two of them.
- Same: `id` makes the UUID of a number. `flush` ticks the test clock of pg-boss by 0. `outcome` gives `resolved`, or the class and the message of the error.

The Rule of Three asks to move these helpers into `src/testing` (backlog #4083).
