import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generatedReadme } from './packages-table.ts';

const workspace = process.cwd();
const path = join(workspace, 'README.md');
await writeFile(
  path,
  await generatedReadme(workspace, await readFile(path, 'utf8')),
);
