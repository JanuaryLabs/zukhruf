import { dirname } from 'node:path';

import { downloadFileToCacheDir } from '@huggingface/hub';

import { Manifest } from './manifest.ts';

// The venn-1 head on the Hugging Face Hub, at an immutable commit
// (venn/profiles.py:31).
const HEAD_REPO_ID = 'markrussinovich/venn-1';
const HEAD_REVISION = 'e618a6919e5a15c6ced46c9874424363c2955283';

// Downloads the files of the venn-1 head into the Hugging Face cache and
// gives their directory, as Venn's cli.download_head does
// (venn/cli.py:50). It downloads manifest.json, then each file that the
// manifest lists. A file that the cache holds needs no network, because the
// revision is a commit.
export async function downloadHead(
  options: { readonly cacheDir?: string } = {},
): Promise<string> {
  const download = (file: string) =>
    downloadFileToCacheDir({
      repo: HEAD_REPO_ID,
      path: `assets/${file}`,
      revision: HEAD_REVISION,
      ...options,
    });
  const directory = dirname(await download('manifest.json'));
  const manifest = await Manifest.read(directory);
  await Promise.all([...manifest.digests.keys()].map(download));
  return directory;
}
