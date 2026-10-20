import { spawn } from 'node:child_process';

export interface ScenarioResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The URL of the public entry of the package, for the import of a scenario. */
export const ENTRY = new URL('../index.ts', import.meta.url).href;

/**
 * Runs `source` as an ES module in its own Node process, with `env` as its
 * whole environment: the environment of the test process never reaches it.
 * The signal kills the process.
 */
export async function runScenario(
  source: string,
  env: Record<string, string>,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<ScenarioResult> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { env, signal, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const result = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (result.stdout += chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (result.stderr += chunk));
  child.on('error', () => {
    // The signal killed the process; 'close' still comes.
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  return { exitCode, ...result };
}

/** The last line of the standard output of a scenario, as JSON. */
export function lastJson(result: ScenarioResult): unknown {
  const lines = result.stdout.trim().split('\n');
  const last = lines.at(-1);
  if (last === undefined || last === '') {
    throw new Error(`The scenario wrote no result. stderr:\n${result.stderr}`);
  }
  return JSON.parse(last);
}
