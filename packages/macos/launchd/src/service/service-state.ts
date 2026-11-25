/** What `launchctl print` shows of one service. */
export type ServiceState =
  | { readonly state: 'not loaded' }
  | {
      readonly state: 'running';
      readonly pid: number;
      /** undefined: no number in a `last exit code` line, or no such line. */
      readonly lastExitStatus: number | undefined;
    }
  | {
      readonly state: 'not running';
      readonly lastExitStatus: number | undefined;
    };
