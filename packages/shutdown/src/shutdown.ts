import { convertProcessSignalToExitCode } from 'node:util';

const terminationSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type TerminationSignal = (typeof terminationSignals)[number];

/** The reason of the signal when a termination signal is the cause. */
class TerminationSignalReceived extends DOMException {
  readonly terminationSignal: TerminationSignal;

  constructor(terminationSignal: TerminationSignal) {
    super(`The process received ${terminationSignal}`, 'AbortError');
    this.terminationSignal = terminationSignal;
  }
}

export class Shutdown implements Disposable {
  readonly #controller = new AbortController();

  // A second termination signal gets the default action (ADR 0002). The
  // crash listeners stay: see #onCrash.
  readonly #onTerminationSignal = (signal: TerminationSignal) => {
    this.#stopListeningForSignals();
    this.#controller.abort(new TerminationSignalReceived(signal));
  };

  // With a listener, Node.js does not write the error, so the package does
  // (ADR 0003). A crash after a termination signal ends the process at once:
  // process.exit() emits 'exit', and there the process dies by the signal.
  // The default of Node.js would lose the error: with no listener, it emits
  // 'exit' before it writes the error (lib/internal/process/execution.js).
  readonly #onCrash = (error: unknown) => {
    console.error(error);
    if (this.#controller.signal.reason instanceof TerminationSignalReceived) {
      process.exit();
    }
    this.#stopListeningForSignals();
    this.#stopListeningForCrashes();
    this.#controller.abort(error);
  };

  // After the cleanup, the process dies by the termination signal that caused
  // the shutdown (ADR 0001). The other listeners for that signal go first, or
  // one of them would take it. The kernel does not apply the default action
  // to PID 1, so there the process lives on, and it exits with the code that a
  // shell shows for the signal. After a crash, the exit code is 1 (ADR 0003).
  readonly #onExit = () => {
    const cause: unknown = this.#controller.signal.reason;
    if (cause instanceof TerminationSignalReceived) {
      process.removeAllListeners(cause.terminationSignal);
      process.kill(process.pid, cause.terminationSignal);
      process.exitCode = convertProcessSignalToExitCode(
        cause.terminationSignal,
      );
    } else if (this.#controller.signal.aborted) {
      process.exitCode ||= 1;
    }
  };

  constructor() {
    for (const signal of terminationSignals) {
      process.on(signal, this.#onTerminationSignal);
    }
    process.on('uncaughtException', this.#onCrash);
    process.on('unhandledRejection', this.#onCrash);
    process.on('exit', this.#onExit);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  #stopListeningForSignals() {
    for (const signal of terminationSignals) {
      process.off(signal, this.#onTerminationSignal);
    }
  }

  #stopListeningForCrashes() {
    process.off('uncaughtException', this.#onCrash);
    process.off('unhandledRejection', this.#onCrash);
  }

  // A stop request that came before the end of the scope stays. Each listener
  // left after it ends the process by its cause, so the end of the scope
  // removes none of them.
  [Symbol.dispose](): void {
    if (this.#controller.signal.aborted) {
      return;
    }
    this.#stopListeningForSignals();
    this.#stopListeningForCrashes();
    process.off('exit', this.#onExit);
    this.#controller.abort(
      new DOMException('The shutdown scope ended', 'AbortError'),
    );
  }
}
