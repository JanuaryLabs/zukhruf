import type { End } from './end.ts';
import { TAIL } from './started-process.ts';

/**
 * A run ended with an end that its caller does not accept, as Go's
 * exec.ExitError and Python's CalledProcessError. The caller says what it
 * accepts and throws this for any other end (ADR 0002). The message names the
 * process, its end and its stderr tail, never its arguments, because
 * arguments can hold prompts or secrets. A run gives its stderr; a started
 * process whose stderr was not piped gives only its end, as Python's
 * CalledProcessError takes stderr only when it was captured.
 */
export class ExitError extends Error {
  override readonly name = 'ExitError';
  readonly end: End;
  /** The stderr tail of the run. */
  readonly stderr: string;

  constructor(process: string, ended: End & { readonly stderr?: string }) {
    const end: End =
      ended.signal === undefined
        ? { exitCode: ended.exitCode }
        : { signal: ended.signal };
    const how =
      end.signal === undefined ? `exit code ${end.exitCode}` : end.signal;
    const stderr = (ended.stderr ?? '').slice(-TAIL);
    super(`${process} ended (${how})${stderr === '' ? '' : `: ${stderr}`}`);
    this.end = end;
    this.stderr = stderr;
  }
}
