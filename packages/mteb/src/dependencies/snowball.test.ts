import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// snowball/SHA256SUMS holds the sha256 of each file of jsstemmer-3.1.0.tar.gz
// that this package includes without change.
const FOLDER = join(import.meta.dirname, 'snowball');

test('each Snowball file has the sha256 of its file in jsstemmer-3.1.0.tar.gz, and each file is listed', () => {
  const listed = readFileSync(join(FOLDER, 'SHA256SUMS'), 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [sha256, file] = line.split('  ');
      return [file, sha256];
    });

  const files = readdirSync(FOLDER)
    .filter((file) => file !== 'SHA256SUMS')
    .sort()
    .map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(FOLDER, file)))
        .digest('hex'),
    ]);

  assert.deepEqual(files, listed);
});
