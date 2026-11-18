import { Latch } from '@zukhruf/async';

import type { HostKeyCallback } from './client.ts';
import type { JumpHost } from './config.ts';
import { KeyError, KnownHosts, RevokedError } from './knownhosts.ts';
import type { PublicKey } from './public-key.ts';

type PolicyHost = Pick<
  JumpHost,
  | 'hostname'
  | 'port'
  | 'hostKeyAlias'
  | 'knownHostsFiles'
  | 'strictHostKeyChecking'
  | 'hashKnownHosts'
  | 'hostKeyAlgorithms'
>;

/**
 * OpenSSH's StrictHostKeyChecking around the known hosts of one host (ADR
 * 0005), as `check_host_key` in sshconnect.c of OpenSSH 10.5p1 applies it,
 * with no prompt. The name is the HostKeyAlias as it is, or the hostname with
 * the port (`get_hostfile_hostname_ipaddr` in sshconnect.c).
 */
export class HostKeyPolicy {
  readonly #host: PolicyHost;
  readonly #knownHosts: KnownHosts;
  readonly #name: { readonly hostname: string; readonly port: number };
  /** Opens at the first check that lets the key through: with the error of a changed or revoked key that StrictHostKeyChecking no let through, else undefined. */
  readonly #trusted = new Latch<Error | undefined>();

  private constructor(host: PolicyHost, knownHosts: KnownHosts) {
    this.#host = host;
    this.#knownHosts = knownHosts;
    // KnownHosts looks up a name with no port for port 22.
    this.#name =
      host.hostKeyAlias === undefined
        ? { hostname: host.hostname, port: host.port }
        : { hostname: host.hostKeyAlias, port: 22 };
  }

  /** Reads the user files, then the global files. */
  static async read(host: PolicyHost): Promise<HostKeyPolicy> {
    const { user, global } = host.knownHostsFiles;
    return new HostKeyPolicy(host, await KnownHosts.read([...user, ...global]));
  }

  /** The host key algorithms of the config, with those of the known keys first (`order_hostkeyalgs` in sshconnect2.c). */
  algorithms(): string[] {
    const { hostname, port } = this.#name;
    return this.#knownHosts.hostKeyAlgorithms(
      hostname,
      port,
      this.#host.hostKeyAlgorithms,
    );
  }

  /** After a handshake: the error of a changed or revoked key that StrictHostKeyChecking no let through, so the client runs in OpenSSH's restricted mode; undefined for a trusted key. */
  restriction(): Promise<Error | undefined> {
    return this.#trusted.wait();
  }

  readonly check: HostKeyCallback = async (_hostname, _port, key) => {
    const { hostname, port } = this.#name;
    try {
      this.#knownHosts.check(hostname, port, key);
    } catch (error) {
      this.#trusted.open(await this.#refused(error, key));
      return;
    }
    this.#trusted.open(undefined);
  };

  /** Throws the error unless the policy lets the key through; returns the error of a key that only the restricted mode lets through. */
  async #refused(error: unknown, key: PublicKey): Promise<Error | undefined> {
    const policy = this.#host.strictHostKeyChecking;
    const unknown = error instanceof KeyError && error.want.length === 0;
    if (unknown && (policy === 'accept-new' || policy === 'no')) {
      await this.#add(key);
      return undefined;
    }
    const changed = error instanceof KeyError || error instanceof RevokedError;
    if (changed && policy === 'no') return error;
    throw error;
  }

  /** Appends to the first user file. With no user file, OpenSSH fails to add, logs it and connects (`add_host_to_hostfile` in check_host_key). */
  async #add(key: PublicKey): Promise<void> {
    if (this.#host.knownHostsFiles.user.length === 0) return;
    const { hostname, port } = this.#name;
    await this.#knownHosts.add(hostname, port, key, {
      hash: this.#host.hashKnownHosts,
    });
  }
}
