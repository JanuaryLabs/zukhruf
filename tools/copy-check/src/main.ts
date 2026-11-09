import { CopyLedgers } from './copy-ledgers.ts';
import { clonesBetweenTestFiles } from './test-file-clones.ts';

const workspace = process.cwd();
const ledgers = await CopyLedgers.read(workspace);
const unrecorded = (await clonesBetweenTestFiles(workspace)).filter(
  ({ first, second }) => !ledgers.records(first.name, second.name),
);

if (unrecorded.length > 0) {
  console.error(
    `Copies in test files that no copy ledger records: ${unrecorded.length}`,
  );
  for (const { first, second, tokens } of unrecorded) {
    console.error(
      `  ${first.name}:${first.start}-${first.end} and ${second.name}:${second.start}-${second.end} (${tokens} tokens)`,
    );
  }
  console.error(
    'Add one line that names both files to docs/copied-code.md or docs/copied-from-*.md of the package, or move the code at its third place (root ADR 0001, rule 2).',
  );
  process.exitCode = 1;
}
