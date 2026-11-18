/**
 * Every use of the internals of ssh2 1.17.0 for the keepalive timer of the
 * client. ssh2 is pinned exactly; re-check each line below on a version bump.
 *
 * Why: an unref'd client must not keep the Node process alive, and ssh2 keeps
 * its keepalive in an interval timer that it holds in a closure and never
 * unrefs. The timer is reached only when ssh2 makes it, so each call of ssh2's
 * resetKA runs under an async hook that sees the Timeout it makes (`init`
 * gets the Timeout as its resource, node:async_hooks), and the new timer takes
 * the ref of the timer before it.
 *
 * - lib/client.js:715, :735-743: `katimer` is a variable of `connect`.
 *   resetKA, also `_resetKA`, sets the keepalive count to zero, clears
 *   `katimer` and, when keepaliveInterval is above 0 and the socket is
 *   writable, sets it to a new timer of the global setInterval. It calls
 *   nothing else.
 * - lib/client.js:364-370: USERAUTH_SUCCESS calls resetKA, then emits 'ready'
 *   in the same tick.
 * - lib/client.js:641-659: CHANNEL_SUCCESS and CHANNEL_FAILURE call
 *   `this._resetKA()`.
 * - lib/client.js:500-508, :729-730: sendKA, the one caller of
 *   `_protocol.ping()`, pushes resetKA onto `callbacks` just before it; the
 *   reply of the server calls it. `callbacks` is `_callbacks` (:248) until
 *   the socket closes (:823).
 * - lib/client.js:808-818: the end and the close of the socket clear
 *   `katimer`.
 */
import { createHook } from 'node:async_hooks';

import type ssh2 from 'ssh2';

declare module 'ssh2' {
  interface Client {
    _resetKA: () => void;
    readonly _callbacks: unknown[];
  }
  interface ClientProtocol {
    ping(): void;
  }
}

interface Timer {
  ref(): unknown;
  unref(): unknown;
  hasRef(): boolean;
}

/** Makes the keepalive timer of `connection` follow ref() and unref(). Call it on 'ready': the timer that USERAUTH_SUCCESS made just before is replaced by one that it sees. */
export function followKeepalive(connection: ssh2.Client): {
  ref(): void;
  unref(): void;
} {
  const resetKA = connection._resetKA;
  let timer: Timer | undefined;
  const reset = (): void => {
    const previous = timer;
    const hook = createHook({
      init(_asyncId, type, _triggerAsyncId, resource) {
        if (type !== 'Timeout' || !isTimer(resource)) return;
        if (previous?.hasRef() === false) resource.unref();
        timer = resource;
      },
    });
    hook.enable();
    try {
      resetKA();
    } finally {
      hook.disable();
    }
  };
  connection._resetKA = reset;
  const protocol = connection._protocol;
  const ping = protocol.ping.bind(protocol);
  protocol.ping = () => {
    const callbacks = connection._callbacks;
    callbacks[callbacks.length - 1] = reset;
    ping();
  };
  reset();
  return {
    ref() {
      timer?.ref();
    },
    unref() {
      timer?.unref();
    },
  };
}

function isTimer(resource: object): resource is Timer {
  return 'hasRef' in resource && typeof resource.hasRef === 'function';
}
