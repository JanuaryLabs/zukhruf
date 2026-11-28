# Code copied in this package

The Rule of Three counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. While copies exist, a fix in one copy goes into each copy, and the commit names each place.

## In two places

**The guard of a message (an object with a string `type`).**

- Places: `isMessage` of `src/node-process.ts` and `isWorkerMessage` of `packages/testing/src/process/worker-process.ts`.
- Same: an object, not null, whose `type` is a string.
- The copy ends without a third place: the move of the `startWorker` users onto `NodeCommand` (backlog #6155) deletes `worker-process.ts`.

**A Perl program that reaps all its children (tests).**

- Places: `REAPS_ALL_ITS_CHILDREN` of `src/run.test.ts` and of `src/start.test.ts`.
- Same: the program forks a child that exits at once, then calls `wait()` until it finds no child, and exits with 0.
- A third place moves it into `src/testing/`.

**The text of an end in an error message.**

- Places: the constructor of `ProcessEndedError` in `src/process-ended-error.ts` and that of `ExitError` in `src/exit-error.ts`.
- Same: `exit code N` for an exit code, the name of the signal for a signal.
- A third place moves it into `src/end.ts`, beside `End`.

## Extracted

- **The start of a process under the keeper** (backlog #6166). Its third place was `NodeCommand`. `spawnUnderKeeper` of `src/launch.ts` holds what the copies shared: the environment without its `undefined` values, the folder, the file found before the start or a `StartError` that names the command, and the arguments to the keeper of [ADR 0004](./adr/0004-a-started-process-ends-with-its-parent-also-when-the-parent-is-killed.md) with the fixes of the environment, started detached, and the close of the lifeline at the exit of the program. Since the keeper of 2026-11-27 (one `KEEPER` for a run and a start), the execa options are the only difference and its only parameter: the stdio up to fd 3, the buffer, `input`, `ipc`. `runUnderKeeper` and `startUnderKeeper` call it, and `Command` and `NodeCommand` call them.
- **The helpers that read processes and process groups (tests).** Their third place was `src/node-command.test.ts`. They are in `src/testing/processes.ts`, which `abort.test.ts`, `start.test.ts` and `node-command.test.ts` import.
