import { statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { type Clock, untilAborted } from '@zukhruf/async';

import type { AgentJob } from '../job/agent-job.ts';
import type { DaemonJob } from '../job/daemon-job.ts';
import { JobFile } from '../job/job-file.ts';
import type { CancelOptions } from '../launchctl/cancel-options.ts';
import type { Domain } from '../launchctl/domain.ts';
import { Launchctl } from '../launchctl/launchctl.ts';
import { Service } from '../service/service.ts';

export interface LaunchdOptions {
  /** The clock of the waits: the bootout wait and the atomic write. Production gives `globalThis`. */
  clock: Clock;
}

/** The jobs of one domain, and the folder of their job files. */
export class Launchd<J extends AgentJob | DaemonJob> {
  /** The domain-target: 'gui/501', 'user/501' or 'system'. */
  readonly domain: Domain;
  /** The absolute path of the folder of the job files. */
  readonly folder: string;
  readonly #clock: Clock;
  readonly #launchctl = new Launchctl();

  private constructor(domain: Domain, folder: string, clock: Clock) {
    this.domain = domain;
    this.folder = folder;
    this.#clock = clock;
  }

  /** This user's agents: gui/<uid> when this uid owns /dev/console, else user/<uid>. The folder is Library/LaunchAgents in the home folder of the uid. */
  static agents({ clock }: LaunchdOptions): Launchd<AgentJob> {
    // One record of the user database names the user of the domain and of
    // the folder, not $HOME (ADR 0005).
    const { uid, homedir } = userInfo();
    const atConsole = statSync('/dev/console').uid === uid;
    return new Launchd<AgentJob>(
      atConsole ? `gui/${uid}` : `user/${uid}`,
      join(homedir, 'Library', 'LaunchAgents'),
      clock,
    );
  }

  /** The daemons of the system domain, in /Library/LaunchDaemons. A change needs root. */
  static daemons({ clock }: LaunchdOptions): Launchd<DaemonJob> {
    return new Launchd<DaemonJob>('system', '/Library/LaunchDaemons', clock);
  }

  /** The reconcile: writes <folder>/<Label>.plist when its bytes differ, boots out the old service, enables, bootstraps. */
  async install(job: J, options: CancelOptions = {}): Promise<Service> {
    const jobFile = new JobFile(this.folder, job.Label);
    const service = this.#service(jobFile);
    const content = JobFile.render(job);
    if (await jobFile.holds(content)) {
      if ((await service.state(options)).state !== 'not loaded') {
        return service;
      }
    } else {
      // The old bytes stay until launchd has forgotten the old service, so an
      // install that stops here leaves other bytes, and the next one repeats
      // the work (ADR 0003).
      await service.bootout(options);
      await jobFile.write(content, this.#clock);
    }
    await service.enable(options);
    await service.bootstrap(options);
    return service;
  }

  /** The handle of a label in this domain. Reads nothing and runs nothing. */
  service(label: string): Service {
    return this.#service(new JobFile(this.folder, label));
  }

  /** A handle for each <folder>/*.plist, with the label from the file name, sorted. No folder gives []. */
  async installed({ signal }: CancelOptions = {}): Promise<Service[]> {
    const labels = await untilAborted(JobFile.labels(this.folder), signal);
    return labels.map((label) => this.service(label));
  }

  #service(jobFile: JobFile): Service {
    return new Service(jobFile, this.domain, this.#launchctl, this.#clock);
  }
}
