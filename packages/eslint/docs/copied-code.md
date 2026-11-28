# Code that is in two places

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names both files.

## In two places

**The output of a Node program (test helper).**

- Places: `outputOfProgram` in `src/modern-node/crypto-hash.test.ts` and in `src/modern-node/timers-promises-set-immediate.test.ts`.
- Same: each runs `code` as an ES module with `node --input-type=module --eval` through `Command#run` of `@zukhruf/process`, asserts exit code 0 with the program's stderr as the message, and gives its stdout.
- Differs: nothing.
- Extraction waits for a third place (backlog item in the zukhruf repo, "a third consumer").
