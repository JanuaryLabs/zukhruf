import { STALE, generatedReadme, indexed } from './packages-table.ts';

const workspace = process.cwd();
const readme = await indexed(workspace, 'README.md');

if ((await generatedReadme(workspace, readme)) !== readme) {
  console.error(STALE);
  process.exitCode = 1;
}
