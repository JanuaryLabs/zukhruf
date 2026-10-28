import type { CancelOptions, Container } from '@zukhruf/docker';

/**
 * Runs `command` in `container` and gives its standard output.
 * A non-zero exit code rejects with the output of the command.
 */
export async function succeeded(
  container: Container,
  command: string[],
  cancel?: CancelOptions,
): Promise<string> {
  const { exitCode, stdout, output } = await container.exec(
    { Cmd: command },
    cancel,
  );
  if (exitCode !== 0)
    throw new Error(`${command[0]} exited with ${exitCode}: ${output}`);
  return stdout;
}
