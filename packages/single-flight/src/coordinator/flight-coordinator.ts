import { Latch } from '@zukhruf/async';
import type { FencingToken, TokenSource } from '@zukhruf/fencing';

import type { Connection } from '../connection/connection.ts';
import type { KeyLocks } from '../key-lock/key-locks.ts';
import type { FlightResponse, Outcome } from '../protocol/flight-protocol.ts';
import { Flight } from './flight.ts';
import { ParkedRuns } from './parked-runs.ts';
import type { Party } from './party.ts';
import { Session } from './session.ts';

export interface FlightCoordinatorOptions {
  /** Mints the lease token of each flight this coordinator starts. */
  tokens: TokenSource;
  /**
   * Milliseconds after start during which no fresh run decides, so leaders
   * from a previous coordinator can reassert their flights first. Zero when no
   * earlier coordinator can have left a flight in progress.
   */
  graceWindow: number;
  /**
   * The kernel locks on the keys. A process that holds a key's lock runs its
   * work, whether this coordinator knows that flight or not.
   */
  locks: KeyLocks;
}

interface Phase {
  readonly leavesNothingToRecover: boolean;
  run(party: Party, key: string): Promise<void>;
}

/**
 * Coordinates the flights of one term. A run leads a new flight of its key, or
 * joins the flight of that key in progress, in one step, so two runs never
 * both lead. The outcome is pushed to every joiner as soon as it lands.
 */
export class FlightCoordinator {
  readonly #coordinating: Coordinating;
  readonly #closing = new AbortController();
  #phase: Phase;

  constructor({ tokens, graceWindow, locks }: FlightCoordinatorOptions) {
    const coordinating = new Coordinating(tokens, locks, this.#closing.signal);
    this.#coordinating = coordinating;
    if (graceWindow > 0) {
      const over = new Latch();
      this.#phase = new GraceWindow(over, coordinating);
      setTimeout(() => {
        // Coordinating is current before the latch lets the waiting runs resume.
        this.#phase = coordinating;
        over.open();
      }, graceWindow).unref();
    } else {
      this.#phase = coordinating;
    }
  }

  /**
   * Whether the next coordinator would find nothing to recover: no flight is
   * in progress, and the grace window is over or there was none.
   */
  get leavesNothingToRecover(): boolean {
    return this.#phase.leavesNothingToRecover;
  }

  serve(connection: Connection<FlightResponse>): void {
    new Session(this, connection);
  }

  /** Rejects only when no token can be minted. */
  run(party: Party, key: string): Promise<void> {
    return this.#phase.run(party, key);
  }

  /** A joiner that lost its connection, back for the flight it joined: it never leads, so its work never runs twice. */
  rejoin(party: Party, key: string, flight: string): void {
    this.#coordinating.rejoin(party, key, flight);
  }

  reassert(party: Party, key: string, token: FencingToken): void {
    this.#coordinating.reassert(party, key, token);
  }

  land(flight: Flight, outcome: Outcome): void {
    this.#coordinating.land(flight, outcome);
  }

  /** The leader withdrew or its connection is gone. */
  interrupt(flight: Flight): void {
    this.#coordinating.interrupt(flight);
  }

  /** Stops watching the locks of the keys whose runs wait. */
  close(): void {
    this.#closing.abort();
  }
}

/** How a reasserted flight ended, for a rejoin of it that comes after its end. */
interface Ending {
  readonly flight: Flight;
  readonly answer: { op: 'landed'; outcome: Outcome } | { op: 'interrupted' };
}

/**
 * Starts, joins and ends flights. A key whose lock another process holds,
 * while no flight of it is known here, runs the work of a leader that has not
 * reasserted its flight yet, so its runs and rejoins wait for that flight or
 * for the lock to free. A leader keeps its flight while its process lives.
 */
class Coordinating implements Phase {
  readonly #flights = new Map<string, Flight>();
  /** The latest ending of a reasserted flight, per key. */
  readonly #endings = new Map<string, Ending>();
  readonly #tokens: TokenSource;
  readonly #locks: KeyLocks;
  readonly #parked: ParkedRuns;

  constructor(tokens: TokenSource, locks: KeyLocks, closed: AbortSignal) {
    this.#tokens = tokens;
    this.#locks = locks;
    this.#parked = new ParkedRuns(locks, closed);
  }

  get leavesNothingToRecover() {
    return this.#flights.size === 0;
  }

  async run(party: Party, key: string) {
    for (;;) {
      // A token that goes unused is harmless: tokens only need to grow. A run
      // that waited mints again, so it never leads with a token older than a
      // flight it waited behind.
      const token = await this.#tokens.next(key);
      // The client may have withdrawn the run while the token was minted.
      if (!party.waiting || this.#join(party, key)) return;
      if (!this.#held(key)) {
        return this.#start(new Flight(key, token, party), (flight) =>
          party.lead(flight),
        );
      }
      if (!(await this.#untilFree(party, key))) return;
    }
  }

  /** A rejoin joins only its own flight; any other answer could be a second run of the work. */
  rejoin(party: Party, key: string, flight: string): void {
    if (!party.waiting) return;
    const inProgress = this.#flights.get(key);
    if (inProgress?.is(flight)) return inProgress.add(party);
    const ending = this.#endings.get(key);
    if (ending?.flight.is(flight)) return party.end(ending.answer);
    // Its leader may still run the work, and not have reasserted it yet.
    if (!inProgress && this.#held(key)) {
      return this.#parked.park(key, party, () =>
        this.rejoin(party, key, flight),
      );
    }
    party.end({ op: 'interrupted' });
  }

  /**
   * A leader claims its flight again after its connection was lost. The same
   * flight, through a new connection, stays one flight with its joiners. For
   * two flights of one key, the newer token wins, and the older flight is lost.
   */
  reassert(party: Party, key: string, token: FencingToken): void {
    const claimed = this.#flights.get(key);
    if (claimed?.token.value === token.value) return claimed.handOver(party);
    if (claimed && !token.isNewerThan(claimed.token)) {
      return party.end({ op: 'rejected' });
    }
    if (claimed) {
      claimed.leader.end({ op: 'rejected' });
      this.interrupt(claimed);
    }
    this.#start(new Flight(key, token, party, { reasserted: true }), (flight) =>
      party.resume(flight),
    );
  }

  land(flight: Flight, outcome: Outcome) {
    this.#end(flight, { op: 'landed', outcome });
    flight.land(outcome);
  }

  interrupt(flight: Flight) {
    this.#end(flight, { op: 'interrupted' });
    flight.interrupt();
  }

  /** Every new flight takes the runs parked on its key, in the step that starts it. */
  #start(flight: Flight, tell: (flight: Flight) => void) {
    this.#flights.set(flight.key, flight);
    tell(flight);
    this.#parked.wake(flight.key);
  }

  #end(flight: Flight, answer: Ending['answer']) {
    if (this.#flights.get(flight.key) === flight) {
      this.#flights.delete(flight.key);
    }
    if (flight.reasserted) this.#endings.set(flight.key, { flight, answer });
  }

  /** Joins `party` to the flight of `key` in progress, if there is one. */
  #join(party: Party, key: string): boolean {
    const inProgress = this.#flights.get(key);
    inProgress?.add(party);
    return inProgress !== undefined;
  }

  /**
   * Parks a run while another process holds its key. A flight of the key that
   * starts meanwhile takes it in the step that starts it, so a landing read
   * right behind a reassertion reaches it. Resolves `true` once the key may be
   * free and no flight took the run, and `false` once the run is answered or
   * gone.
   */
  #untilFree(party: Party, key: string): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const retry = () => {
      if (!party.waiting || this.#join(party, key)) return resolve(false);
      if (this.#held(key)) return this.#parked.park(key, party, retry);
      resolve(true);
    };
    this.#parked.park(key, party, retry);
    return promise;
  }

  /**
   * The lock check is advice only (F5). A fault answers "not held", so the
   * run leads and its leader's own lock decides; a fault never rejects a run
   * or a rejoin, which would close its connection.
   */
  #held(key: string): boolean {
    try {
      return this.#locks.isHeld(key);
    } catch {
      return false;
    }
  }
}

/** No fresh run decides yet, so leaders from a previous coordinator can reassert theirs first. */
class GraceWindow implements Phase {
  readonly #over: Latch;
  readonly #next: Coordinating;

  constructor(over: Latch, next: Coordinating) {
    this.#over = over;
    this.#next = next;
  }

  /** A leader of the previous term may not have reasserted its flight yet, so this coordinator cannot know. */
  get leavesNothingToRecover() {
    return false;
  }

  async run(party: Party, key: string) {
    await this.#over.wait();
    return this.#next.run(party, key);
  }
}
