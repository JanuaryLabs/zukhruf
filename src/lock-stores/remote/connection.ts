export interface ConnectionHandlers<Incoming> {
	message(message: Incoming): void;
	/** Called once, when the peer is gone. */
	close(): void;
}

/** A message channel to one peer. Adapters wrap IPC channels and sockets. */
export interface Connection<Outgoing, Incoming> {
	/** Rejects when the message cannot be delivered because the peer is gone. */
	send(message: Outgoing): Promise<void>;
	listen(handlers: ConnectionHandlers<Incoming>): void;
	/** Keeps the process alive while its owner waits for a message. */
	ref(): void;
	/** Lets the process exit; messages and closure are still reported while it runs. */
	unref(): void;
	close(): void;
}
