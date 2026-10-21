import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { safeFileName } from './index.ts';

/** The digest that names a long key: SHA-256 of its UTF-16 code units, in lowercase hex. */
function digestOf(key: string): string {
  return createHash('sha256').update(Buffer.from(key, 'utf16le')).digest('hex');
}

/** The device names that Windows reserves, before the first dot of a file name and in any case. */
const windowsDevices = [
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  ...['com', 'lpt'].flatMap((port) =>
    [...'0123456789¹²³'].map((digit) => `${port}${digit}`),
  ),
];

/** Whether Windows accepts `name` as the name of an ordinary file. */
function isWindowsFileName(name: string): boolean {
  const device = name.split('.')[0]!.trimEnd().toLowerCase();
  return (
    !/[<>:"/\\|?*]/.test(name) &&
    [...name].every((character) => character.charCodeAt(0) >= 0x20) &&
    !/[ .]$/.test(name) &&
    !windowsDevices.includes(device)
  );
}

describe('safeFileName', () => {
  test('keys with a star get names that Windows accepts, each its own', () => {
    // Arrange: Windows refuses '*' in a file name. The other keys are what a star left out, or escaped to another character, could collide with, and a long key with stars gets the hashed name.
    const keys = [
      '*',
      'job*',
      'job**',
      'job',
      'job%2A',
      'job%2a',
      '%2A',
      ...[..."_-~!'()"].map((character) => `job${character}`),
      '*'.repeat(300),
    ];

    // Act
    const names = keys.map(
      (key) => `${safeFileName(key, '.lock'.length)}.lock`,
    );

    // Assert
    const rejected = names.filter((name) => !isWindowsFileName(name));
    assert.deepEqual(rejected, [], 'Windows must accept each name');
    assert.ok(
      names.every((name) => /^[\x20-\x7E]+$/.test(name)),
      `Each name must be ASCII, got ${names.join(', ')}`,
    );
    const folded = new Set(names.map((name) => name.toLowerCase()));
    assert.equal(
      folded.size,
      keys.length,
      `Each key must get its own name, got ${names.join(', ')}`,
    );
  });

  test('keys that are Windows device names, in any case, get names that Windows accepts, each its own', () => {
    // Arrange: callers append a suffix such as '.lock', and Windows still maps 'con.lock' to the console. A key can carry its own extension too. The other keys are what an escaped device name could collide with.
    const devices = windowsDevices.flatMap((device) => [
      device,
      device.toUpperCase(),
      device[0]!.toUpperCase() + device.slice(1),
      device.slice(0, -1) + device.at(-1)!.toUpperCase(),
      `${device}.txt`,
      `${device.toUpperCase()}.x`,
    ]);
    const others = windowsDevices.flatMap((device) => [
      `_${device}`,
      `${device}_`,
      `%${device.charCodeAt(0).toString(16)}${device.slice(1)}`,
      `${device[0]}%${device.charCodeAt(1).toString(16)}${device.slice(2)}`,
    ]);
    const keys = [...new Set([...devices, ...others])];

    // Act
    const names = keys.map(
      (key) => `${safeFileName(key, '.lock'.length)}.lock`,
    );

    // Assert
    const rejected = names.filter((name) => !isWindowsFileName(name));
    assert.deepEqual(rejected, [], 'Windows must accept each name');
    assert.ok(
      names.every((name) => /^[\x20-\x7E]+$/.test(name)),
      `Each name must be ASCII, got ${names.join(', ')}`,
    );
    const folded = new Set(names.map((name) => name.toLowerCase()));
    assert.equal(
      folded.size,
      keys.length,
      `Each key must get its own name, got ${names.join(', ')}`,
    );
  });

  test('a key that only starts like a device name keeps its plain name, and a device name changes in its first character only', () => {
    // Arrange
    const keys = [
      'console',
      'com10',
      'nul1',
      'auxiliary',
      'xcon',
      'acom1',
      'con',
      'lpt9',
    ];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    assert.deepEqual(names, [
      'console',
      'com10',
      'nul1',
      'auxiliary',
      'xcon',
      'acom1',
      '%63on',
      '%6Cpt9',
    ]);
  });

  test('a short key that is not well-formed Unicode gets the hashed name', () => {
    // Arrange: a lone surrogate has no URI encoding.
    const key = 'job\uD800';

    // Act
    const name = safeFileName(key, '.lock'.length);

    // Assert
    assert.equal(name, `job%EF%BF%BD%%${digestOf(key)}`);
  });

  test('two different lone surrogates get different names', () => {
    // Arrange: both become U+FFFD when made well-formed.
    const keys = ['\uD800', '\uDC00'];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    assert.deepEqual(names, [
      '%EF%BF%BD%%205022e3428b7c8276cf247b36e4e512db5651e5cb3472c253d9ee893a8ac750',
      '%EF%BF%BD%%d63ddb2bdab1f3ff8d05c2e27b763c45e9aecc16dfa5265d4825d9e2fbc2e229',
    ]);
  });

  test('a key that fits keeps its encoded name with each dot encoded', () => {
    // Arrange: a slash, an Arabic word and dots, each of which a name must encode.
    const keys = ['orders/حساب.v2', '.', '..'];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    assert.deepEqual(names, [
      'orders%2F%D8%AD%D8%B3%D8%A7%D8%A8%2Ev2',
      '%2E',
      '%2E%2E',
    ]);
  });

  test('keys that differ only in letter case get names that differ in more than letter case', () => {
    // Arrange: APFS and NTFS compare file names without case, so names equal in lowercase are one file there. Each letter is a key in both cases.
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const keys = ['Sync', 'sync', 'SYNC', ...upper, ...upper.toLowerCase()];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    const folded = new Set(names.map((name) => name.toLowerCase()));
    assert.equal(
      folded.size,
      keys.length,
      `Each key must get its own name on a case-insensitive file system, got ${names.join(', ')}`,
    );
  });

  test('a key that ends with a suffix never gets the name of a shorter key plus that suffix', () => {
    // Arrange
    const suffix = '.lock';

    // Act
    const withSuffix = safeFileName('job.lock', suffix.length);
    const shorterPlusSuffix = safeFileName('job', suffix.length) + suffix;

    // Assert
    assert.notEqual(withSuffix, shorterPlusSuffix);
  });

  test('the longest key that fits keeps its name, and one more character gets the hashed name', () => {
    // Arrange: 250 characters plus a suffix of 5 fill a 255-character file name.
    const longest = 'k'.repeat(250);
    const tooLong = 'k'.repeat(251);

    // Act
    const names = [longest, tooLong].map((key) => safeFileName(key, 5));

    // Assert
    assert.deepEqual(names, [
      longest,
      `${'k'.repeat(32)}%%${digestOf(tooLong)}`,
    ]);
  });

  test('the start of a hashed name never ends in a part of an escape', () => {
    // Arrange: 32 characters cut the sixth `%D8%AD` after `%D`, or after `%` when one `a` comes first.
    const keys = ['ح'.repeat(50), `a${'ح'.repeat(50)}`];

    // Act
    const names = keys.map((key) => safeFileName(key, '.lock'.length));

    // Assert
    assert.deepEqual(names, [
      `${'%D8%AD'.repeat(5)}%%${digestOf(keys[0]!)}`,
      `a${'%D8%AD'.repeat(5)}%%${digestOf(keys[1]!)}`,
    ]);
  });

  test('a name plus the longest suffix never passes 255 characters', () => {
    // Arrange
    const longestSuffix = 13;
    const keys = [
      'k'.repeat(10_000),
      'ح'.repeat(10_000),
      '\uD800'.repeat(10_000),
      'k'.repeat(255 - longestSuffix),
      'k'.repeat(256 - longestSuffix),
    ];

    // Act
    const lengths = keys.map(
      (key) => safeFileName(key, longestSuffix).length + longestSuffix,
    );

    // Assert
    assert.ok(
      lengths.every((length) => length <= 255),
      `Each length must be at most 255, got ${lengths.join(', ')}`,
    );
  });

  test('a key spelled like a hashed name does not get that hashed name', () => {
    // Arrange
    const hashed = safeFileName('k'.repeat(251), 5);

    // Act
    const name = safeFileName(hashed, 5);

    // Assert
    assert.notEqual(name, hashed);
  });
});
