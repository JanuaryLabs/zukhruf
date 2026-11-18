/** One jump host of a ProxyJump value: `[user@]host[:port]` or `ssh://[user@]host[:port]`. */
export interface Hop {
  readonly host: string;
  readonly user: string | undefined;
  readonly port: number | undefined;
}

/** The options of OpenSSH's ssh that take an argument (`getopt` in ssh.c of OpenSSH 9.6p1 and 10.5p1). */
const optionsWithArgument = new Set('BDEFIJLOPQRSWbceilmopw');

/**
 * The jump hosts of the ProxyJump value that ssh -G prints, in order, each
 * with the user and the port that the value gives (`parse_jump` in
 * readconf.c and `parse_user_host_port` in misc.c of OpenSSH 10.5p1).
 */
export function parseProxyJump(value: string): Hop[] {
  return value.split(',').map((spec) => {
    const uri = spec.startsWith('ssh://');
    let rest = uri ? spec.slice('ssh://'.length).replace(/\/$/, '') : spec;
    const at = rest.lastIndexOf('@');
    let user = at === -1 ? undefined : rest.slice(0, at);
    if (uri && user !== undefined) {
      user = decodeURIComponent(user.split(';')[0] ?? '');
    }
    rest = rest.slice(at + 1);
    const bracket = rest.startsWith('[') ? rest.indexOf(']') : -1;
    const hostEnd = bracket === -1 ? rest.indexOf(':') : bracket + 1;
    const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
    const port = hostEnd === -1 ? '' : rest.slice(hostEnd + 1);
    return {
      host: host.replace(/^\[(.*)\]$/, '$1'),
      user,
      port: port === '' ? undefined : Number(port),
    };
  });
}

/**
 * The flags of the ssh that OpenSSH starts for a jump host (ssh.c of OpenSSH
 * 10.5p1, lines 1292-1340): `-l` and `-p` from the ProxyJump value, and the
 * caller's `-F <file>` when it gave one. No other flag of the caller.
 */
export function jumpHostFlags(
  hop: Hop,
  callerFlags: readonly string[],
): string[] {
  const file = configFile(callerFlags);
  return [
    ...(hop.user === undefined ? [] : ['-l', hop.user]),
    ...(hop.port === undefined ? [] : ['-p', String(hop.port)]),
    ...(file === undefined ? [] : ['-F', file]),
  ];
}

/** The last `-F` of the flags, read as ssh's getopt reads them: `-F file`, `-Ffile`, or at the end of a group such as `-qF file`. */
function configFile(flags: readonly string[]): string | undefined {
  let file: string | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index] ?? '';
    if (flag === '--') break;
    if (!flag.startsWith('-')) continue;
    for (let letter = 1; letter < flag.length; letter++) {
      const option = flag.charAt(letter);
      if (!optionsWithArgument.has(option)) continue;
      const argument =
        letter + 1 < flag.length ? flag.slice(letter + 1) : flags[++index];
      if (option === 'F') file = argument;
      break;
    }
  }
  return file;
}
