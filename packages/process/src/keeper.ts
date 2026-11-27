/**
 * The keeper of ADR 0004, run as
 * `/bin/sh -c KEEPER keeper <grace in seconds> /usr/bin/env <fix>... <file> <arg>...`,
 * for a run and for a start.
 *
 * The parent starts it detached, so it leads its own process group, and gives
 * it a lifeline at fd 3 that the parent never writes. The keeper starts a
 * watcher that reads fd 3, and then execs the program, so the program leads
 * the group with the pid of the keeper, keeps its stdin and its signals, and
 * its end reaches the parent as itself: an exit code above 128 is that code,
 * not a signal.
 *
 * The watcher starts through a double fork: the subshell that forks it exits
 * at once, so the watcher is a child of init (or of a subreaper), not of the
 * program, and stays in the group of the program. A program that waits for
 * all its children (`waitpid(-1)` until ECHILD, `os.wait()` of Python, a
 * supervisor that ends with its last child) must not see the watcher: the
 * watcher ends only after the program, so that wait would never end. In the
 * nested subshells `$$` still names the keeper shell, which is the program
 * after the exec.
 *
 * The watcher ignores SIGTERM, so a stop leaves it running. At the end of
 * fd 3 it exits when the program is gone: the parent closes its end of fd 3
 * when the program exits. Else the parent ended, in any way, and the watcher
 * sends SIGTERM to the group, and SIGKILL after the grace. The watcher closes
 * fd 4, the IPC channel of a Node.js program in a run and in a start.
 *
 * `/usr/bin/env` makes the last exec, with `-u NAME` for each variable that
 * `sh` adds and the caller did not give, and `NAME=value` for each that the
 * caller gave, so the program gets the caller's environment and nothing else
 * (ADR 0003). The shell cannot do it itself: the `exec` of bash rewrites
 * SHLVL (an unset SHLVL arrives as 0, a given 7 as 6; probed 2026-11-27). A
 * file whose path holds `=` would be read by env as an assignment.
 *
 * Each line was probed on bash 3.2 as /bin/sh, dash, zsh and busybox ash
 * (2026-11-27 and, for the double fork, 2026-11-28, #6077): only
 * `kill -SIG -N` reads the same in all four, and the shell's own job notices ("Killed: 9") go to /dev/null, not to the
 * program. A stop empties the group in 1 to 5 ms, and a program that ignores
 * SIGTERM, whose parent is killed during a stop, ends at the grace.
 */
export const KEEPER = `
kill -0 -$$ 2>/dev/null || { echo 'keeper: start me detached' >&2; exit 126; }
grace=$1; shift
( (
  trap '' TERM
  while read -r _; do :; done <&3
  kill -0 $$ 2>/dev/null || exit 0
  kill -TERM -$$; sleep "$grace"; kill -KILL -$$
) </dev/null >/dev/null 2>&1 4>&- & )
exec 3<&-
exec "$@"
`;

/**
 * The variables that `sh` adds to the environment of its children, rewrites
 * or drops: bash as /bin/sh drops an OLDPWD that is not a folder and loses
 * `_` on the way to the target (a NodeCommand with `env: process.env` lacked
 * both, 2026-11-27).
 */
const SHELL_VARIABLES = ['PWD', 'SHLVL', 'OLDPWD', '_'] as const;

/** The operands of `/usr/bin/env` that undo what `sh` adds to `env`. */
export function environmentFixes(
  env: Readonly<Record<string, string>>,
): string[] {
  const given = SHELL_VARIABLES.filter((name) => name in env);
  return [
    ...SHELL_VARIABLES.filter((name) => !(name in env)).flatMap((name) => [
      '-u',
      name,
    ]),
    ...given.map((name) => `${name}=${env[name]}`),
  ];
}
