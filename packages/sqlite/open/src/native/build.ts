// Builds the native library for each platform with zig cc, from one machine
// (ADR 0006). The files go to lib/<platform>-<arch>/ at the package root,
// where PersistentWriteAheadLog finds them from src/ and from dist/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const source = join(import.meta.dirname, 'persist_wal.c');
const lib = join(import.meta.dirname, '..', '..', 'lib');

// The folder names are process.platform-process.arch. The Linux library
// calls no function of the C library, so -nostdlib gives one file that loads
// with glibc and with musl.
const targets = [
  {
    folder: 'darwin-arm64',
    target: 'aarch64-macos',
    file: 'persist_wal.dylib',
    flags: [],
  },
  {
    folder: 'darwin-x64',
    target: 'x86_64-macos',
    file: 'persist_wal.dylib',
    flags: [],
  },
  {
    folder: 'linux-arm64',
    target: 'aarch64-linux-gnu',
    file: 'persist_wal.so',
    flags: ['-nostdlib'],
  },
  {
    folder: 'linux-x64',
    target: 'x86_64-linux-gnu',
    file: 'persist_wal.so',
    flags: ['-nostdlib'],
  },
  {
    folder: 'win32-arm64',
    target: 'aarch64-windows-gnu',
    file: 'persist_wal.dll',
    flags: [],
  },
  {
    folder: 'win32-x64',
    target: 'x86_64-windows-gnu',
    file: 'persist_wal.dll',
    flags: [],
  },
];

rmSync(lib, { recursive: true, force: true });
for (const { folder, target, file, flags } of targets) {
  const out = join(lib, folder);
  mkdirSync(out, { recursive: true });
  execFileSync(
    'zig',
    [
      'cc',
      '-target',
      target,
      '-O2',
      '-shared',
      '-fPIC',
      ...flags,
      '-o',
      join(out, file),
      source,
    ],
    { stdio: 'inherit' },
  );
  // zig also writes an import library and debug symbols for Windows. Only the
  // library that SQLite loads ships.
  for (const other of readdirSync(out).filter((name) => name !== file))
    rmSync(join(out, other));
}
