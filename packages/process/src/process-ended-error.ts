import type { End } from './end.ts';

/**
 * A started process ended before what its caller waited for: its ready line
 * or message, or a message that next() waits for. The message names the
 * process, its end, the wait and its stderr tail, never its arguments,
 * because arguments can hold prompts or secrets.
 */
export class ProcessEndedError extends Error {
  override readonly name = 'ProcessEndedError';
  readonly end: End;
  /** The stderr tail of the process. */
  readonly stderr: string;

  /** `before` says what the caller waited for, such as "it was ready". */
  constructor(process: string, end: End, stderr: string, before: string) {
    const how =
      end.signal === undefined ? `exit code ${end.exitCode}` : end.signal;
    super(
      `${process} ended (${how}) before ${before}${stderr === '' ? '' : `: ${stderr}`}`,
    );
    this.end = end;
    this.stderr = stderr;
  }
}
