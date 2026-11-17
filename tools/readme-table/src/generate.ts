import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generatedReadme, indexFiles } from './packages-table.ts';

const workspace = process.cwd();
const path = join(workspace, 'README.md');
await writeFile(
  path,
  await generatedReadme(
    await indexFiles(workspace),
    await readFile(path, 'utf8'),
    path,
  ),
);
