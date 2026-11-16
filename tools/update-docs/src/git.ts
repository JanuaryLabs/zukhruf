import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitFailed extends Error {
  override name = 'GitFailed';
  readonly exitCode: number;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${args.join(' ')} exited ${exitCode}: ${stderr.trim()}`);
    this.exitCode = exitCode;
  }
}

/** The environment each child process of the tool gets. */
export type Variables = Readonly<Record<string, string | undefined>>;

/** One git working tree, read through the git command line. */
export class Git {
  readonly directory: string;
  readonly #variables: Variables;

  constructor(directory: string, variables: Variables) {
    this.directory = directory;
    this.#variables = variables;
  }

  /** Another git working tree, run with the same environment. */
  at(directory: string): Git {
    return new Git(directory, this.#variables);
  }

  async run(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await run('git', ['-C', this.directory, ...args], {
        encoding: 'utf8',
        env: this.#variables,
        maxBuffer: 512 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (isExit(error)) {
        throw new GitFailed(args, error.code, String(error.stderr));
      }
      throw error;
    }
  }

  /** Output that may not be text, such as a blob. */
  async bytes(args: readonly string[]): Promise<Buffer> {
    try {
      const { stdout } = await run('git', ['-C', this.directory, ...args], {
        encoding: 'buffer',
        env: this.#variables,
        maxBuffer: 512 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (isExit(error)) {
        throw new GitFailed(args, error.code, String(error.stderr));
      }
      throw error;
    }
  }

  /** git grep exits 1 when nothing matches: that is an empty result. */
  async grep(args: readonly string[]): Promise<string> {
    try {
      return await this.run(['grep', ...args]);
    } catch (error) {
      if (error instanceof GitFailed && error.exitCode === 1) {
        return '';
      }
      throw error;
    }
  }
}

function isExit(
  error: unknown,
): error is { code: number; stderr: string | Buffer } {
  return (
    Error.isError(error) &&
    'code' in error &&
    typeof error.code === 'number' &&
    'stderr' in error &&
    (typeof error.stderr === 'string' || Buffer.isBuffer(error.stderr))
  );
}
