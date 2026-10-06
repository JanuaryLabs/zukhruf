import type { DockerCommand } from './container.ts';

/** A named volume this process created. Disposal removes it. */
export class DockerVolume implements AsyncDisposable {
  readonly name: string;
  readonly #command: DockerCommand;

  constructor(name: string, command: DockerCommand) {
    this.name = name;
    this.#command = command;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#command(['volume', 'rm', '--force', this.name]);
  }
}
