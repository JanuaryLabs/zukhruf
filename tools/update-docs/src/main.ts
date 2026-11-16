import { homedir } from 'node:os';

import { UpdateDocsError } from './errors.ts';
import { UpdateDocs } from './update-docs.ts';

try {
  const { exitCode, stdout } = await new UpdateDocs({
    home: process.env.HOME ?? homedir(),
    repoRoot: process.cwd(),
    variables: process.env,
  }).run(process.argv.slice(2));
  process.stdout.write(stdout);
  process.exitCode = exitCode;
} catch (error) {
  if (!(error instanceof UpdateDocsError)) {
    throw error;
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
