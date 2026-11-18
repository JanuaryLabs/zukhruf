import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

import { AgentClient } from './agent.ts';
import type { AuthMethod } from './client.ts';
import type { JumpHost } from './config.ts';
import {
  PassphraseMissingError,
  PrivateKey,
  type Signer,
} from './private-key.ts';
import type { PublicKey } from './public-key.ts';

type IdentityHost = Pick<
  JumpHost,
  'identityAgent' | 'identityFiles' | 'identitiesOnly'
>;

interface IdentityFile {
  readonly publicKey: PublicKey | undefined;
  /** Undefined for an encrypted file: the client never asks for a passphrase. */
  readonly privateKey: PrivateKey | undefined;
}

/**
 * The publickey auth of a host, in OpenSSH's order (`pubkey_prepare` in
 * sshconnect2.c of OpenSSH 10.5p1): the keys of the agent in its order, with
 * IdentitiesOnly only those of an identity file, then the identity files that
 * the agent lacks. An encrypted file is skipped, as in batch mode (ADR 0004).
 * The dispose closes the connection to the agent.
 */
export class Identities implements AsyncDisposable {
  readonly #host: IdentityHost;
  readonly #agent = new DisposableStack();

  constructor(host: IdentityHost) {
    this.#host = host;
  }

  readonly method: AuthMethod = {
    type: 'publickey',
    signers: () => this.#signers(),
  };

  async #signers(): Promise<Signer[]> {
    const files = (
      await Promise.all(this.#host.identityFiles.map(readIdentityFile))
    ).filter((file) => file !== undefined);
    const inFile = (key: PublicKey): boolean =>
      files.some((file) => file.publicKey?.equals(key) === true);
    const agent = (await this.#agentSigners()).filter(
      (signer) => !this.#host.identitiesOnly || inFile(signer.publicKey),
    );
    const held = (key: PublicKey | undefined): boolean =>
      agent.some((signer) => key !== undefined && signer.publicKey.equals(key));
    return [
      ...agent,
      ...files
        .filter((file) => !held(file.publicKey))
        .flatMap(({ privateKey }) => privateKey ?? []),
    ];
  }

  /** No agent at the socket is no agent keys, as OpenSSH goes on without one. */
  async #agentSigners(): Promise<Signer[]> {
    const path = this.#host.identityAgent;
    if (path === undefined) return [];
    const socket = this.#agent.adopt(connect(path), (each) => each.destroy());
    try {
      await once(socket, 'connect');
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ECONNREFUSED')) {
        return [];
      }
      throw error;
    }
    return new AgentClient(socket).signers();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#agent.dispose();
  }
}

/** A file that is missing, or that the package cannot read as a key, offers nothing, as OpenSSH goes on past it. */
async function readIdentityFile(
  file: string,
): Promise<IdentityFile | undefined> {
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    const privateKey = PrivateKey.parse(data);
    return { publicKey: privateKey.publicKey, privateKey };
  } catch (error) {
    if (error instanceof PassphraseMissingError) {
      return { publicKey: error.publicKey, privateKey: undefined };
    }
    return undefined;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Error.isError(error) && 'code' in error && error.code === code;
}
