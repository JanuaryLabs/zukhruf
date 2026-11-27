# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each place.

## In two places

**The start of a process under the keeper.**

- Places: `run` and `start` of `Command` (`src/command.ts`).
- Same: the environment without its `undefined` values, the folder, the file found before the start or a `StartError` that names the command, and the arguments of the keeper of [ADR 0004](./adr/0004-a-started-process-ends-with-its-parent-also-when-the-parent-is-killed.md) with the fixes of the environment, started detached.
- Differs: `run` keeps the output (the buffer of execa, `all`, `input`); `start` streams it (`buffer: false`, and the stdio that the caller gives).
- The third place is `NodeCommand` (unit 3 of backlog #6077). Then the start moves into one private method of the class.

**The helpers that read processes and process groups (tests).**

- Places: `src/abort.test.ts` and `src/start.test.ts`.
- Same: `running`, `groupExists` (EPERM is a group of zombies, which still exists), `killGroup`, `groupOf`, `pidsOf`, `pidIn` and `pidsIn`.
- The third place moves them into `src/testing` of this package, not into `@zukhruf/testing`, which will depend on this package.
