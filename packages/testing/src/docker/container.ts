import { type Result, SubprocessError } from 'nano-spawn';

/** The Docker CLI, bound to the engine that a handle was created on. */
export type DockerCommand = (args: string[]) => Promise<Result>;

/** A container this process started. Disposal removes it with its anonymous volumes. */
export class Container implements AsyncDisposable {
  readonly containerId: string;
  readonly command: DockerCommand;

  constructor(containerId: string, command: DockerCommand) {
    this.containerId = containerId;
    this.command = command;
  }

  // Bound: readiness probes receive it destructured.
  readonly exec = (command: string[]): Promise<Result> =>
    this.command(['exec', this.containerId, ...command]);

  /** What the container printed so far, standard output and error interleaved. */
  async logs(): Promise<string> {
    const { output } = await this.command(['logs', this.containerId]);
    return output;
  }

  /** Sends `signal` to the container's main process, as `docker kill` does. */
  async kill(signal = 'SIGKILL'): Promise<void> {
    await this.command(['kill', '--signal', signal, this.containerId]);
  }

  async cleanup(): Promise<void> {
    await this.command(['rm', '--force', '--volumes', this.containerId]).catch(
      (error: unknown) => {
        if (
          !(error instanceof SubprocessError) ||
          !/No such container/i.test(error.stderr)
        )
          throw error;
      },
    );
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.cleanup();
  }
}

/**
 * A container whose port answers on 127.0.0.1 of this machine, through an SSH
 * forward when the engine is remote. Disposal also closes the forward.
 */
export class ServiceContainer extends Container {
  readonly host = '127.0.0.1';
  readonly port: number;
  /** Closes the forward and leaves the container running for its other users. */
  readonly disconnect: () => Promise<void>;

  constructor(
    containerId: string,
    port: number,
    command: DockerCommand,
    disconnect: () => Promise<void>,
  ) {
    super(containerId, command);
    this.port = port;
    this.disconnect = disconnect;
  }

  /** Removes the container, then closes the forward; when both fail, a SuppressedError holds both. */
  override async cleanup(): Promise<void> {
    await using forward = new AsyncDisposableStack();
    forward.defer(this.disconnect);
    await super.cleanup();
  }
}
