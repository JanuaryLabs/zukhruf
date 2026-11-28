// The test target of `@zukhruf/nx/test` runs this in the project root:
// `node run.js --test <flags> --selection=<glob>… <forwarded words>`. A
// forwarded word that names test files narrows the run, as
// `nx test <project> -- <file>` does with `@nx/jest` and `@nx/vite`, and then
// the selection goes. The files, the named ones or else the selection, come
// after every other word, because Node reads a flag after a file as a file
// pattern and drops it with exit code 0 when another pattern matches (ADR
// 0004). The other words keep their order, so a value stays after its flag.
import { Command } from '@zukhruf/process';

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

// node --test reads no stdin. The test process starts in its own session
// (process ADR 0004), so the Ctrl-C of a terminal reaches only this process,
// which passes it on, as it passes on SIGTERM and SIGHUP (process ADR 0011).
const node = await new Command(
  process.execPath,
  [...others, ...(named.length > 0 ? named : selection)],
  { env: process.env, clock: globalThis },
).start({ stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const forward = (signal: NodeJS.Signals) => node.signal(signal);
for (const signal of signals) process.on(signal, forward);
const end = await node.ended;
for (const signal of signals) process.off(signal, forward);
if (end.signal === undefined) {
  process.exitCode = end.exitCode;
} else {
  process.kill(process.pid, end.signal);
}
