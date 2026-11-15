import { type Clock, poll } from '@zukhruf/async';

import type { JobFile } from '../job/job-file.ts';
import type { CancelOptions } from '../launchctl/cancel-options.ts';
import type { Domain } from '../launchctl/domain.ts';
import type { Launchctl } from '../launchctl/launchctl.ts';
import type { ServiceState } from './service-state.ts';

/** One label in one domain. A handle: it holds no state, and it exists also when launchd has no such service. */
export class Service {
  readonly label: string;
  /** The job file: <folder>/<label>.plist. */
  readonly file: string;
  /** The service-target: <domain>/<label>, such as 'gui/501/com.example.sync'. */
  readonly target: string;
  readonly #domain: Domain;
  readonly #jobFile: JobFile;
  readonly #launchctl: Launchctl;
  readonly #clock: Clock;

  constructor(
    jobFile: JobFile,
    domain: Domain,
    launchctl: Launchctl,
    clock: Clock,
  ) {
    this.label = jobFile.label;
    this.file = jobFile.path;
    this.target = `${domain}/${jobFile.label}`;
    this.#domain = domain;
    this.#jobFile = jobFile;
    this.#launchctl = launchctl;
    this.#clock = clock;
  }

  /** One `launchctl print <target>`: exit code 113 and the lines `pid =` and `last exit code =`. */
  state({ signal }: CancelOptions = {}): Promise<ServiceState> {
    return this.#launchctl.print(this.target, signal);
  }

  /** Runs the service now (`kickstart -p`). With `kill`, kills the process that runs first (`-k`). Gives the PID of the new process, or of the process that runs. */
  kickstart({
    kill = false,
    signal,
  }: CancelOptions & { kill?: boolean } = {}): Promise<number> {
    return this.#launchctl.kickstart(this.target, kill, signal);
  }

  /** Sends a process signal, by name or number, to the process of the service. */
  kill(
    processSignal: NodeJS.Signals | number,
    { signal }: CancelOptions = {},
  ): Promise<void> {
    return this.#launchctl.kill(this.target, processSignal, signal);
  }

  /** Enables the service: launchd may load it again. */
  enable({ signal }: CancelOptions = {}): Promise<void> {
    return this.#launchctl.enable(this.target, signal);
  }

  /** Disables the service: launchd does not load it until enable(), also after a restart. */
  disable({ signal }: CancelOptions = {}): Promise<void> {
    return this.#launchctl.disable(this.target, signal);
  }

  /** Loads the job file into the domain. */
  bootstrap({ signal }: CancelOptions = {}): Promise<void> {
    return this.#launchctl.bootstrap(this.#domain, this.file, signal);
  }

  /** Removes the service from the domain, and waits until launchd forgets it. The job file stays. */
  async bootout({ signal }: CancelOptions = {}): Promise<void> {
    // launchd answers before the process is gone, and refuses a bootstrap of
    // the label until then; it gives no event when it forgets the service.
    await poll(
      async () =>
        (await this.#launchctl.bootout(this.target, signal)) ? true : undefined,
      { interval: 1000, signal, clock: this.#clock },
    );
  }

  /** bootout(), then removes the job file. Resolves when neither is there. */
  async uninstall(options: CancelOptions = {}): Promise<void> {
    await this.bootout(options);
    await this.#jobFile.remove();
  }
}
