# A caller throws ExitError for an end that it does not accept

Status: Accepted 2026-11-28 (backlog #6077).

Decision-makers: Ezz, on 2026-11-28. Of "Add ExitError", "Also check option" and "Keep as is", he chose "Add ExitError".

[ADR 0002](./0002-a-run-gives-its-end-as-a-value-an-exit-code-or-a-signal-and-rejects-only-when-the-process-cannot-start-or-its-signal-aborts.md) gives the end of a run as a value, and its consequence said that a caller who wants a throw checks the end itself, because one line does it. The move of backlog #6155 showed otherwise. 10 sites in 7 projects wrote their own error for a run that ended badly, in 3 wordings, and some put the arguments of the command in the message, which can hold prompts or secrets. git-hooks made its own error class so that it could read exit code 1 as "no HEAD yet".

## The leaders

| Leader | The error of an end that the caller does not accept  | How it is raised                                       | Link                                                                            |
| ------ | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Go     | `*exec.ExitError`, with `ExitCode()` and `Stderr`    | `Run` and `Output` return it                           | https://pkg.go.dev/os/exec#ExitError                                            |
| Python | `CalledProcessError`, with `returncode` and `stderr` | `check=True`, or `CompletedProcess.check_returncode()` | https://docs.python.org/3/library/subprocess.html#subprocess.CalledProcessError |

Each has one error type for this case, and each keeps the stderr only when it captured it.

## Decision

- The caller still says which ends it accepts, as ADR 0002 decides, and throws `new ExitError(name, ended)` for any other end: `if (run.exitCode !== 0) throw new ExitError('git', run)`. `git diff --no-index` exits with 1 when the files differ, so its caller accepts 0 and 1.
- `ended` is a `Completed` of a run, or the `End` of a started process whose stderr went elsewhere, with an optional `stderr`.
- The message is `<name> ended (exit code N): <stderr tail>`, or `<name> ended (<signal>)`, never the arguments, as `ProcessEndedError` words an end.
- `end` holds the end, and `stderr` the last 16 KiB of the stderr, so a caller that catches it can read the exit code.
- There is no `check` option: a flag that turns a value into a throw changes the result type of `run()`.

## Considered Options

- **Keep ADR 0002 as it is.** The 10 messages stay, in their 3 wordings.
- **ExitError, and a `check` option as Python's.** 8 of the 10 sites then need no `if`, but `run()` gets two result types.
- **ExitError that the caller throws.** This option was selected.

## Consequences

- The 10 sites and `GitError` of git-hooks throw `ExitError`. A package whose own error is part of its API keeps that error and gives the `ExitError` as its `cause`, as `OpenSshConfig.resolve` of `@zukhruf/ssh` does.
- A caller that read `error.code` from the error of `execFile` reads `error.end.exitCode`.
