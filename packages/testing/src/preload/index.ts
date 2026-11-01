import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The URL of a preload that makes each package, and each of its subpaths,
 * look not installed in the process that loads it. Give it to the `--import`
 * flag of a child process, once for each preload.
 */
export function notInstalled(...packages: [string, ...string[]]): string {
  // The preload next to this module: `.ts` when Node runs the source, `.js` when it runs the build.
  const extension = extname(fileURLToPath(import.meta.url));
  const preload = new URL(`./not-installed${extension}`, import.meta.url);
  for (const name of packages) preload.searchParams.append('package', name);
  return preload.href;
}
