import type { AbsolutePath } from './absolute-path.ts';

/** launchd ORs the conditions. */
export interface KeepAliveConditions {
  /** Evaluates the other conditions only after the first launch for another reason. PathState is not affected. */
  AfterInitialDemand?: boolean;
  /** true: start again after exit status 0. false: start again after another exit status. */
  SuccessfulExit?: boolean;
  /** true keeps the job running while the path exists; false, while it does not. */
  PathState?: Readonly<Record<AbsolutePath, boolean>>;
  /** Each key is a label: true keeps the job running while that job is loaded. */
  OtherJobEnabled?: Readonly<Record<string, boolean>>;
  /** true: start again after a crash signal (SIGILL, SIGSEGV …). false: start again after another exit. */
  Crashed?: boolean;
}
