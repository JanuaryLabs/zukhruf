// The test target of `@zukhruf/nx/test` runs this in the project root:
// `node run.js --test <flags> --selection=<glob>… <forwarded words>`. A
// forwarded word that names test files narrows the run, as
// `nx test <project> -- <file>` does with `@nx/jest` and `@nx/vite`, and then
// the selection goes. The files, the named ones or else the selection, come
// after every other word, because Node reads a flag after a file as a file
// pattern and drops it with exit code 0 when another pattern matches (ADR
// 0004). The other words keep their order, so a value stays after its flag.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { testFile } from './test-file.ts';

const marker = '--selection=';
const words = process.argv.slice(2);
const forwarded = words.filter((word) => !word.startsWith(marker));
const selection = words
  .filter((word) => word.startsWith(marker))
  .map((word) => word.slice(marker.length));
const namesTestFile = (word: string) =>
  !word.startsWith('-') && testFile.test(word);
const named = forwarded.filter(namesTestFile);
const others = forwarded.filter((word) => !namesTestFile(word));

const node = spawn(
  process.execPath,
  [...others, ...(named.length > 0 ? named : selection)],
  { stdio: 'inherit' },
);
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const forward = (signal: NodeJS.Signals) => node.kill(signal);
for (const signal of signals) process.on(signal, forward);
const [code, exitSignal] = await once(node, 'exit');
for (const signal of signals) process.off(signal, forward);
// Node gives the code null when a signal ended the child: this process then
// ends by the same signal.
if (exitSignal === null) {
  process.exitCode = code;
} else {
  process.kill(process.pid, exitSignal);
}
