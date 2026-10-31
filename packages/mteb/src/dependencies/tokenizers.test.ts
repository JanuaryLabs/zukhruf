import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';

import { Tokenizer } from './tokenizers.ts';

// An endpoint that refuses connections, as the STS fixture reads its cache.
const REFUSING = 'http://127.0.0.1:9';

const COMMIT_1 = '1111111111111111111111111111111111111111';
const COMMIT_2 = '2222222222222222222222222222222222222222';

// Two BPE tokenizers: the first merges "a b", the second does not.
function tokenizerJson(merges: readonly (readonly [string, string])[]) {
  return new TextEncoder().encode(
    JSON.stringify({
      version: '1.0',
      added_tokens: [],
      normalizer: null,
      pre_tokenizer: null,
      post_processor: null,
      decoder: null,
      model: { type: 'BPE', vocab: { a: 0, b: 1, ab: 2 }, merges },
    }),
  );
}
const MERGES = tokenizerJson([['a', 'b']]);
const NO_MERGES = tokenizerJson([]);

type Revision = {
  readonly commit: string;
  readonly bytes: Uint8Array;
  // How the Hub names the content: the sha256 in X-Linked-Etag (Git LFS and
  // Xet, with a redirect to the file), or the git blob id in the ETag.
  readonly storage: 'lfs' | 'git';
  // The content id that the Hub names, when it differs from the bytes.
  readonly id?: string;
};

// A stand-in for the HuggingFace Hub with one model repository, org/tok, and
// one file, tokenizer.json. Its "main" can move. HEAD of the file at main
// answers the commit and the content id; an LFS file redirects to
// /cdn/<commit>, as the Hub redirects to its CDN. Anything else is 404.
async function hub(first: Revision) {
  let main = first;
  const head = '/org/tok/resolve/main/tokenizer.json';
  const server = await new HttpServer().start((request, response) => {
    const { url, method } = request;
    if (url === head && method === 'HEAD') {
      response.setHeader('X-Repo-Commit', main.commit);
      if (main.storage === 'lfs') {
        response.statusCode = 302;
        response.setHeader(
          'X-Linked-Etag',
          `"${main.id ?? createHash('sha256').update(main.bytes).digest('hex')}"`,
        );
        response.setHeader('Location', `/cdn/${main.commit}`);
      } else {
        response.setHeader(
          'ETag',
          `"${
            main.id ??
            createHash('sha1')
              .update(`blob ${main.bytes.length}\0`)
              .update(main.bytes)
              .digest('hex')
          }"`,
        );
      }
      response.end();
      return;
    }
    if (
      method === 'GET' &&
      url === (main.storage === 'lfs' ? `/cdn/${main.commit}` : head)
    ) {
      response.end(main.bytes);
      return;
    }
    response.statusCode = 404;
    response.end('Entry not found');
  });
  return {
    origin: server.origin,
    move(revision: Revision) {
      main = revision;
    },
    [Symbol.asyncDispose]: () => server.cleanup(),
  };
}

function tokens(tokenizer: Tokenizer) {
  return tokenizer.encode('abab', { addSpecialTokens: false }).tokens;
}

function cachedTokenizerFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('tokenizer.json'))
    .map((path) => join(folder, path));
}

test('fromPretrained reads tokenizer.json at the commit that main names, and the cache keeps it under that commit', async () => {
  await using server = await hub({
    commit: COMMIT_1,
    bytes: MERGES,
    storage: 'lfs',
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');

  const tokenizer = await Tokenizer.fromPretrained('org/tok', {
    endpoint: server.origin,
    cacheFolder: cache.path,
  });

  assert.deepEqual(tokens(tokenizer), ['ab', 'ab']);
  const files = cachedTokenizerFiles(cache.path);
  assert.equal(files.length, 1);
  assert.match(files[0] ?? '', new RegExp(COMMIT_1, 'u'));
});

test('when main moves to another commit, the next load reads the file of that commit', async () => {
  await using server = await hub({
    commit: COMMIT_1,
    bytes: MERGES,
    storage: 'lfs',
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');
  const options = { endpoint: server.origin, cacheFolder: cache.path };
  await Tokenizer.fromPretrained('org/tok', options);

  server.move({ commit: COMMIT_2, bytes: NO_MERGES, storage: 'lfs' });
  const moved = await Tokenizer.fromPretrained('org/tok', options);

  assert.deepEqual(tokens(moved), ['a', 'b', 'a', 'b']);
});

test('when the Hub cannot be reached, the load reads the file of the commit that main named last', async () => {
  await using server = await hub({
    commit: COMMIT_1,
    bytes: MERGES,
    storage: 'lfs',
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');
  await Tokenizer.fromPretrained('org/tok', {
    endpoint: server.origin,
    cacheFolder: cache.path,
  });
  server.move({ commit: COMMIT_2, bytes: NO_MERGES, storage: 'lfs' });
  await Tokenizer.fromPretrained('org/tok', {
    endpoint: server.origin,
    cacheFolder: cache.path,
  });

  const offline = await Tokenizer.fromPretrained('org/tok', {
    endpoint: REFUSING,
    cacheFolder: cache.path,
  });

  assert.deepEqual(tokens(offline), ['a', 'b', 'a', 'b']);
});

test('a download whose sha256 is not the sha256 that the Hub names throws, and the cache keeps nothing', async () => {
  await using server = await hub({
    commit: COMMIT_1,
    bytes: MERGES,
    storage: 'lfs',
    id: createHash('sha256').update(NO_MERGES).digest('hex'),
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');

  await assert.rejects(
    Tokenizer.fromPretrained('org/tok', {
      endpoint: server.origin,
      cacheFolder: cache.path,
    }),
    /sha256/u,
  );
  assert.deepEqual(cachedTokenizerFiles(cache.path), []);
  await assert.rejects(
    Tokenizer.fromPretrained('org/tok', {
      endpoint: REFUSING,
      cacheFolder: cache.path,
    }),
  );
});

test('a file outside Git LFS is checked against the git blob id of its ETag', async () => {
  await using good = await hub({
    commit: COMMIT_1,
    bytes: MERGES,
    storage: 'git',
  });
  await using bad = await hub({
    commit: COMMIT_1,
    bytes: MERGES,
    storage: 'git',
    id: createHash('sha1').update(MERGES).digest('hex'),
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');
  await using other = await new TemporaryFiles().directory('mteb-tok-');

  const tokenizer = await Tokenizer.fromPretrained('org/tok', {
    endpoint: good.origin,
    cacheFolder: cache.path,
  });

  assert.deepEqual(tokens(tokenizer), ['ab', 'ab']);
  await assert.rejects(
    Tokenizer.fromPretrained('org/tok', {
      endpoint: bad.origin,
      cacheFolder: other.path,
    }),
    /git blob id/u,
  );
});

test('with nothing in the cache, an endpoint that refuses connections throws the error of huggingface_hub', async () => {
  await using cache = await new TemporaryFiles().directory('mteb-tok-');

  await assert.rejects(
    Tokenizer.fromPretrained('org/tok', {
      endpoint: REFUSING,
      cacheFolder: cache.path,
    }),
    {
      message:
        'An error happened while trying to locate the file on the Hub and we cannot find the requested files in the local cache. Please check your connection and try again or make sure your Internet connection is on.',
    },
  );
});

test('an endpoint without X-Repo-Commit throws the error of huggingface_hub', async () => {
  await using server = await new HttpServer().start((_request, response) => {
    response.setHeader('ETag', '"x"');
    response.end();
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');

  await assert.rejects(
    Tokenizer.fromPretrained('org/tok', {
      endpoint: server.origin,
      cacheFolder: cache.path,
    }),
    {
      message: `Response from ${server.origin}/org/tok/resolve/main/tokenizer.json is missing the 'X-Repo-Commit' header, so it does not seem to be served by a Hugging Face Hub endpoint. If HF_ENDPOINT is set, check that it points to a Hub-compatible endpoint. Otherwise, check your firewall and proxy settings and make sure your SSL certificates are updated.`,
    },
  );
});

test('a repository that the Hub does not have throws with the status of the Hub', async () => {
  await using server = await hub({
    commit: COMMIT_1,
    bytes: MERGES,
    storage: 'lfs',
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');

  await assert.rejects(
    Tokenizer.fromPretrained('org/other', {
      endpoint: server.origin,
      cacheFolder: cache.path,
    }),
    {
      message: `${server.origin}/org/other/resolve/main/tokenizer.json: 404 Not Found`,
    },
  );
});

test('an endpoint without an ETag throws the error of huggingface_hub', async () => {
  await using server = await new HttpServer().start((_request, response) => {
    response.setHeader('X-Repo-Commit', COMMIT_1);
    response.end();
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');

  await assert.rejects(
    Tokenizer.fromPretrained('org/tok', {
      endpoint: server.origin,
      cacheFolder: cache.path,
    }),
    {
      message:
        "Distant resource does not have an ETag, we won't be able to reliably ensure reproducibility.",
    },
  );
});

test('encode adds the special tokens of the post-processor only when addSpecialTokens is true', async () => {
  const template = new TextEncoder().encode(
    JSON.stringify({
      version: '1.0',
      added_tokens: [
        { id: 3, content: '[CLS]', special: true, normalized: false },
      ],
      normalizer: null,
      pre_tokenizer: null,
      post_processor: {
        type: 'TemplateProcessing',
        single: [
          { SpecialToken: { id: '[CLS]', type_id: 0 } },
          { Sequence: { id: 'A', type_id: 0 } },
        ],
        pair: [],
        special_tokens: {
          '[CLS]': { id: '[CLS]', ids: [3], tokens: ['[CLS]'] },
        },
      },
      decoder: null,
      model: { type: 'BPE', vocab: { a: 0, b: 1, ab: 2 }, merges: [] },
    }),
  );
  await using server = await hub({
    commit: COMMIT_1,
    bytes: template,
    storage: 'lfs',
  });
  await using cache = await new TemporaryFiles().directory('mteb-tok-');
  const tokenizer = await Tokenizer.fromPretrained('org/tok', {
    endpoint: server.origin,
    cacheFolder: cache.path,
  });

  const plain = tokenizer.encode('ab', { addSpecialTokens: false });
  const special = tokenizer.encode('ab', { addSpecialTokens: true });

  assert.deepEqual(plain, { ids: [0, 1], tokens: ['a', 'b'] });
  assert.deepEqual(special, { ids: [3, 0, 1], tokens: ['[CLS]', 'a', 'b'] });
});
