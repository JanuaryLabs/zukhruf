/** The whole environment of a process. A value of undefined is left out. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** How a process ended: an exit code, or the signal that ended it. */
export type End =
  | { readonly exitCode: number; readonly signal?: undefined }
  | { readonly signal: NodeJS.Signals; readonly exitCode?: undefined };

/** What a run printed. The text keeps its last newline. */
export interface Output {
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr in the order that the process wrote them. */
  readonly output: string;
}

export type Completed = End & Output;
