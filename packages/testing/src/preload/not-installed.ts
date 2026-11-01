import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/** The packages that `notInstalled` put in the query of this module's URL. */
const packages = new URL(import.meta.url).searchParams.getAll('package');

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = packages.find(
      (hidden) => specifier === hidden || specifier.startsWith(`${hidden}/`),
    );
    // Only the entry point has no importer, and Node gives it as a file URL.
    if (name === undefined || context.parentURL === undefined)
      return nextResolve(specifier, context);
    if (context.conditions.includes('require'))
      throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
        code: 'MODULE_NOT_FOUND',
      });
    throw Object.assign(
      new Error(
        `Cannot find package '${name}' imported from ${fileURLToPath(context.parentURL)}`,
      ),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
  },
});
