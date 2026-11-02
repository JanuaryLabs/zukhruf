# The process dies by its termination signal after the cleanup

On 2026-11-02, a search of context-compiler and elt found 6 entry points that turn termination signals into a stop of their work. Three use the same lines. Two do the same with SIGINT only or with a promise, and one closes a server:

```ts
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => stop.abort());
```

The work stops and the cleanup runs. But the process then exits with code 0, so its parent cannot tell an interrupted run from a completed run. A shell and Nx start these programs with `node main.js`, and a container will start them the same way in production. Probes on Node.js 26.10.0 and Docker 29.8.0 showed these results:

| Probe                                                                 | Result                                                     |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `node app && next` in zsh and Bash, Ctrl-C, `app` exits with 0        | `next` runs                                                |
| The same, `app` exits with 130                                        | `next` does not run; a Bash script loop goes on            |
| The same, `app` dies by SIGINT                                        | zsh stops the whole line; a Bash script loop stops         |
| A re-raise as the last statement of a module with a top-level `using` | The process dies before the `using` cleanup                |
| A re-raise from an `'exit'` listener                                  | The `using` and `await using` cleanup runs, then the death |
| `@godaddy/terminus` 4.12.1 with an `await using` cleanup of 100 ms    | terminus re-raises before the cleanup ends                 |
| `kill -TERM $$` as PID 1 in a container                               | The process lives on; the container exits with 0           |
| The same, with `docker run --init`                                    | The container exits with 143                               |
| `process.exitCode` set in an `'exit'` listener                        | It is the exit status                                      |

The rule is old. Martin Cracauer, [Proper handling of SIGINT/SIGQUIT](https://www.cons.org/cracauer/sigint.html): "There is no other way of doing this than to kill yourself with a SIGINT signal. Do it by resetting the SIGINT handler to SIG_DFL, then send yourself the signal." The GNU C Library manual, [Termination in Handler](https://sourceware.org/glibc/manual/latest/html_node/Termination-in-Handler.html): "reraising the signal sets the return status from the process correctly." `signal-exit` and the prompts of Nx re-raise. The Nx source gives the reason: "a parent using waitpid sees `signal: 'SIGINT'` rather than `code: 130`, which is what tools wrapping nx check".

## Considered Options

- **`process.exit(128 + n)`**, as `next start`, Vite, tsx and Playwright do. A shell does not stop a script for an exit code. `process.exit()` also waits for the thread pool of Node.js: a sync whose source read a pipe that no program wrote did not end for more than 10 minutes after SIGINT (context-compiler #2234).
- **A package from npm.** A search on 2026-11-02 read 13 packages. `exit-hook`, `close-with-grace`, `prexit`, `graceful-goodbye`, `node-graceful-shutdown`, `catch-exit`, `exit-signal` and `on-shutdown` end with `process.exit()`. `@godaddy/terminus` and `@breadc/death` re-raise from their own chain of callbacks, before the cleanup of the program ends. terminus also needs an HTTP server, and it ignores a second signal. `signal-exit` re-raises, but it does nothing while another listener for the signal exists.
- **A re-raise when the work ends**, in the code of the program. The process dies before the `using` scopes of the module end.
- **A re-raise from `'exit'`.** This option was selected.

## Consequences

- The package listens for `'exit'`. Node.js emits it after the event loop has no more work, so each `using` and `await using` scope has ended. At `'exit'`, the package removes each listener for the termination signal of the cause, also the listeners of other packages, and sends that signal to its own process. A listener of another package that stays would take the signal, and the signal would be lost: the process would run on (context-compiler #2511).
- Under PID 1 with no init process, the signal does nothing. Then the package sets `process.exitCode` to 128 + n with `util.convertProcessSignalToExitCode()`. Docker reports the same code as with an init process.
- A shutdown that never ends never emits `'exit'`. The second stop request, or the deadline of the supervisor, ends it ([ADR 0002](./0002-only-the-first-stop-request-starts-a-shutdown.md)).
- systemd treats a death by SIGTERM as a clean stop, but not exit code 143 (`SuccessExitStatus` in `systemd.service(5)`). The re-raise is correct for systemd too.
