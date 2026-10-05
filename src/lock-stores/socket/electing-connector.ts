import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { LeaderElection } from '../../leader-election/leader-election.ts';
import type { Leadership } from '../../leader-election/leadership.ts';
import type { ClientConnection, Connector } from '../remote/connector.ts';
import type { LockRequest, LockResponse } from '../remote/protocol.ts';
import { SocketConnection } from './socket-connection.ts';

export interface ElectingConnectorOptions {
	socketPath: string;
	election: LeaderElection;
	pollInterval: number;
	/** Starts serving for a term this process just won. */
	serve(leadership: Leadership): Promise<void>;
	connected(): void;
}

/**
 * Reaches the leader's socket, and when nobody serves it, campaigns to become
 * the leader. Never gives up: a lost leader is always replaced by a candidate.
 */
export class ElectingConnector implements Connector {
	readonly #options: ElectingConnectorOptions;

	constructor(options: ElectingConnectorOptions) {
		this.#options = options;
	}

	async connect(): Promise<ClientConnection> {
		const { socketPath, election, pollInterval, serve, connected } = this.#options;
		for (;;) {
			const socket = await reach(socketPath);
			if (socket) {
				connected();
				return new SocketConnection<LockRequest, LockResponse>(socket);
			}
			const leadership = await election.campaign({ timeout: pollInterval });
			if (leadership) await serve(leadership);
			else await delay(pollInterval);
		}
	}
}

/** Resolves `undefined` when nothing listens yet (no file, or a dead leader's file). */
function reach(socketPath: string): Promise<Socket | undefined> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		const fail = () => {
			socket.destroy();
			resolve(undefined);
		};
		socket.once('error', fail);
		socket.once('connect', () => {
			socket.off('error', fail);
			resolve(socket);
		});
	});
}
