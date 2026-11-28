import { Command, type Environment, ExitError } from '@zukhruf/process';

export type { Environment } from '@zukhruf/process';

/** The settings that ssh -G prints: one `key value` line each, many lines for a setting with many values. */
export class Settings {
  readonly #values: ReadonlyMap<string, readonly string[]>;

  private constructor(values: ReadonlyMap<string, readonly string[]>) {
    this.#values = values;
  }

  /**
   * Runs `ssh -G <args> -- <destination>` with `environment`. A non-zero exit
   * rejects with ssh's standard error, and the `ExitError` of the run as its
   * cause; a warning on standard error with exit 0 is ignored. The signal
   * stops ssh.
   */
  static async resolve(
    args: readonly string[],
    destination: string,
    environment: Environment,
    signal: AbortSignal | undefined,
  ): Promise<Settings> {
    const ssh = new Command('ssh', ['-G', ...args, '--', destination], {
      env: environment,
      clock: globalThis,
    });
    const run = await ssh.run(signal === undefined ? {} : { signal });
    if (run.exitCode !== 0) {
      throw new Error(run.stderr.trim(), {
        cause: new ExitError('ssh -G', run),
      });
    }
    const values = new Map<string, string[]>();
    for (const line of run.stdout.split('\n')) {
      const space = line.indexOf(' ');
      if (space === -1) continue;
      const key = line.slice(0, space);
      const all = values.get(key) ?? [];
      all.push(line.slice(space + 1));
      values.set(key, all);
    }
    return new Settings(values);
  }

  get(key: string): string | undefined {
    return this.#values.get(key)?.[0];
  }

  getAll(key: string): readonly string[] {
    return this.#values.get(key) ?? [];
  }

  /** The value of a key that ssh -G prints for every host. */
  required(key: string): string {
    const value = this.get(key);
    if (value === undefined) {
      throw new Error(`ssh -G printed no ${key}`);
    }
    return value;
  }
}
