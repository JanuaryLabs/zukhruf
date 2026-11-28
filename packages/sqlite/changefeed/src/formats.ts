import type { Format, Json } from '@zukhruf/checkpoint';

import type { WalProgress } from './wal-frames.ts';

/** The key columns of a table and the columns that its fingerprints hash. */
export type TableShape = {
  readonly keyColumns: readonly string[];
  /** The columns that the fingerprints hash, in their order. */
  readonly columns: readonly string[];
};

/**
 * The position of a feed: how far its last batch read the owner's WAL, or
 * null when the owner had no WAL.
 */
export const walProgressFormat: Format<WalProgress | null> = {
  version: 1,
  encode: (progress) => progress,
  decode(version, json) {
    requireVersion('position', version);
    if (json === null) return null;
    if (
      isRecord(json) &&
      typeof json.salt === 'string' &&
      typeof json.frames === 'number'
    )
      return { salt: json.salt, frames: json.frames };
    throw new TypeError(
      `The position ${JSON.stringify(json)} is no WAL progress`,
    );
  },
};

export const tableShapeFormat: Format<TableShape> = {
  version: 1,
  encode: (shape) => shape,
  decode(version, json) {
    requireVersion('table', version);
    if (!isRecord(json))
      throw new TypeError(`The table ${JSON.stringify(json)} has no columns`);
    return {
      keyColumns: columnsOf(json.keyColumns),
      columns: columnsOf(json.columns),
    };
  },
};

/** The fingerprint of one row: the hash of each of its columns. */
export const fingerprintFormat: Format<string> = {
  version: 1,
  encode: (fingerprint) => fingerprint,
  decode(version, json) {
    requireVersion('fingerprint', version);
    if (typeof json !== 'string')
      throw new TypeError(
        `The fingerprint ${JSON.stringify(json)} is no string`,
      );
    return json;
  },
};

function requireVersion(value: string, version: number): void {
  if (version !== 1)
    throw new TypeError(
      `The feed reads version 1 of a ${value}, not version ${version}`,
    );
}

function columnsOf(json: Json | undefined): readonly string[] {
  if (json === undefined || !isList(json))
    throw new TypeError(`The columns ${JSON.stringify(json)} are no list`);
  const columns: string[] = [];
  for (const column of json) {
    if (typeof column !== 'string')
      throw new TypeError(`The column ${JSON.stringify(column)} is no name`);
    columns.push(column);
  }
  return columns;
}

function isRecord(json: Json): json is { readonly [key: string]: Json } {
  return typeof json === 'object' && json !== null && !Array.isArray(json);
}

function isList(json: Json): json is readonly Json[] {
  return Array.isArray(json);
}
