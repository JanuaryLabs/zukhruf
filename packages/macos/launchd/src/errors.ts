/** The base of every error of the package. */
export class LaunchdError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LaunchdError';
  }
}

/** launchctl exited with a code that is not 0. The base of every answer of launchctl that is an error. */
export class LaunchctlError extends LaunchdError {
  /** The arguments after /bin/launchctl, such as ['kickstart', '-p', 'gui/501/com.example.sync']. */
  readonly args: readonly string[];
  /** `launchctl error <code>` decodes it. */
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number, stderr: string) {
    super(`launchctl ${args.join(' ')} exited ${exitCode}: ${stderr.trim()}`);
    this.name = 'LaunchctlError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** launchctl exited 113 (Could not find specified service) for kickstart or kill. */
export class ServiceNotFoundError extends LaunchctlError {
  readonly target: string;

  constructor(
    args: readonly string[],
    exitCode: number,
    stderr: string,
    target: string,
  ) {
    super(args, exitCode, stderr);
    this.name = 'ServiceNotFoundError';
    this.target = target;
  }
}

/** EACCES or EPERM on the job file, or launchctl exit code 1. `cause` is the error of Node.js or the LaunchctlError. */
export class PermissionDeniedError extends LaunchdError {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = 'PermissionDeniedError';
  }
}

/** /bin/launchctl did not start (ENOENT): this system is not macOS. `cause` is the StartError of @zukhruf/process, whose own cause is the error of Node.js. */
export class LaunchdUnavailableError extends LaunchdError {
  constructor(cause: Error) {
    super(`/bin/launchctl did not start: ${cause.message}`, { cause });
    this.name = 'LaunchdUnavailableError';
  }
}
