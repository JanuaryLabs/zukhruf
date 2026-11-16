import type { Ledger } from '../ledger/ledger.ts';
import type { Outcome } from './outcome.ts';

/**
 * Prints the open items, and exits 0 when there is one: a scheduler resumes
 * the run while this exits 0. Blocked items wait for their blocker instead.
 */
export class OpenCommand {
  run(ledger: Ledger): Outcome {
    const lines = [...ledger.runs]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .flatMap(([project, run]) =>
        run.open.map(
          ({ title, target }) => `${project}: ${title} (${target})\n`,
        ),
      );
    return { exitCode: lines.length > 0 ? 0 : 1, stdout: lines.join('') };
  }
}
