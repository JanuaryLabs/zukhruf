import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { HubOptions } from './datasets.ts';

// The part of tokenizers 0.23.3 that MTEB's BM25 uses:
// Tokenizer.from_pretrained, which reads tokenizer.json of a model
// repository of the HuggingFace Hub at "main" through huggingface_hub's
// hf_hub_download, and encode(...).tokens. @huggingface/tokenizers 0.2.0
// runs the tokenizer.json.

const DEFAULT_ENDPOINT = 'https://huggingface.co';

export const DEFAULT_MODEL_CACHE = join(homedir(), '.cache', 'mteb', 'models');

export type Encoding = {
  readonly ids: readonly number[];
  readonly tokens: readonly string[];
};

type HfTokenizer = InstanceType<
  typeof import('@huggingface/tokenizers').Tokenizer
>;

export class Tokenizer {
  readonly #tokenizer: HfTokenizer;

  private constructor(tokenizer: HfTokenizer) {
    this.#tokenizer = tokenizer;
  }

  // Python's Tokenizer reads only tokenizer.json, never
  // tokenizer_config.json. The empty config keeps the options of
  // @huggingface/tokenizers that Python does not have (remove_space,
  // do_lowercase_and_remove_accent) off. The package loads on the first
  // call, so a host that never reads a Hub tokenizer does not need it.
  static async fromPretrained(
    identifier: string,
    hub: HubOptions,
  ): Promise<Tokenizer> {
    const json: unknown = JSON.parse(
      new TextDecoder().decode(
        await hubFile(identifier, 'main', 'tokenizer.json', hub),
      ),
    );
    const { Tokenizer: HfTokenizerClass } =
      await import('@huggingface/tokenizers');
    return new Tokenizer(new HfTokenizerClass(json, {}));
  }

  encode(text: string, options: { readonly addSpecialTokens: boolean }) {
    const { ids, tokens }: Encoding = this.#tokenizer.encode(text, {
      add_special_tokens: options.addSpecialTokens,
    });
    return { ids, tokens };
  }
}

// hf_hub_download (huggingface_hub 2.4.0, file_download.py) for a file of a
// model repository: a HEAD request names the commit of the revision
// (X-Repo-Commit) and the content of the file (the ETag), the file stays at
// <cache>/<repository>/<commit>/<path>, and refs/<revision> keeps the commit.
// When the Hub cannot be reached, the commit of refs/<revision> gives the
// file. huggingface_hub does not check the bytes that it downloads; here a
// download that does not match its ETag throws.
async function hubFile(
  repository: string,
  revision: string,
  path: string,
  hub: HubOptions,
): Promise<Uint8Array> {
  const endpoint = hub.endpoint ?? DEFAULT_ENDPOINT;
  const storage = join(hub.cacheFolder ?? DEFAULT_MODEL_CACHE, repository);
  const ref = join(storage, 'refs', revision);
  const url = `${endpoint}/${repository}/resolve/${encodeURIComponent(revision)}/${path}`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  } catch (error) {
    // fetch rejects with a TypeError only when the request cannot reach the
    // server, as httpx raises ConnectError.
    if (!(error instanceof TypeError)) throw error;
    return readOffline(storage, ref, path, error);
  }
  if (response.status >= 400)
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const commit = response.headers.get('x-repo-commit');
  if (commit === null)
    throw new Error(
      `Response from ${url} is missing the 'X-Repo-Commit' header, so it does not seem to be served by a Hugging Face Hub endpoint. If HF_ENDPOINT is set, check that it points to a Hub-compatible endpoint. Otherwise, check your firewall and proxy settings and make sure your SSL certificates are updated.`,
    );
  const content = contentOf(response.headers);
  const file = join(storage, commit, path);
  if (!existsSync(file)) {
    const location = response.headers.get('location');
    const download = await fetch(
      location === null ? url : new URL(location, url),
    );
    if (!download.ok)
      throw new Error(`${url}: ${download.status} ${download.statusText}`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    const digest =
      content.kind === 'lfs'
        ? createHash('sha256').update(bytes).digest('hex')
        : createHash('sha1')
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest('hex');
    if (digest !== content.id)
      throw new Error(
        `${url}: the download has the ${content.kind === 'lfs' ? 'sha256' : 'git blob id'} ${digest}, and the Hub names ${content.id}.`,
      );
    keep(file, bytes);
  }
  keep(ref, commit);
  return readFileSync(file);
}

// What the ETag names: the sha256 of a file of Git LFS or Xet (the
// X-Linked-Etag of the redirect), or else the git blob id of the file.
// _normalize_etag strips the characters W and / at the start (lstrip) and
// the quotes at both ends.
function contentOf(headers: Headers): {
  readonly kind: 'lfs' | 'git';
  readonly id: string;
} {
  const linked = headers.get('x-linked-etag');
  const etag = linked ?? headers.get('etag');
  if (etag === null)
    throw new Error(
      "Distant resource does not have an ETag, we won't be able to reliably ensure reproducibility.",
    );
  return {
    kind: linked === null ? 'git' : 'lfs',
    id: etag.replace(/^[W/]+/u, '').replace(/^"+|"+$/gu, ''),
  };
}

function readOffline(
  storage: string,
  ref: string,
  path: string,
  cause: TypeError,
): Uint8Array {
  const commit = readIfPresent(ref);
  const file =
    commit === null
      ? null
      : readIfPresent(join(storage, new TextDecoder().decode(commit), path));
  if (file === null)
    throw new Error(
      'An error happened while trying to locate the file on the Hub and we cannot find the requested files in the local cache. Please check your connection and try again or make sure your Internet connection is on.',
      { cause },
    );
  return file;
}

function readIfPresent(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

// Writes a file of the cache in one step, so that a reader never sees part
// of it.
function keep(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, data);
  renameSync(partial, path);
}
