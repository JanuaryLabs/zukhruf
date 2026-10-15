import { randomUUID } from 'node:crypto';

import { untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';

import type { ConnectionSupervisor } from '../connection/connection-supervisor.ts';
import { KeyHold } from '../key-lock/key-hold.ts';
import type { KeyLocks } from '../key-lock/key-locks.ts';
import {
  type FlightRequest,
  type FlightResponse,
  type Outcome,
  isFlightResponse,
} from '../protocol/flight-protocol.ts';

/** This process leads a flight: it runs the work and lands the outcome. */
export interface Lead {
  readonly token: FencingToken;
  /** Aborts with a `LeaseLostError` once the flight is no longer this leader's. */
  readonly signal: AbortSignal;
  /** Ends the flight with `outcome` for every joiner. Kept and sent again until a coordinator acknowledges it. */
  land(outcome: Outcome): void;
  /** The work settled. The key's lock waits for this, so call it on every path, also when the work never landed. */
  ended(): void;
}

/** How the coordinator answered a run for good. */
export type Answer =
  | { kind: 'lead'; lead: Lead }
  | { kind: 'landed'; outcome: Outcome }
  | { kind: 'interrupted' };

export interface FlightClientOptions {
  locks: KeyLocks;
  /** Whether no coordinator of a newer term than the one that minted `token` has been elected. */
  isCurrentTerm(token: FencingToken): Promise<boolean>;
}

export interface RunRequest {
  signal?: AbortSignal | undefined;
  onJoin?: (() => void) | undefined;
}

/** Keeps only what settles the caller's promise; the caller keeps the promise. */
interface Pending extends Pick<
  PromiseWithResolvers<Answer>,
  'resolve' | 'reject'
> {
  key: string;
  onJoin: (() => void) | undefined;
  delivery: Delivery;
  /** The flight that the coordinator said this run joined, so after a lost connection it rejoins that flight only. */
  flight: string | undefined;
}

/**
 * `queued` waits for a connection, and `sent` went out on the open one.
 * `locking` was told to lead, and waits for its key's lock: it leads only once
 * it holds the lock, so until then it is still a run that waits.
 */
type Delivery =
  | { kind: 'queued' }
  | { kind: 'sent' }
  | { kind: 'locking'; stop: AbortController };

interface Held {
  key: string;
  token: FencingToken;
  lease: LeaseController;
  hold: KeyHold;
  /** The outcome this leader landed, kept until a coordinator acknowledges it. */
  landing: Outcome | undefined;
}

/**
 * Sends runs to the coordinator over a supervised connection. When the
 * connection is replaced, it reasserts the flights this process leads, sends
 * their landings again, and sends again the runs that wait for an answer. A
 * run that had joined a flight rejoins that flight only, so it never leads; a
 * run that got no answer had joined nothing, and goes again as a plain run.
 */
export class FlightClient {
  readonly #link: ConnectionSupervisor<FlightRequest>;
  readonly #locks: KeyLocks;
  readonly #isCurrentTerm: (token: FencingToken) => Promise<boolean>;
  readonly #pending = new Map<string, Pending>();
  readonly #held = new Map<string, Held>();
  /** Wakes `close` each time a flight this process leads is acknowledged or lost. */
  readonly #released = new Set<() => void>();

  constructor(
    link: ConnectionSupervisor<FlightRequest>,
    { locks, isCurrentTerm }: FlightClientOptions,
  ) {
    this.#link = link;
    this.#locks = locks;
    this.#isCurrentTerm = isCurrentTerm;
    link.on('connected', () => this.#resume());
    // A message this client cannot read answers nothing it waits for.
    link.on('message', (message) => {
      if (isFlightResponse(message)) this.#receive(message);
    });
    link.on('disconnected', () => this.#interrupt());
    link.on('failed', (error) => this.#fail(error));
  }

  async run(key: string, { signal, onJoin }: RunRequest): Promise<Answer> {
    signal?.throwIfAborted();
    if (this.#link.status === 'closed') {
      throw new Error('This single flight is closed.');
    }
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<Answer>();
    const pending: Pending = {
      key,
      onJoin,
      delivery: { kind: 'queued' },
      flight: undefined,
      resolve,
      reject,
    };
    this.#pending.set(id, pending);
    this.#updateRef();
    this.#link.open();
    this.#dispatch(id, pending);
    try {
      return await untilAborted(promise, signal);
    } catch (error) {
      if (signal?.aborted) {
        this.#withdraw(id);
        this.#abandon(id);
      }
      throw error;
    }
  }

  /**
   * Disconnects for good, once every landing reached a coordinator: a landing
   * is the outcome its joiners wait for. The coordinator then interrupts the
   * flights this process still leads without an outcome.
   */
  async close() {
    while ([...this.#held.values()].some(({ landing }) => landing)) {
      await new Promise<void>((resolve) => this.#released.add(resolve));
    }
    const closing = this.#link.close();
    for (const id of [...this.#pending.keys()]) {
      this.#take(id)?.reject(new Error('This single flight is closed.'));
    }
    // The coordinator interrupts the flights of a closed connection, so they need nothing more from this process.
    for (const id of [...this.#held.keys()]) this.#release(id);
    await closing;
  }

  #dispatch(id: string, pending: Pending) {
    const { key, flight } = pending;
    const request: FlightRequest =
      flight === undefined
        ? { op: 'run', id, key }
        : { op: 'run', id, key, flight };
    if (this.#link.send(request)) pending.delivery = { kind: 'sent' };
  }

  /**
   * The caller gave up. A run the coordinator may have heard is withdrawn;
   * one that already leads is not pending any more, so its flight runs on.
   * A run that waits for its key's lock leads at the coordinator, so the
   * cancel interrupts that flight: its work never started.
   */
  #withdraw(id: string) {
    const pending = this.#take(id);
    if (pending && pending.delivery.kind !== 'queued') {
      this.#link.send({ op: 'cancel', id });
    }
  }

  /**
   * The caller gave up although its run had led: the abort won the race with
   * the answer, so nobody runs the work. The flight is interrupted, and the
   * key's lock goes, instead of leading for the life of the process.
   */
  #abandon(id: string) {
    const held = this.#held.get(id);
    if (!held) return;
    this.#link.send({ op: 'cancel', id });
    this.#release(id);
    held.hold.workEnded();
  }

  /**
   * Told to lead: the run leads only once it holds its key's lock, so no
   * other process runs the key's work beside it. A grant of an older term is
   * stale: the coordinator that minted it is gone, and its successor may have
   * let another run lead. That run goes again as a plain run.
   */
  async #lock(
    id: string,
    pending: Pending,
    token: FencingToken,
    stop: AbortSignal,
  ) {
    try {
      using locked = new DisposableStack();
      locked.use(await this.#locks.acquire(pending.key, stop));
      const current = await this.#isCurrentTerm(token);
      if (stop.aborted) return;
      if (!current) {
        locked.dispose();
        pending.delivery = { kind: 'queued' };
        this.#dispatch(id, pending);
        return;
      }
      this.#take(id);
      pending.resolve({
        kind: 'lead',
        lead: this.#hold(id, pending.key, token, new KeyHold(locked.move())),
      });
    } catch (error) {
      // An abort is the run's own end: it was answered, withdrawn or sent again.
      if (stop.aborted) return;
      this.#take(id)?.reject(error);
      this.#link.send({ op: 'cancel', id });
    }
  }

  #hold(id: string, key: string, token: FencingToken, hold: KeyHold): Lead {
    const held: Held = {
      key,
      token,
      lease: new LeaseController(key),
      hold,
      landing: undefined,
    };
    this.#held.set(id, held);
    return {
      token,
      signal: held.lease.signal,
      land: (outcome) => {
        // A lost flight is no longer this leader's to land.
        if (this.#held.get(id) !== held || held.landing) return;
        held.landing = outcome;
        this.#updateRef();
        this.#link.send({ op: 'land', id, outcome });
      },
      ended: () => hold.workEnded(),
    };
  }

  /** The flight of `id` is no longer this leader's, so its lease is told and nothing reasserts it. */
  #lose(id: string) {
    const held = this.#held.get(id);
    if (!held) return;
    this.#release(id);
    held.lease.lose();
  }

  /** The flight of `id` needs nothing more from this process. */
  #release(id: string) {
    this.#held.get(id)?.hold.flightEnded();
    this.#held.delete(id);
    this.#updateRef();
    const waiting = [...this.#released];
    this.#released.clear();
    for (const wake of waiting) wake();
  }

  #receive(response: FlightResponse) {
    switch (response.op) {
      case 'lead': {
        // A run withdrawn meanwhile sent `cancel`, which interrupts the flight at the coordinator.
        const pending = this.#pending.get(response.id);
        if (!pending) return;
        const stop = new AbortController();
        pending.delivery = { kind: 'locking', stop };
        // The first try of the lock is synchronous, here: only microtasks separate it from the work.
        void this.#lock(
          response.id,
          pending,
          FencingToken.parse(response.token)!,
          stop.signal,
        );
        return;
      }
      case 'joined': {
        const pending = this.#pending.get(response.id);
        if (!pending) return;
        const first = pending.flight === undefined;
        pending.flight = response.flight;
        if (first) this.#tellJoined(response.id, pending);
        return;
      }
      case 'landed':
        this.#take(response.id)?.resolve({
          kind: 'landed',
          outcome: response.outcome,
        });
        return;
      case 'interrupted':
        this.#take(response.id)?.resolve({ kind: 'interrupted' });
        return;
      case 'ack': {
        // The joiners have the outcome, so there is nothing left to reassert, and no later loss of the lease.
        const held = this.#held.get(response.id);
        if (!held?.landing) return;
        this.#release(response.id);
        held.lease.end();
        return;
      }
      case 'rejected':
        this.#lose(response.id);
        return;
      case 'unsupported':
        this.#take(response.id)?.reject(
          new Error("The single flight's coordinator does not know a run."),
        );
        return;
    }
  }

  /** The caller's `onJoin` runs once per run; a throw from it fails that run only. */
  #tellJoined(id: string, pending: Pending) {
    try {
      pending.onJoin?.();
    } catch (error) {
      this.#withdraw(id);
      pending.reject(error);
    }
  }

  /** A new connection: reassert the flights this process leads and land them again, then send what waits. */
  #resume() {
    // A new connection starts with its adapter's default, which may not match whether this client waits.
    this.#updateRef();
    for (const [id, { key, token, landing }] of this.#held) {
      this.#link.send({ op: 'reassert', id, key, token: token.toString() });
      if (landing) this.#link.send({ op: 'land', id, outcome: landing });
    }
    for (const [id, pending] of this.#pending) {
      if (pending.delivery.kind === 'queued') this.#dispatch(id, pending);
    }
  }

  /**
   * Nothing sent on the lost connection will be answered, so every run goes
   * again on the next one. A run that waits for its key's lock had not led
   * yet: the next coordinator may not know its flight, so it goes again too.
   */
  #interrupt() {
    for (const pending of this.#pending.values()) {
      if (pending.delivery.kind === 'locking') pending.delivery.stop.abort();
      pending.delivery = { kind: 'queued' };
    }
  }

  /** No coordinator heard the reassertions, so the flights this process leads may be interrupted already. */
  #fail(error: unknown) {
    for (const id of [...this.#held.keys()]) this.#lose(id);
    for (const id of [...this.#pending.keys()]) this.#take(id)?.reject(error);
  }

  /** Removes a run that is about to be answered, so a late answer for it is ignored. */
  #take(id: string): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    if (pending.delivery.kind === 'locking') pending.delivery.stop.abort();
    this.#pending.delete(id);
    this.#updateRef();
    return pending;
  }

  /** A run waiting for its answer, or a landing not yet acknowledged, keeps the process alive. */
  #updateRef() {
    const landing = [...this.#held.values()].some(({ landing }) => landing);
    if (this.#pending.size > 0 || landing) this.#link.ref();
    else this.#link.unref();
  }
}
