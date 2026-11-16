/** What a command prints, and the exit code a scheduler reads. */
export interface Outcome {
  readonly exitCode: 0 | 1;
  readonly stdout: string;
}
