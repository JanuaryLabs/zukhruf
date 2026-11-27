import { randomUUID } from 'node:crypto';

import { RefCount, untilAborted } from '@zukhruf/async';
import { FencingToken } from '@zukhruf/fencing';
import { LeaseController } from '@zukhruf/lease';
import {
  type ConnectionSupervisor,
  PendingCalls,
  type TakenCall,
} from '@zukhruf/rpc';

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

type RunMessage = Extract<FlightRequest, { op: 'run' }>;

/** What a run that waits for its answer keeps beside its call. */
interface Run {
  onJoin: (() => void) | undefined;
  /**
   * Set once the run was told to lead, while it waits for its key's lock: it
   * leads only once it holds the lock, so until then it is still a run that
   * waits.
   */
  locking: AbortController | undefined;
}

interface Held {
  key: string;
  token: FencingToken;
  lease: LeaseController;
  hold: KeyHold;
  /** The outcome this leader landed, kept until a coordinator acknowledges it, and the hold that keeps the process alive until then. */
  landing: { outcome: Outcome; keepAlive: Disposable } | undefined;
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
  /** The runs that wait for their answer. A run that a lost connection cut off goes again: it leads or joins at the next coordinator. */
  readonly #calls: PendingCalls<RunMessage, Answer>;
  /** By id, each run of `#calls`. */
  readonly #runs = new Map<string, Run>();
  readonly #held = new Map<string, Held>();
  /** By key, the hold of the latest flight this process landed, until it lets its key's lock go. */
  readonly #landed = new Map<string, KeyHold>();
  /** Wakes `close` each time a flight this process leads is acknowledged or lost. */
  readonly #released = new Set<() => void>();
  /** Keeps the connection ref'd while a run waits for its answer or a landing waits for its acknowledgement. */
  readonly #refs: RefCount;

  constructor(
    link: ConnectionSupervisor<FlightRequest>,
    { locks, isCurrentTerm }: FlightClientOptions,
  ) {
    this.#link = link;
    this.#locks = locks;
    this.#isCurrentTerm = isCurrentTerm;
    this.#refs = new RefCount(link);
    this.#calls = new PendingCalls<RunMessage, Answer>(link, this.#refs);
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
    // This process still holds the key's lock for a flight it landed. The
    // coordinator would see the lock and park the run for one check of its
    // watch, so the run goes only once the lock is let go.
    const landed = this.#landed.get(key);
    if (landed) await untilAborted(landed.released(), signal);
    if (this.#link.status === 'closed') {
      throw new Error('This single flight is closed.');
    }
    const id = randomUUID();
    this.#runs.set(id, { onJoin, locking: undefined });
    const answer = this.#calls.add(id, { op: 'run', id, key }, 'resend');
    try {
      return await untilAborted(answer, signal);
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
    while (this.#held.values().some(({ landing }) => landing)) {
      await new Promise<void>((resolve) => this.#released.add(resolve));
    }
    const closing = this.#link.close();
    for (const id of [...this.#runs.keys()]) {
      this.#take(id)?.reject(new Error('This single flight is closed.'));
    }
    // The coordinator interrupts the flights of a closed connection, so they need nothing more from this process.
    for (const id of [...this.#held.keys()]) this.#release(id);
    await closing;
  }

  /**
   * The caller gave up. A run the coordinator may have heard is withdrawn;
   * one that already leads is not pending any more, so its flight runs on.
   * A run that waits for its key's lock leads at the coordinator, so the
   * cancel interrupts that flight: its work never started.
   */
  #withdraw(id: string): TakenCall<RunMessage, Answer> | undefined {
    const call = this.#take(id);
    if (call?.sent) this.#link.send({ op: 'cancel', id });
    return call;
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
    run: Run,
    key: string,
    token: FencingToken,
    stop: AbortSignal,
  ) {
    try {
      using locked = new DisposableStack();
      locked.use(await this.#locks.acquire(key, stop));
      const current = await this.#isCurrentTerm(token);
      if (stop.aborted) return;
      if (!current) {
        locked.dispose();
        run.locking = undefined;
        this.#calls.send(id);
        return;
      }
      this.#take(id)?.resolve({
        kind: 'lead',
        lead: this.#hold(id, key, token, new KeyHold(locked.move())),
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
        held.landing = { outcome, keepAlive: this.#refs.hold() };
        this.#landed.set(key, hold);
        void hold.released().then(() => {
          if (this.#landed.get(key) === hold) this.#landed.delete(key);
        });
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
    const held = this.#held.get(id);
    held?.hold.flightEnded();
    held?.landing?.keepAlive[Symbol.dispose]();
    this.#held.delete(id);
    const waiting = [...this.#released];
    this.#released.clear();
    for (const wake of waiting) wake();
  }

  #receive(response: FlightResponse) {
    switch (response.op) {
      case 'lead': {
        // A run withdrawn meanwhile sent `cancel`, which interrupts the flight at the coordinator.
        const request = this.#calls.get(response.id);
        const run = this.#runs.get(response.id);
        if (!request || !run) return;
        const stop = new AbortController();
        run.locking = stop;
        // The first try of the lock is synchronous, here: only microtasks separate it from the work.
        void this.#lock(
          response.id,
          run,
          request.key,
          FencingToken.parse(response.token)!,
          stop.signal,
        );
        return;
      }
      case 'joined': {
        const request = this.#calls.get(response.id);
        const run = this.#runs.get(response.id);
        if (!request || !run) return;
        this.#calls.update(response.id, {
          ...request,
          flight: response.flight,
        });
        if (request.flight === undefined) this.#tellJoined(response.id, run);
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
    }
  }

  /** The caller's `onJoin` runs once per run; a throw from it fails that run only. */
  #tellJoined(id: string, run: Run) {
    try {
      run.onJoin?.();
    } catch (error) {
      this.#withdraw(id)?.reject(error);
    }
  }

  /** A new connection: reassert the flights this process leads and land them again, then send what waits. */
  #resume() {
    for (const [id, { key, token, landing }] of this.#held) {
      this.#link.send({ op: 'reassert', id, key, token: token.toString() });
      if (landing) {
        this.#link.send({ op: 'land', id, outcome: landing.outcome });
      }
    }
    this.#calls.resume();
  }

  /**
   * Nothing sent on the lost connection will be answered, so every run goes
   * again on the next one. A run that waits for its key's lock had not led
   * yet: the next coordinator may not know its flight, so it goes again too.
   */
  #interrupt() {
    for (const run of this.#runs.values()) {
      run.locking?.abort();
      run.locking = undefined;
    }
    this.#calls.interrupt();
  }

  /** No coordinator heard the reassertions, so the flights this process leads may be interrupted already. */
  #fail(error: unknown) {
    for (const id of [...this.#held.keys()]) this.#lose(id);
    for (const id of [...this.#runs.keys()]) this.#take(id)?.reject(error);
  }

  /** Removes a run that is about to be answered, so a late answer for it is ignored. */
  #take(id: string): TakenCall<RunMessage, Answer> | undefined {
    this.#runs.get(id)?.locking?.abort();
    this.#runs.delete(id);
    return this.#calls.take(id);
  }
}
