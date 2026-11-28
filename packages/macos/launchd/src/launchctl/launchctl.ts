import { untilAborted } from '@zukhruf/async';
import { isErrno } from '@zukhruf/fs';
import { Command, ExitError, StartError } from '@zukhruf/process';

import {
  LaunchctlError,
  LaunchdUnavailableError,
  PermissionDeniedError,
  ServiceNotFoundError,
} from '../errors.ts';
import type { ServiceState } from '../service/service-state.ts';
import type { Domain } from './domain.ts';

interface Answer {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// launchctl error <code> on macOS 27.2.
const NOT_PERMITTED = 1;
const NO_SUCH_PROCESS = 3;
const IN_PROGRESS = 36;
const SERVICE_NOT_FOUND = 113;

// Two top-level lines of `print`, which "is NOT API" (launchctl(1), lines
// 222-224): the package reads no other part of it (ADR 0006).
const PID = /^\tpid = (\d+)$/m;
const LAST_EXIT_CODE = /^\tlast exit code = (\d+)/m;

/** `/bin/launchctl`, and what its answers mean for each subcommand that the package runs. */
export class Launchctl {
  /** 113 is a service that the domain does not have. */
  async print(target: string, signal?: AbortSignal): Promise<ServiceState> {
    const args = ['print', target];
    const answer = await this.#run(args, signal);
    if (answer.exitCode === SERVICE_NOT_FOUND) return { state: 'not loaded' };
    this.#succeeded(args, answer);
    const pid = PID.exec(answer.stdout)?.[1];
    const code = LAST_EXIT_CODE.exec(answer.stdout)?.[1];
    const lastExitStatus = code === undefined ? undefined : Number(code);
    return pid === undefined
      ? { state: 'not running', lastExitStatus }
      : { state: 'running', pid: Number(pid), lastExitStatus };
  }

  /** true when launchd has forgotten the service; false while the bootout goes on. */
  async bootout(target: string, signal?: AbortSignal): Promise<boolean> {
    const args = ['bootout', target];
    const answer = await this.#run(args, signal);
    if (answer.exitCode === NO_SUCH_PROCESS) return true;
    if (answer.exitCode === 0 || answer.exitCode === IN_PROGRESS) return false;
    throw this.#error(args, answer);
  }

  async bootstrap(
    domain: Domain,
    file: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const args = ['bootstrap', domain, file];
    this.#succeeded(args, await this.#run(args, signal));
  }

  async enable(target: string, signal?: AbortSignal): Promise<void> {
    const args = ['enable', target];
    this.#succeeded(args, await this.#run(args, signal));
  }

  async disable(target: string, signal?: AbortSignal): Promise<void> {
    const args = ['disable', target];
    this.#succeeded(args, await this.#run(args, signal));
  }

  /** The PID that `-p` prints. */
  async kickstart(
    target: string,
    kill: boolean,
    signal?: AbortSignal,
  ): Promise<number> {
    const args = ['kickstart', ...(kill ? ['-k'] : []), '-p', target];
    const answer = await this.#run(args, signal);
    this.#found(args, answer, target);
    return Number(answer.stdout);
  }

  async kill(
    target: string,
    processSignal: NodeJS.Signals | number,
    signal?: AbortSignal,
  ): Promise<void> {
    const args = ['kill', String(processSignal), target];
    this.#found(args, await this.#run(args, signal), target);
  }

  #found(args: readonly string[], answer: Answer, target: string): void {
    if (answer.exitCode === SERVICE_NOT_FOUND) {
      throw new ServiceNotFoundError(
        args,
        answer.exitCode,
        answer.stderr,
        target,
      );
    }
    this.#succeeded(args, answer);
  }

  #succeeded(args: readonly string[], answer: Answer): void {
    if (answer.exitCode !== 0) throw this.#error(args, answer);
  }

  #error(
    args: readonly string[],
    answer: Answer,
  ): LaunchctlError | PermissionDeniedError {
    const error = new LaunchctlError(args, answer.exitCode, answer.stderr);
    return answer.exitCode === NOT_PERMITTED
      ? new PermissionDeniedError(error)
      : error;
  }

  // A cancel stops the wait, not the subcommand, as a cancel of the bootout
  // wait leaves launchd to finish the bootout (ADR 0004).
  #run(args: readonly string[], signal: AbortSignal | undefined) {
    return untilAborted(this.#answer(args), signal);
  }

  async #answer(args: readonly string[]): Promise<Answer> {
    const launchctl = new Command('/bin/launchctl', args, {
      env: {},
      clock: globalThis,
    });
    const run = await launchctl.run().catch((error: unknown) => {
      if (error instanceof StartError && isErrno(error.cause, 'ENOENT'))
        throw new LaunchdUnavailableError(error);
      throw error;
    });
    if (run.exitCode === undefined) throw new ExitError('launchctl', run);
    return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
  }
}
