import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

/** The package index, for a program's `import`. */
export const packageIndex = new URL('../index.ts', import.meta.url).href;

/** The limit of a wait, for example `t.signal`. The wait rejects with its reason. */
export interface WaitOptions {
  signal: AbortSignal;
}

export interface Program extends AsyncDisposable {
  readonly child: ChildProcess;
  /** Resolves with the exit code, or `null` when a signal ended the program. */
  exited(options: WaitOptions): Promise<number | null>;
  /** Resolves when the program printed `line` on its standard output, before or after the call. */
  printed(line: string, options: WaitOptions): Promise<void>;
}

/** Runs `source` as an ES module in its own Node process. Disposing kills it with SIGKILL. */
export function startProgram(source: string): Program {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const ended = once(child, 'exit');
  const running = () => child.exitCode === null && child.signalCode === null;
  const lines = createInterface({ input: child.stdout! });
  const seen = new Set<string>();
  // An EventTarget, not an EventEmitter: a printed line `error` must not throw.
  const printedLines = new EventTarget();
  lines.on('line', (line) => {
    seen.add(line);
    printedLines.dispatchEvent(new Event(line));
  });
  return {
    child,
    async exited({ signal }) {
      if (running()) await once(child, 'exit', { signal });
      return child.exitCode;
    },
    async printed(line, { signal }) {
      if (!seen.has(line)) await once(printedLines, line, { signal });
    },
    async [Symbol.asyncDispose]() {
      if (running()) child.kill('SIGKILL');
      await ended;
    },
  };
}
