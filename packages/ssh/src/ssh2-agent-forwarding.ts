/**
 * Every use of the internals of ssh2 1.17.0 for agent forwarding by the
 * client. ssh2 is pinned exactly; re-check each line below on a version bump.
 *
 * Why: OpenSSH's ForwardAgent yes sends auth-agent-req@openssh.com on each
 * session with no reply wanted (ssh.c:2204 of OpenSSH 10.0p1). sshd grants
 * only the first request of a connection, answers each later one with a
 * failure, and gives the one socket to every session (session.c:2166-2185,
 * :1085-1087). ssh2 instead sends the request with a reply wanted, so a
 * refusal would reject the session, and only on the first session of a
 * client. This module sends the request itself, and leaves ssh2's request
 * off (no `agentForward`).
 *
 * - lib/client.js:219-224, :254: `agent` must be a BaseAgent
 *   (lib/agent.js:1110), and becomes `_agent`.
 * - lib/client.js:1995-2006: an auth-agent@openssh.com channel is accepted
 *   only while `_agentFwdEnabled` is true, and is piped both ways to the
 *   stream of `_agent.getStream`. reqAgentFwd (:1794-1823), the only other
 *   reader, runs only with `agentForward`.
 * - lib/client.js:249, :534-563, :1643-1659: `_chanMgr` (lib/utils.js:124-
 *   165, ChannelManager) holds the callback of each channel that the client
 *   opens, with its `type` ('session' for exec and shell). The confirmation
 *   of the server calls it with no error and the Channel, whose
 *   `outgoing.id` is the channel number of the server; exec and shell then
 *   send their requests in the same tick (:1192-1308).
 * - lib/protocol/Protocol.js:1446-1462: `_protocol.openssh_agentForward(id,
 *   wantReply)`.
 */
import type { Duplex } from 'node:stream';

import ssh2, { type ConnectConfig } from 'ssh2';

type OpenedCallback = (
  error: unknown,
  channel: { readonly outgoing: { readonly id: number } },
) => void;

declare module 'ssh2' {
  interface Client {
    _agentFwdEnabled: boolean;
    readonly _chanMgr: { add(value: unknown): number };
    readonly _protocol: {
      openssh_agentForward(channel: number, wantReply: boolean): void;
    };
  }
}

/** The option of `connect` that lets ssh2 join each auth-agent@openssh.com channel to a new connection of `open`. */
export function agentForwardingOptions(
  open: () => Promise<Duplex>,
): Pick<ConnectConfig, 'agent'> {
  return { agent: new ForwardedAgent(open) };
}

/** Agent forwarding on a connection; stop() turns it off for each later session and refuses each later agent channel. */
export interface AgentForwarding {
  stop(): void;
}

/** Makes each session of the connection ask for agent forwarding first, with no reply wanted, and accepts the agent channels. Call it after `connect`, which creates the channel manager. */
export function requestAgentForwardingOnEachSession(
  connection: ssh2.Client,
): AgentForwarding {
  connection._agentFwdEnabled = true;
  const manager = connection._chanMgr;
  const add = manager.add.bind(manager);
  manager.add = (value: unknown): number => {
    if (!isSessionCallback(value)) return add(value);
    const opened: OpenedCallback = (error, channel) => {
      if (error === undefined) {
        connection._protocol.openssh_agentForward(channel.outgoing.id, false);
      }
      value(error, channel);
    };
    return add(Object.assign(opened, { type: value.type }));
  };
  return {
    stop() {
      manager.add = add;
      connection._agentFwdEnabled = false;
    },
  };
}

function isSessionCallback(
  value: unknown,
): value is OpenedCallback & { readonly type: 'session' } {
  return (
    typeof value === 'function' && 'type' in value && value.type === 'session'
  );
}

// ssh2 asks this agent only for a stream; the signers of the auth methods go
// to ssh2 through their own agent.
class ForwardedAgent extends ssh2.BaseAgent {
  readonly #open: () => Promise<Duplex>;

  constructor(open: () => Promise<Duplex>) {
    super();
    this.#open = open;
  }

  getIdentities(callback: (error: Error | undefined) => void): void {
    callback(new Error('ssh: the forwarded agent lists no keys'));
  }

  sign(
    _key: unknown,
    _data: Buffer,
    options: unknown,
    callback?: (error: Error | undefined) => void,
  ): void {
    const done = typeof options === 'function' ? options : callback;
    done?.(new Error('ssh: the forwarded agent signs nothing'));
  }

  // ssh2 rejects the channel at an error, and pipes the channel and the
  // stream both ways; it listens for no error of the stream.
  override getStream(
    callback: (error: Error | undefined, stream?: Duplex) => void,
  ): void {
    this.#open().then(
      (stream) => {
        stream.on('error', () => stream.destroy());
        callback(undefined, stream);
      },
      (error: unknown) =>
        callback(Error.isError(error) ? error : new Error(String(error))),
    );
  }
}
