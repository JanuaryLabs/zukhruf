import type { End } from './end.ts';

/**
 * A started process ended before it was ready. The message names the process,
 * its end and its stderr tail, never its arguments, because arguments can
 * hold prompts or secrets.
 */
export class EndedBeforeReadyError extends Error {
  override readonly name = 'EndedBeforeReadyError';
  readonly end: End;
  /** The stderr tail of the process. */
  readonly stderr: string;

  constructor(process: string, end: End, stderr: string) {
    const how =
      end.signal === undefined ? `exit code ${end.exitCode}` : end.signal;
    super(
      `${process} ended (${how}) before it was ready${stderr === '' ? '' : `: ${stderr}`}`,
    );
    this.end = end;
    this.stderr = stderr;
  }
}
