import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { settleWithin } from '@zukhruf/testing/async';

/** How long a test waits for a fact of real I/O, never asserting that it came sooner. */
export const factTimeout = 10_000;

/** The package index, for a program's `import`. */
export const packageIndex = new URL('../index.ts', import.meta.url).href;

export interface Program extends AsyncDisposable {
  readonly child: ChildProcess;
  /** Resolves with the exit code, or `null` when a signal ended the program. */
  readonly exited: Promise<number | null>;
  /** Resolves when the program printed `line` on its standard output, within `factTimeout`. */
  printed(line: string): Promise<void>;
}

/** Runs `source` as an ES module in its own Node process. Disposing kills it with SIGKILL. */
export function startProgram(source: string): Program {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit').then(() => child.exitCode);
  const lines = createInterface({ input: child.stdout! });
  const seen = new Set<string>();
  const waiting = new Map<string, PromiseWithResolvers<void>>();
  lines.on('line', (line) => {
    seen.add(line);
    waiting.get(line)?.resolve();
  });
  return {
    child,
    exited,
    printed(line) {
      if (seen.has(line)) return Promise.resolve();
      const printed = Promise.withResolvers<void>();
      waiting.set(line, printed);
      return settleWithin(
        printed.promise,
        `the program prints ${line}`,
        factTimeout,
      );
    },
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
}
