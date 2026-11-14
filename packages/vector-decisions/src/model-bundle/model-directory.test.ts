import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { modelDirectory } from '../index.ts';

function sha256(content: string): string {
  return hash('sha256', content);
}

// The manifest as Venn's publish script writes it (scripts/publish_head.py).
function manifest(digests: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({ sha256: digests }, null, 2)}\n`;
}

test('a file whose bytes differ from its digest is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  await writeFile(join(directory.path, 'config.json'), '{}');
  await writeFile(join(directory.path, 'universal.safetensors'), 'changed');
  await writeFile(
    join(directory.path, 'manifest.json'),
    manifest({
      'config.json': sha256('{}'),
      'universal.safetensors': sha256('original'),
    }),
  );

  await assert.rejects(modelDirectory(directory.path), {
    name: 'InvalidModelArtifactError',
    message:
      /universal\.safetensors does not match its SHA-256 in manifest\.json/,
  });
});

test('a name that leads out of the folder is refused, though its digest matches', async () => {
  await using root = await new TemporaryFiles().directory('vector-decisions-');
  const head = join(root.path, 'head');
  await mkdir(join(head, 'sub'), { recursive: true });
  await writeFile(join(root.path, 'outside.json'), 'outside');
  await writeFile(join(head, 'sub', 'inner.json'), 'inner');
  await writeFile(join(head, 'config.json'), '{}');
  const names = {
    '../outside.json': sha256('outside'),
    'sub/inner.json': sha256('inner'),
    'sub/../config.json': sha256('{}'),
    '': sha256(''),
    [join(root.path, 'outside.json')]: sha256('outside'),
    '.': sha256(''),
    '..': sha256(''),
  };

  for (const [name, digest] of Object.entries(names)) {
    await writeFile(join(head, 'manifest.json'), manifest({ [name]: digest }));
    await assert.rejects(
      modelDirectory(head),
      {
        name: 'InvalidModelArtifactError',
        message: /is not a file of the model directory/,
      },
      name,
    );
  }
});

test('a folder with no manifest.json is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  await writeFile(join(directory.path, 'config.json'), '{}');

  await assert.rejects(modelDirectory(directory.path), { code: 'ENOENT' });
});

test('a file that the manifest lists and the folder lacks is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  await writeFile(join(directory.path, 'config.json'), '{}');
  await writeFile(
    join(directory.path, 'manifest.json'),
    manifest({
      'config.json': sha256('{}'),
      'universal.safetensors': sha256('weights'),
    }),
  );

  await assert.rejects(modelDirectory(directory.path), { code: 'ENOENT' });
});

test('a manifest that is not JSON or has no SHA-256 map is refused', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  // A flat map of file names to digests, with no sha256 key, is not a
  // manifest, though its file matches.
  await writeFile(join(directory.path, 'config.json'), '{}');
  const broken = [
    JSON.stringify({ 'config.json': sha256('{}') }),
    '{"sha256": {"config.json": ',
    '{"files": {"config.json": "abc"}}',
    '{"sha256": {"config.json": 7}}',
    '{"sha256": []}',
    '{"sha256": null}',
    'null',
  ];

  for (const text of broken) {
    await writeFile(join(directory.path, 'manifest.json'), text);
    await assert.rejects(
      modelDirectory(directory.path),
      {
        name: 'InvalidModelArtifactError',
        message: /manifest\.json is not \{ sha256: \{ <file>: <digest> \} \}/,
      },
      text,
    );
  }
});

test('a folder whose files match gives the folder, links into blobs too', async () => {
  await using directory = await new TemporaryFiles().directory(
    'vector-decisions-',
  );
  const head = join(directory.path, 'snapshot');
  const blobs = join(directory.path, 'blobs');
  await mkdir(head);
  await mkdir(blobs);
  await writeFile(join(blobs, 'abc123'), 'weights');
  // The Hub cache links a file to its blob by a relative path.
  await symlink('../blobs/abc123', join(head, 'universal.safetensors'));
  await writeFile(join(head, 'config.json'), '{}');
  await writeFile(
    join(head, 'manifest.json'),
    manifest({
      'config.json': sha256('{}'),
      'universal.safetensors': sha256('weights'),
    }),
  );

  assert.equal(await modelDirectory(head), head);
});
