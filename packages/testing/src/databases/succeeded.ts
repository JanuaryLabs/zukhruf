import type { ServiceContainer } from '../docker/service-container.ts';

/**
 * Runs `command` in the server's container and gives its standard output.
 * A non-zero exit code rejects with the output of the command.
 */
export async function succeeded(
  { container }: ServiceContainer,
  command: string[],
): Promise<string> {
  const { exitCode, stdout, output } = await container.exec({ Cmd: command });
  if (exitCode !== 0)
    throw new Error(`${command[0]} exited with ${exitCode}: ${output}`);
  return stdout;
}
