import { fileURLToPath } from 'node:url';

import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Builds an app stylesheet the way the Tailwind CLI does: compile, scan the
 * sources that the stylesheets register, then build from what the scan found.
 * `source(none)` turns off the automatic scan, so only the `@source` of the
 * package's own stylesheet can find its classes.
 */
export async function buildAppStylesheet(appRules = '') {
  const compiler = await compile(
    `@import "tailwindcss" source(none);\n@import "@zukhruf/shadcn/styles.css";\n${appRules}`,
    { base: packageDirectory, onDependency() {} },
  );
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  return compiler.build(candidates);
}
