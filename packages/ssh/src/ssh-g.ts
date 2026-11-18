import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** The variables of the caller's environment. ssh -G runs with them as its whole environment. */
export type Environment = Readonly<Record<string, string | undefined>>;

const run = promisify(execFile);

/** The settings that ssh -G prints: one `key value` line each, many lines for a setting with many values. */
export class Settings {
  readonly #values: ReadonlyMap<string, readonly string[]>;

  private constructor(values: ReadonlyMap<string, readonly string[]>) {
    this.#values = values;
  }

  /**
   * Runs `ssh -G <args> -- <destination>` with `environment`. A non-zero exit
   * rejects with ssh's standard error, and a cause whose `code` is the exit
   * code; a warning on standard error with exit 0 is ignored. The signal
   * stops ssh.
   */
  static async resolve(
    args: readonly string[],
    destination: string,
    environment: Environment,
    signal: AbortSignal | undefined,
  ): Promise<Settings> {
    let stdout: string;
    try {
      ({ stdout } = await run('ssh', ['-G', ...args, '--', destination], {
        env: environment,
        encoding: 'utf8',
        ...(signal === undefined ? {} : { signal }),
      }));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isExit(error)) {
        throw new Error(error.stderr.trim(), { cause: error });
      }
      throw error;
    }
    const values = new Map<string, string[]>();
    for (const line of stdout.split('\n')) {
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

function isExit(
  error: unknown,
): error is Error & { readonly code: number; readonly stderr: string } {
  return (
    Error.isError(error) &&
    'code' in error &&
    typeof error.code === 'number' &&
    'stderr' in error &&
    typeof error.stderr === 'string'
  );
}
