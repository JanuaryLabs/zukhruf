import { UnsupportedHostError } from './errors.ts';

/** A host, parsed by its kind. */
export type ParsedHost =
  | { kind: 'unix' | 'npipe'; host: string; socketPath: string }
  | { kind: 'ssh'; host: string; url: URL };

/** Parses a unix://, npipe:// or ssh:// host. Each other host is an UnsupportedHostError. */
export function parseHost(host: string): ParsedHost {
  if (host.startsWith('unix://')) {
    const socketPath = host.slice('unix://'.length);
    if (socketPath) return { kind: 'unix', host, socketPath };
  } else if (host.startsWith('npipe://')) {
    // npipe:////./pipe/docker_engine is the pipe \\.\pipe\docker_engine.
    const socketPath = host.slice('npipe://'.length).replaceAll('/', '\\');
    if (socketPath) return { kind: 'npipe', host, socketPath };
  } else if (host.startsWith('ssh://') && URL.canParse(host)) {
    const url = new URL(host);
    if (url.hostname) return { kind: 'ssh', host, url };
  }
  throw new UnsupportedHostError(host);
}
