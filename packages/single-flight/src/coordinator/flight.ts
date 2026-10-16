import type { FencingToken } from '@zukhruf/fencing';

import type { Outcome } from '../protocol/flight-protocol.ts';
import type { Party } from './party.ts';

export interface FlightOptions {
  /** A leader claimed this flight again after its connection was lost, so a rejoin may come after its end. */
  reasserted?: boolean;
}

/** A flight in progress: the key, the leader that runs the work, its lease token, and the parties that joined. */
export class Flight {
  readonly key: string;
  readonly token: FencingToken;
  readonly reasserted: boolean;
  readonly #joiners = new Set<Party>();
  #leader: Party;

  constructor(
    key: string,
    token: FencingToken,
    leader: Party,
    { reasserted = false }: FlightOptions = {},
  ) {
    this.key = key;
    this.token = token;
    this.reasserted = reasserted;
    this.#leader = leader;
  }

  get leader(): Party {
    return this.#leader;
  }

  /** The flight's name on the wire: its token as decimal text, which a joined answer and a rejoin carry. */
  get id(): string {
    return this.token.toString();
  }

  /** Whether this is the flight with the id `flight`, which a rejoin names. */
  is(flight: string): boolean {
    return flight === this.id;
  }

  /**
   * The leader claimed this flight again through a new connection. The new
   * party leads it, and the old one ends without an answer, so the close of
   * the old connection interrupts nothing.
   */
  handOver(leader: Party) {
    const previous = this.#leader;
    this.#leader = leader;
    previous.end();
    leader.resume(this);
  }

  add(joiner: Party) {
    this.#joiners.add(joiner);
    joiner.join(this);
  }

  remove(joiner: Party) {
    this.#joiners.delete(joiner);
  }

  /** Pushes the outcome to every joiner, then tells the leader that it was handed over. */
  land(outcome: Outcome) {
    for (const joiner of this.#joiners) {
      joiner.end({ op: 'landed', outcome });
    }
    this.#joiners.clear();
    this.#leader.end({ op: 'ack' });
  }

  /** Ends without an outcome: every joiner learns that its flight is lost, and none runs the work again. */
  interrupt() {
    for (const joiner of this.#joiners) {
      joiner.end({ op: 'interrupted' });
    }
    this.#joiners.clear();
  }
}
