import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { Duplex, type Readable, type Writable } from 'node:stream';

import type { JumpHost } from './config.ts';
import { parseProxyJump } from './proxy-jump.ts';
import type { Environment } from './ssh-g.ts';

type ProxyProcess = ChildProcessByStdio<Writable, Readable, null>;

/**
 * Runs a ProxyCommand as OpenSSH does (ADR 0010): `<SHELL> -c "exec
 * <command>"` with its tokens expanded, SHELL of the environment or /bin/sh,
 * the environment as its whole environment, and its stderr left to the Node
 * process (`ssh_proxy_connect` in sshconnect.c of OpenSSH 10.5p1). Its stdin
 * and stdout are the transport.
 */
export function startProxyCommand(
  command: string,
  host: JumpHost,
  environment: Environment,
): Duplex {
  const expanded = expandProxyCommand(`exec ${command}`, host);
  const shell = environment['SHELL'] || '/bin/sh';
  return new ProxyCommandTransport(
    spawn(shell, ['-c', expanded], {
      env: environment,
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
}

/** `expand_proxy_command` in ssh.c and `percent_expand` in misc.c of OpenSSH 10.5p1: %h, %k, %n, %p, %r and %%; any other token fails, as OpenSSH fails. */
function expandProxyCommand(command: string, host: JumpHost): string {
  const original = originalHost(host.destination);
  const tokens: Readonly<Record<string, string>> = {
    '%': '%',
    h: host.hostname,
    k: host.hostKeyAlias ?? original,
    n: original,
    p: String(host.port),
    r: host.user,
  };
  return command.replaceAll(/%(.?)/gs, (_match, key: string) => {
    const value = tokens[key];
    if (value === undefined) {
      throw new Error(
        key === ''
          ? `ssh: the ProxyCommand ${command} ends with a lone %`
          : `ssh: the ProxyCommand ${command} has the unknown token %${key}`,
      );
    }
    return value;
  });
}

/** The host of the destination as the command line gave it, OpenSSH's `host_arg` (ssh.c): the host of an `ssh://` URI, or the part after the last `@`. */
function originalHost(destination: string): string {
  if (destination.startsWith('ssh://')) {
    const [hop] = parseProxyJump(destination);
    if (hop !== undefined) return hop.host;
  }
  return destination.slice(destination.lastIndexOf('@') + 1);
}

/**
 * The stdout and the stdin of a ProxyCommand as one stream. The end of its
 * stdout ends the transport, as OpenSSH reads the end of the connection
 * (`client_process_net_input` in clientloop.c). When the client ends its side
 * or destroys the transport, the command gets SIGHUP and nothing waits for it
 * to exit (`ssh_kill_proxy_command` in sshconnect.c).
 */
class ProxyCommandTransport extends Duplex {
  readonly #child: ProxyProcess;

  constructor(child: ProxyProcess) {
    super({ allowHalfOpen: false });
    this.#child = child;
    child.once('error', (error) => this.destroy(error));
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.once('end', () => this.push(null));
    child.stdout.once('error', (error) => this.destroy(error));
    // A command that exits closes its stdin, so a write after it fails with
    // EPIPE; the end of its stdout ends the transport.
    child.stdin.on('error', () => undefined);
    this.once('finish', () => this.destroy());
  }

  override _read(): void {
    this.#child.stdout.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#child.stdin.write(chunk, () => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#child.stdin.end(() => {
      this.#hangUp();
      callback();
    });
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#hangUp();
    this.#child.stdout.destroy();
    this.#child.stdin.destroy();
    callback(error);
  }

  #hangUp(): void {
    const child = this.#child;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGHUP');
    }
    child.unref();
  }
}
