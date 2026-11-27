/**
 * The keeper of ADR 0004, run as
 * `/bin/sh -c KEEPER keeper <grace in seconds> /usr/bin/env <fix>... <file> <arg>...`.
 *
 * The parent starts it detached, so it leads its own process group, and gives
 * it a lifeline at fd 3 that the parent never writes. A watcher reads fd 3; at
 * its end (the parent ended, in any way) it sends SIGTERM to the group, and
 * SIGKILL after the grace. The target runs in the foreground of the group, so
 * it keeps its stdin and its signals, and the keeper ends as the target ended.
 *
 * `/usr/bin/env` makes the last exec, with `-u NAME` for each variable that
 * `sh` adds and the caller did not give, and `NAME=value` for each that the
 * caller gave, so the target gets the caller's environment and nothing else
 * (ADR 0003). The shell cannot do it itself: the `exec` of bash rewrites
 * SHLVL (an unset SHLVL arrives as 0, a given 7 as 6; probed 2026-11-27). A
 * file whose path holds `=` would be read by env as an assignment. The
 * watcher closes fd 4 and fd 5, the pid report and the IPC channel of a
 * Node.js target.
 *
 * Each line was probed on bash 3.2 as /bin/sh, dash, zsh and busybox ash
 * (2026-11-27): only `kill -SIG -N` reads the same in all four, and the
 * shell's own job notices ("Killed: 9") go to /dev/null, not to the target.
 */
export const KEEPER = keeper('exec "$@"');

/**
 * The keeper of a start. Its last exec goes through a new `sh` that writes
 * its own pid on fd 4 and then becomes the target, so the parent knows the pid
 * of the target: a signal to the keeper's pid does not reach the target, and a
 * signal to the group also stops the keeper (probed 2026-11-27, #6077). It
 * costs one more exec of `sh`.
 */
export const REPORTING_KEEPER = keeper(
  `exec /bin/sh -c 'echo $$ >&4; exec 4>&-; exec "$@"' sh "$@"`,
);

function keeper(target: string): string {
  return `
kill -0 -$$ 2>/dev/null || { echo 'keeper: start me detached' >&2; exit 126; }
grace=$1; shift
(
  trap '' TERM
  while read -r _; do :; done <&3
  kill -TERM -$$; sleep "$grace"; kill -KILL -$$
) </dev/null >/dev/null 2>&1 4>&- 5>&- &
wpid=$!
exec 3<&-
trap : TERM INT HUP
{ (exec 2>&9 9>&-; ${target}); st=$?; } 9>&2 2>/dev/null
kill -KILL "$wpid" 2>/dev/null
trap - TERM INT HUP
[ "$st" -gt 128 ] && kill -"$((st - 128))" $$
exit "$st"
`;
}

/** The variables that `sh` adds to the environment of its children. */
const SHELL_VARIABLES = ['PWD', 'SHLVL'] as const;

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
