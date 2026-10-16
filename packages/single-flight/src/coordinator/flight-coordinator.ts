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
   * The kernel locks on the keys. A process that holds a key's lock runs its
   * work, whether this coordinator knows that flight or not.
   */
  locks: KeyLocks;
}

/** How a reasserted flight ended, for a rejoin of it that comes after its end. */
interface Ending {
  readonly flight: Flight;
  readonly answer: { op: 'landed'; outcome: Outcome } | { op: 'interrupted' };
}

/**
 * Coordinates the flights of one term. A run leads a new flight of its key, or
 * joins the flight of that key in progress, in one step, so two runs never
 * both lead. The outcome is pushed to every joiner as soon as it lands.
 *
 * A key whose lock another process holds, while no flight of it is known
 * here, runs the work of a leader that has not reasserted its flight yet, so
 * its runs and rejoins wait for that flight or for the lock to free. A leader
 * keeps its flight while its process lives.
 */
export class FlightCoordinator {
  readonly #flights = new Map<string, Flight>();
  /** The latest ending of a reasserted flight, per key. */
  readonly #endings = new Map<string, Ending>();
  readonly #tokens: TokenSource;
  readonly #locks: KeyLocks;
  readonly #parked: ParkedRuns;
  readonly #closing = new AbortController();

  constructor({ tokens, locks }: FlightCoordinatorOptions) {
    this.#tokens = tokens;
    this.#locks = locks;
    this.#parked = new ParkedRuns(locks, this.#closing.signal);
  }

  serve(connection: Connection<FlightResponse>): void {
    new Session(this, connection);
  }

  /** Stops watching the locks of the keys whose runs wait. */
  close(): void {
    this.#closing.abort();
  }

  /** Rejects only when no token can be minted. */
  async run(party: Party, key: string) {
    // A token that goes unused is harmless: tokens only need to grow.
    this.#decide(party, key, await this.#tokens.next(key));
  }

  /**
   * A joiner that lost its connection, back for the flight it joined: it never
   * leads, so its work never runs twice. A rejoin joins only its own flight;
   * any other answer could be a second run of the work.
   */
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

  /** The leader withdrew or its connection is gone. */
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

  /**
   * Joins the flight of `key` in progress, waits while another process holds
   * the key, or leads. A flight of the key that starts while the run waits
   * takes it in the step that starts it, so a landing read right behind a
   * reassertion reaches it.
   */
  #decide(party: Party, key: string, token: FencingToken) {
    // The client may have withdrawn the run while the token was minted or while it waited.
    if (!party.waiting || this.#join(party, key)) return;
    if (this.#held(key)) {
      return this.#parked.park(key, party, () =>
        this.#decide(party, key, token),
      );
    }
    // No flight of the key started while the run waited, so its token is still newer than every flight of the key.
    this.#start(new Flight(key, token, party), (flight) => party.lead(flight));
  }

  /** Joins `party` to the flight of `key` in progress, if there is one. */
  #join(party: Party, key: string): boolean {
    const inProgress = this.#flights.get(key);
    inProgress?.add(party);
    return inProgress !== undefined;
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
