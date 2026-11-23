import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, compose } from 'node:stream';
import { createGzip } from 'node:zlib';

import { type TarEntry, packTar } from 'modern-tar';
import { type TarSource, packTar as packSources } from 'modern-tar/fs';

import type { WallClock } from '@zukhruf/async';

import { contextPaths } from './dockerignore.ts';

/** A file or a directory of a build context in memory. */
export type BuildFile =
  | { path: string; data: string | Uint8Array; mode?: number }
  | { path: string; directory: true; mode?: number };

/** What `images.build()` sends to the engine as the context of the build. */
export type BuildContext =
  /** A folder on this machine, filtered by its .dockerignore. */
  | { directory: string }
  /** Files in memory. */
  | { files: BuildFile[] }
  /** A tar archive that the caller made. It goes to the engine as it is. */
  | { archive: ReadableStream<Uint8Array> | Uint8Array };

/**
 * The body of POST /build. The package gzips the tar that it writes: BuildKit
 * reads the first 1024 bytes of an uncompressed body as a Dockerfile when they
 * hold no whole tar header, and a first entry with a PAX header fills them
 * (ADR 0016). The gzip magic passes that check for each first entry.
 */
export function buildContextBody(
  context: BuildContext,
  dockerfile: string,
  clock: WallClock,
): Uint8Array | AsyncIterable<Uint8Array> {
  if ('archive' in context) return context.archive;
  const tar =
    'files' in context
      ? Readable.from(filesTar(context.files, new Date(clock.Date.now())))
      : directoryTar(context.directory, dockerfile);
  return compose(tar, createGzip());
}

/** The files with owner 0:0, as the Docker CLI tars a context. */
async function* filesTar(
  files: BuildFile[],
  mtime: Date,
): AsyncGenerator<Uint8Array> {
  const entries = files.map((file): TarEntry => {
    const shared = { uid: 0, gid: 0, mtime };
    if ('directory' in file) {
      return {
        header: {
          ...shared,
          name: `${file.path}/`,
          type: 'directory',
          size: 0,
          mode: file.mode ?? 0o755,
        },
      };
    }
    const data =
      typeof file.data === 'string'
        ? new TextEncoder().encode(file.data)
        : file.data;
    return {
      header: {
        ...shared,
        name: file.path,
        type: 'file',
        size: data.byteLength,
        mode: file.mode ?? 0o644,
      },
      body: data,
    };
  });
  yield await packTar(entries);
}

/**
 * The paths that the .dockerignore of the folder keeps, in the order of the
 * Docker CLI, with the mode, the mtime and the links of the folder. A
 * directory is a source of its own entry only: a directory source of
 * modern-tar would add each entry below it, also the excluded ones.
 */
async function* directoryTar(
  directory: string,
  dockerfile: string,
): AsyncGenerator<Uint8Array> {
  const sources: TarSource[] = [];
  for await (const path of contextPaths(directory, dockerfile)) {
    const source = join(directory, path);
    const stat = await lstat(source);
    sources.push(
      stat.isDirectory()
        ? {
            type: 'content',
            target: `${path}/`,
            content: null,
            mode: stat.mode & 0o7777,
            mtime: stat.mtime,
          }
        : { type: 'file', source, target: path },
    );
  }
  // The fs packer of modern-tar writes the owner of the host; the CLI writes 0:0.
  yield* packSources(sources, {
    map: (header) => ({ ...header, uid: 0, gid: 0 }),
  });
}
