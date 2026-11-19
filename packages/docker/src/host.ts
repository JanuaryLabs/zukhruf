import { UnsupportedHostError } from './errors.ts';

/**
 * A host, parsed by its kind. An ssh:// host splits as the connection helper
 * of the Docker CLI splits it (cli/connhelper of docker/cli): the destination
 * for ssh, and the engine socket on the SSH server that a path of the host
 * names (`ssh://user@host/<path>` runs `docker --host=unix://<path> system
 * dial-stdio` there). With no path, the Docker CLI on the server selects the
 * engine. OpenSSH takes no path in an ssh:// destination.
 */
export type ParsedHost =
  { kind: 'unix' | 'npipe'; host: string; socketPath: string } | SshHost;

/** An ssh:// host: the destination for ssh, and the engine socket that its path names, if it has one. */
export interface SshHost {
  kind: 'ssh';
  host: string;
  destination: string;
  socketPath: string | undefined;
}

/** Parses a unix://, npipe:// or ssh:// host. Each other host is an UnsupportedHostError. */
export function parseHost(host: string): ParsedHost {
  if (host.startsWith('unix://')) {
    const socketPath = host.slice('unix://'.length);
    if (socketPath) return { kind: 'unix', host, socketPath };
  } else if (host.startsWith('npipe://')) {
    // npipe:////./pipe/docker_engine is the pipe \\.\pipe\docker_engine.
    const socketPath = host.slice('npipe://'.length).replaceAll('/', '\\');
    if (socketPath) return { kind: 'npipe', host, socketPath };
  } else if (host.startsWith('ssh://')) {
    const url = URL.parse(host);
    if (url?.hostname) return sshHost(host, url);
  }
  throw new UnsupportedHostError(host);
}

// A path of only slashes names no socket, as strings.Trim(sp.Path, "/") of
// the Docker CLI.
function sshHost(host: string, url: URL): SshHost {
  const path = decodeURIComponent(url.pathname);
  if (path.replaceAll('/', '') === '') {
    return { kind: 'ssh', host, destination: host, socketPath: undefined };
  }
  url.pathname = '';
  return { kind: 'ssh', host, destination: url.href, socketPath: path };
}
