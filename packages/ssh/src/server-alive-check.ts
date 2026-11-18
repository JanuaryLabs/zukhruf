import type { Duplex } from 'node:stream';

import type { Clock } from '@zukhruf/async';

// The longest delay that a timer of Node.js holds; a longer one fires at once.
const TIMER_MAX = 2 ** 31 - 1;

/**
 * OpenSSH's ServerAliveInterval and ServerAliveCountMax, on a clock
 * (OpenSSH 10.0p1, clientloop.c and packet.c):
 *
 * - The check is due `interval` after the start of the connection
 *   (clientloop.c:client_loop calls schedule_server_alive_check) and after
 *   each arrival of data from the server
 *   (clientloop.c:client_process_net_input calls it before it reads).
 * - Each arrival of data sets the count of checks with no answer to zero
 *   (packet.c:ssh_packet_read_poll_seqnr, at each packet). The answer to a
 *   keepalive is data, so it resets the count as well
 *   (clientloop.c:client_global_request_reply).
 * - A due check adds one to the count. When the count is then above
 *   `countMax`, the connection ends; otherwise the check sends
 *   keepalive@openssh.com with want reply, and the next check is due
 *   `interval` later (clientloop.c:server_alive_check).
 *
 * OpenSSH reads the time of the next check when poll() returns
 * (clientloop.c:client_wait_until_can_do_something); one timer of the clock
 * does it here, and a data arrival only moves the time, as OpenSSH does.
 */
export class ServerAliveCheck {
  readonly #clock: Clock;
  readonly #interval: number;
  readonly #countMax: number;
  readonly #transport: Duplex;
  readonly #send: () => void;
  readonly #timeout: () => void;
  readonly #onData = (): void => {
    this.#due = this.#clock.performance.now() + this.#interval;
    this.#unanswered = 0;
  };
  #due: number;
  #unanswered = 0;
  #hold: (timer: unknown) => void = refTimer;
  #timer: unknown;

  /** Starts the check on `transport`, the stream from the server. `send` sends a keepalive request; `timeout` ends the connection. */
  constructor(
    clock: Clock,
    keepalive: { readonly interval: number; readonly countMax: number },
    transport: Duplex,
    send: () => void,
    timeout: () => void,
  ) {
    this.#clock = clock;
    this.#interval = keepalive.interval;
    this.#countMax = keepalive.countMax;
    this.#transport = transport;
    this.#send = send;
    this.#timeout = timeout;
    this.#due = clock.performance.now() + keepalive.interval;
    transport.on('data', this.#onData);
    this.#timer = this.#arm();
  }

  #arm(): unknown {
    const left = this.#due - this.#clock.performance.now();
    const timer = this.#clock.setTimeout(
      () => this.#fire(),
      Math.min(Math.max(left, 0), TIMER_MAX),
    );
    this.#hold(timer);
    return timer;
  }

  #fire(): void {
    const now = this.#clock.performance.now();
    if (now >= this.#due) {
      this.#unanswered += 1;
      if (this.#unanswered > this.#countMax) {
        this.stop();
        this.#timeout();
        return;
      }
      this.#send();
      this.#due = now + this.#interval;
    }
    this.#timer = this.#arm();
  }

  ref(): void {
    this.#hold = refTimer;
    refTimer(this.#timer);
  }

  unref(): void {
    this.#hold = unrefTimer;
    unrefTimer(this.#timer);
  }

  /** Stops the timer and stops reading the arrivals of data. */
  stop(): void {
    this.#clock.clearTimeout(this.#timer);
    this.#transport.off('data', this.#onData);
  }
}

interface Holder {
  ref(): unknown;
  unref(): unknown;
}

// A timer of the clock is opaque (@zukhruf/async Clock): the timer of Node.js
// and of @sinonjs/fake-timers has ref() and unref().
function isHolder(timer: unknown): timer is Holder {
  return (
    typeof timer === 'object' &&
    timer !== null &&
    'ref' in timer &&
    typeof timer.ref === 'function' &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  );
}

function refTimer(timer: unknown): void {
  if (isHolder(timer)) timer.ref();
}

function unrefTimer(timer: unknown): void {
  if (isHolder(timer)) timer.unref();
}
