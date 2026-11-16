import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  downloadFileToCacheDir,
  getHFHubCachePath,
  getRepoFolderName,
} from '@huggingface/hub';

import { type Clock, poll } from '@zukhruf/async';
import { FileLock, safeFileName } from '@zukhruf/fs';

import { Manifest } from './manifest.ts';

// The venn-1 head on the Hugging Face Hub, at an immutable commit
// (venn/profiles.py:31).
const HEAD_REPO_ID = 'markrussinovich/venn-1';
const HEAD_REVISION = 'e618a6919e5a15c6ced46c9874424363c2955283';
// The wait between two tries of the lock of a file, as filelock's
// poll_interval of huggingface_hub.
const LOCK_POLL_INTERVAL = 50;

// Downloads the files of the venn-1 head into the Hugging Face cache and
// gives their directory, as Venn's cli.download_head does
// (venn/cli.py:50). It downloads manifest.json, then each file that the
// manifest lists. A file that the cache holds needs no network, because the
// revision is a commit.
export async function downloadHead(options: {
  readonly cacheDir?: string;
  readonly clock: Clock;
}): Promise<string> {
  const { clock, ...cache } = options;
  const cacheDir = cache.cacheDir ?? getHFHubCachePath();
  const repoFolder = getRepoFolderName({ type: 'model', name: HEAD_REPO_ID });
  const snapshot = join(cacheDir, repoFolder, 'snapshots', HEAD_REVISION);
  const locks = join(cacheDir, '.locks', repoFolder);
  // downloadFileToCacheDir of @huggingface/hub 2.17.11 writes each file to
  // one "<blob>.incomplete" for every process and renames it, with no lock,
  // so a second process loses the file that the first renamed (ENOENT), or
  // a reader sees a blob that a second writer still fills (#4457).
  // huggingface_hub holds a file lock in .locks/<repo folder> for each
  // download (file_download.py, _hf_hub_download_to_cache_dir), so this
  // does too. As there, a file that the snapshot holds takes no lock.
  const download = async (file: string) => {
    const path = `assets/${file}`;
    if (existsSync(join(snapshot, path))) return join(snapshot, path);
    await mkdir(locks, { recursive: true });
    using lock = FileLock.open(
      join(locks, `${safeFileName(file, '.lock'.length)}.lock`),
    );
    await poll(async () => (lock.tryLock() ? true : undefined), {
      interval: LOCK_POLL_INTERVAL,
      clock,
      signal: undefined,
    });
    // The lock goes when the download ends, not when it starts.
    return await downloadFileToCacheDir({
      repo: HEAD_REPO_ID,
      path,
      revision: HEAD_REVISION,
      ...cache,
    });
  };
  const directory = dirname(await download('manifest.json'));
  const manifest = await Manifest.read(directory);
  await Promise.all([...manifest.digests.keys()].map(download));
  return directory;
}
