import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

import { PublicKey } from './index.ts';
import {
  KeyError,
  KnownHosts,
  type KnownKey,
  RevokedError,
} from './knownhosts.ts';

const run = promisify(execFile);
const temporaryParent: { parent?: string } =
  process.platform === 'win32' ? {} : { parent: '/tmp' };

async function generateKey(
  directory: string,
  name: string,
  type = 'ed25519',
): Promise<PublicKey> {
  const file = join(directory, name);
  await run('ssh-keygen', ['-q', '-t', type, '-N', '', '-f', file]);
  return PublicKey.parseAuthorizedKey(await readFile(`${file}.pub`, 'utf8'))
    .key;
}

/** The lines that OpenSSH's `ssh-keygen -F` finds for the name, such as `3` or `4 REVOKED`. */
async function openSshFinds(name: string, file: string): Promise<string[]> {
  try {
    const { stdout } = await run('ssh-keygen', ['-F', name, '-f', file]);
    return [...stdout.matchAll(/ found: line (\d+) ?(\S*)/g)].map(
      ([, line, marker]) => `${line} ${marker}`.trim(),
    );
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 1) {
      return [];
    }
    throw error;
  }
}

function wanted(error: unknown): { file: string; line: number; key: string }[] {
  assert.ok(error instanceof KeyError, `expected KeyError, got ${error}`);
  return error.want.map(({ file, line, key }: KnownKey) => ({
    file,
    line,
    key: key.toString(),
  }));
}

test('a host with no line fails with KeyError and an empty want', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'host');
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `other.example ${key}\n`);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const error = catchError(() => knownHosts.check('web.example', 22, key));

  // Assert
  assert.deepEqual(wanted(error), []);
  assert.deepEqual(await openSshFinds('web.example', file), []);
});

test('a host with only other keys fails with KeyError whose want lists each known key with its file and line, past comments and blank lines', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const [first, second, offered] = await Promise.all([
    generateKey(directory.path, 'first'),
    generateKey(directory.path, 'second'),
    generateKey(directory.path, 'offered'),
  ]);
  const file = join(directory.path, 'known_hosts');
  await writeFile(
    file,
    `# a comment\n\n  \t\nweb.example ${first} a comment\nweb.example ${second}\n`,
  );
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const error = catchError(() => knownHosts.check('web.example', 22, offered));

  // Assert
  assert.deepEqual(wanted(error), [
    { file, line: 4, key: first.toString() },
    { file, line: 5, key: second.toString() },
  ]);
  assert.deepEqual(await openSshFinds('web.example', file), ['4', '5']);
});

test('a plain line accepts its key for its host', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'host');
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `web.example ${key}\n`);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const error = catchError(() => knownHosts.check('web.example', 22, key));

  // Assert
  assert.equal(error, undefined);
  assert.deepEqual(await openSshFinds('web.example', file), ['1']);
});

test('a line that ssh-keygen -H hashed accepts its key for its host and its [host]:port, and no other host', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'host');
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `web.example,[web.example]:2222 ${key}\n`);
  await run('ssh-keygen', ['-q', '-H', '-f', file]);
  assert.match(await readFile(file, 'utf8'), /^\|1\|.*\n\|1\|/);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const plain = catchError(() => knownHosts.check('web.example', 22, key));
  const withPort = catchError(() => knownHosts.check('web.example', 2222, key));
  const other = catchError(() => knownHosts.check('db.example', 22, key));

  // Assert
  assert.equal(plain, undefined);
  assert.equal(withPort, undefined);
  assert.deepEqual(wanted(other), []);
  assert.deepEqual(await openSshFinds('web.example', file), ['1']);
  assert.deepEqual(await openSshFinds('[web.example]:2222', file), ['2']);
  assert.deepEqual(await openSshFinds('db.example', file), []);
});

test('a comma list accepts its key for each host in it', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'host');
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `web.example,10.0.0.7 ${key}\n`);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const name = catchError(() => knownHosts.check('web.example', 22, key));
  const address = catchError(() => knownHosts.check('10.0.0.7', 22, key));
  const other = catchError(() => knownHosts.check('10.0.0.8', 22, key));

  // Assert
  assert.equal(name, undefined);
  assert.equal(address, undefined);
  assert.deepEqual(wanted(other), []);
  assert.deepEqual(await openSshFinds('10.0.0.7', file), ['1']);
  assert.deepEqual(await openSshFinds('10.0.0.8', file), []);
});

test('the wildcards * and ? match any run of characters and one character', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const [star, question] = await Promise.all([
    generateKey(directory.path, 'star'),
    generateKey(directory.path, 'question'),
  ]);
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `*.example ${star}\nnode?.lan ${question}\n`);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const starMatch = catchError(() =>
    knownHosts.check('web.eu.example', 22, star),
  );
  const questionMatch = catchError(() =>
    knownHosts.check('node7.lan', 22, question),
  );
  const tooLong = catchError(() =>
    knownHosts.check('node17.lan', 22, question),
  );

  // Assert
  assert.equal(starMatch, undefined);
  assert.equal(questionMatch, undefined);
  assert.deepEqual(wanted(tooLong), []);
  assert.deepEqual(await openSshFinds('web.eu.example', file), ['1']);
  assert.deepEqual(await openSshFinds('node7.lan', file), ['2']);
  assert.deepEqual(await openSshFinds('node17.lan', file), []);
});

test('a negated !pattern keeps its host out of a line that another pattern matches', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'host');
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `*.example,!vault.example ${key}\n`);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const negated = catchError(() => knownHosts.check('vault.example', 22, key));
  const matched = catchError(() => knownHosts.check('web.example', 22, key));

  // Assert
  assert.deepEqual(wanted(negated), []);
  assert.equal(matched, undefined);
  assert.deepEqual(await openSshFinds('vault.example', file), []);
  assert.deepEqual(await openSshFinds('web.example', file), ['1']);
});

test('a port other than 22 looks up [host]:port, and port 22 looks up the plain host', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const [defaultPort, otherPort] = await Promise.all([
    generateKey(directory.path, 'default'),
    generateKey(directory.path, 'other'),
  ]);
  const file = join(directory.path, 'known_hosts');
  await writeFile(
    file,
    `web.example ${defaultPort}\n[web.example]:2222 ${otherPort}\n`,
  );
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const onOtherPort = catchError(() =>
    knownHosts.check('web.example', 2222, otherPort),
  );
  const defaultKeyOnOtherPort = catchError(() =>
    knownHosts.check('web.example', 2222, defaultPort),
  );
  const otherKeyOnDefaultPort = catchError(() =>
    knownHosts.check('web.example', 22, otherPort),
  );

  // Assert
  assert.equal(onOtherPort, undefined);
  assert.deepEqual(wanted(defaultKeyOnOtherPort), [
    { file, line: 2, key: otherPort.toString() },
  ]);
  assert.deepEqual(wanted(otherKeyOnDefaultPort), [
    { file, line: 1, key: defaultPort.toString() },
  ]);
  assert.deepEqual(await openSshFinds('[web.example]:2222', file), ['2']);
  assert.deepEqual(await openSshFinds('web.example', file), ['1']);
});

test('a key on an @revoked line fails with RevokedError and its file and line, also when a line lists it as valid', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'host');
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `web.example ${key}\n@revoked *.example ${key}\n`);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const error = catchError(() => knownHosts.check('web.example', 22, key));

  // Assert
  assert.ok(error instanceof RevokedError, `expected RevokedError: ${error}`);
  assert.deepEqual(
    {
      file: error.revoked.file,
      line: error.revoked.line,
      key: error.revoked.key.toString(),
    },
    { file, line: 2, key: key.toString() },
  );
  assert.deepEqual(await openSshFinds('web.example', file), ['1', '2 REVOKED']);
});

test('an @cert-authority line does not make its key acceptable as a plain host key', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'authority');
  const file = join(directory.path, 'known_hosts');
  await writeFile(file, `@cert-authority web.example ${key}\n`);
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const error = catchError(() => knownHosts.check('web.example', 22, key));

  // Assert
  assert.deepEqual(wanted(error), []);
  assert.deepEqual(await openSshFinds('web.example', file), ['1 CA']);
});

test('several files are read in order, and a missing file is empty', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const [first, second, offered] = await Promise.all([
    generateKey(directory.path, 'first'),
    generateKey(directory.path, 'second'),
    generateKey(directory.path, 'offered'),
  ]);
  const missing = join(directory.path, 'missing');
  const user = join(directory.path, 'known_hosts');
  const global = join(directory.path, 'ssh_known_hosts');
  await writeFile(user, `web.example ${first}\n`);
  await writeFile(global, `# global\nweb.example ${second}\n`);
  const knownHosts = await KnownHosts.read([missing, user, global]);

  // Act
  const fromGlobal = catchError(() =>
    knownHosts.check('web.example', 22, second),
  );
  const unknown = catchError(() =>
    knownHosts.check('web.example', 22, offered),
  );

  // Assert
  assert.equal(fromGlobal, undefined);
  assert.deepEqual(wanted(unknown), [
    { file: user, line: 1, key: first.toString() },
    { file: global, line: 2, key: second.toString() },
  ]);
});

test('hostKeyAlgorithms puts the algorithms of the known keys of the host first, in the order offered', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const [ecdsa, rsa, revoked] = await Promise.all([
    generateKey(directory.path, 'ecdsa', 'ecdsa'),
    generateKey(directory.path, 'rsa', 'rsa'),
    generateKey(directory.path, 'revoked'),
  ]);
  const file = join(directory.path, 'known_hosts');
  await writeFile(
    file,
    [
      `web.example ${ecdsa}`,
      `db.example ${rsa}`,
      `db.example ${revoked}`,
      `@revoked db.example ${revoked}`,
      '',
    ].join('\n'),
  );
  const knownHosts = await KnownHosts.read([file]);

  // Act
  const web = knownHosts.hostKeyAlgorithms('web.example', 22);
  const db = knownHosts.hostKeyAlgorithms('db.example', 22);
  const unknown = knownHosts.hostKeyAlgorithms('other.example', 22);
  const offered = knownHosts.hostKeyAlgorithms('web.example', 22, [
    'ssh-ed25519',
    'rsa-sha2-256',
    'ecdsa-sha2-nistp256',
  ]);

  // Assert
  const supported = [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
  ];
  assert.deepEqual(unknown, supported);
  assert.deepEqual(web, [
    'ecdsa-sha2-nistp256',
    ...supported.filter((algorithm) => algorithm !== 'ecdsa-sha2-nistp256'),
  ]);
  assert.deepEqual(db, [
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
  ]);
  assert.deepEqual(offered, [
    'ecdsa-sha2-nistp256',
    'ssh-ed25519',
    'rsa-sha2-256',
  ]);
});

test('add with hash writes a hashed [host]:port line that OpenSSH finds, into a file it creates, and the key is known at once', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const key = await generateKey(directory.path, 'host');
  const file = join(directory.path, 'dot-ssh', 'known_hosts');
  const knownHosts = await KnownHosts.read([file]);

  // Act
  await knownHosts.add('web.example', 2222, key, { hash: true });

  // Assert
  assert.equal(
    catchError(() => knownHosts.check('web.example', 2222, key)),
    undefined,
  );
  assert.match(await readFile(file, 'utf8'), /^\|1\|[^ ]+ ssh-ed25519 \S+\n$/);
  assert.deepEqual(await openSshFinds('[web.example]:2222', file), ['1']);
  assert.deepEqual(await openSshFinds('web.example', file), []);
  const reread = await KnownHosts.read([file]);
  assert.equal(
    catchError(() => reread.check('web.example', 2222, key)),
    undefined,
  );
});

test('add without hash appends a plain line to the first file on a line of its own, and gives it its line number', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory(
    'ssh-',
    temporaryParent,
  );
  const [existing, added, offered] = await Promise.all([
    generateKey(directory.path, 'existing'),
    generateKey(directory.path, 'added'),
    generateKey(directory.path, 'offered'),
  ]);
  const user = join(directory.path, 'known_hosts');
  const global = join(directory.path, 'ssh_known_hosts');
  await writeFile(user, `db.example ${existing}`);
  await writeFile(global, '');
  const knownHosts = await KnownHosts.read([user, global]);

  // Act
  await knownHosts.add('web.example', 22, added, { hash: false });

  // Assert
  assert.equal(
    await readFile(user, 'utf8'),
    `db.example ${existing}\nweb.example ${added}\n`,
  );
  assert.equal(await readFile(global, 'utf8'), '');
  assert.deepEqual(
    wanted(catchError(() => knownHosts.check('web.example', 22, offered))),
    [{ file: user, line: 2, key: added.toString() }],
  );
  assert.deepEqual(await openSshFinds('web.example', user), ['2']);
});

function catchError(act: () => void): unknown {
  try {
    act();
    return undefined;
  } catch (error) {
    return error;
  }
}
