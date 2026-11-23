import type { ClientConnection, ClientConnector } from '../remote/connector.ts';
import type { SessionDirectory, SessionRecord } from './session-directory.ts';

/**
 * Records the session of a store before its first connection, so each request
 * that a leader can grant comes after the record, and the next leader finds
 * the session (ADR 0033). The record is made once and lasts until the store
 * is disposed; a record that failed is tried again by the next connect. The
 * supervisor connects once at a time, and its close waits for a connect on
 * its way, so a disposal never meets a record that is being made.
 */
export class RecordingConnector implements ClientConnector, AsyncDisposable {
  readonly #connector: ClientConnector;
  #state: Unrecorded | Recorded;

  constructor(
    sessions: SessionDirectory,
    session: string,
    leaseDuration: number,
    connector: ClientConnector,
  ) {
    this.#connector = connector;
    this.#state = new Unrecorded(() => sessions.record(session, leaseDuration));
  }

  async connect(signal: AbortSignal): Promise<ClientConnection | undefined> {
    signal.throwIfAborted();
    this.#state = await this.#state.record();
    signal.throwIfAborted();
    return this.#connector.connect(signal);
  }

  /** Deletes the record, then frees the presence. Call it after the client closed: then this session holds no key. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#state[Symbol.asyncDispose]();
  }
}

/** No record yet: before the first connect, or after one whose record failed. */
class Unrecorded implements AsyncDisposable {
  readonly #make: () => Promise<SessionRecord>;

  constructor(make: () => Promise<SessionRecord>) {
    this.#make = make;
  }

  async record(): Promise<Recorded> {
    return new Recorded(await this.#make());
  }

  async [Symbol.asyncDispose]() {}
}

/** The session has its record and its presence. */
class Recorded implements AsyncDisposable {
  readonly #record: SessionRecord;

  constructor(record: SessionRecord) {
    this.#record = record;
  }

  async record(): Promise<Recorded> {
    return this;
  }

  async [Symbol.asyncDispose]() {
    await this.#record[Symbol.asyncDispose]();
  }
}
