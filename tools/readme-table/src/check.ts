import { join } from 'node:path';

import {
  STALE,
  generatedReadme,
  indexFiles,
  indexed,
} from './packages-table.ts';

const workspace = process.cwd();
const readme = await indexed(workspace, 'README.md');

const generated = await generatedReadme(
  await indexFiles(workspace),
  readme,
  join(workspace, 'README.md'),
);

if (generated !== readme) {
  console.error(STALE);
  process.exitCode = 1;
}
