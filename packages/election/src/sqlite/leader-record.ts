import { readFile } from 'node:fs/promises';

import type { Clock } from '@zukhruf/async';
import { atomicWrite, isErrno } from '@zukhruf/fs';

/** What a reader must know about the leader: which pipe to connect to, how long a silence to accept, and which process to end (ADR 0005). */
export interface LeaderRecord {
  /** The epoch of the term that the record is about. */
  epoch: bigint;
  /** `process.pid` of the leader. */
  processId: number;
  /** The path of the leader's pipe. */
  address: string;
  /** The longest silence, in milliseconds, that a reader accepts from this leader. */
  leaseDuration: number;
}

/**
 * Replaces the record in one step, so a reader never sees a part of it. It is
 * not synced to the disk: after a power loss, no process of its term lives.
 */
export async function writeLeaderRecord(
  path: string,
  { epoch, processId, address, leaseDuration }: LeaderRecord,
  clock: Clock,
): Promise<void> {
  const text = JSON.stringify({
    epoch: epoch.toString(),
    processId,
    address,
    leaseDuration,
  });
  await atomicWrite(path, text, { clock });
}

/** The record of the last leader that wrote one, or `undefined` when no leader did. */
export async function readLeaderRecord(
  path: string,
): Promise<LeaderRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const record: unknown = JSON.parse(text);
  if (
    typeof record === 'object' &&
    record !== null &&
    'epoch' in record &&
    typeof record.epoch === 'string' &&
    /^\d+$/.test(record.epoch) &&
    'processId' in record &&
    Number.isSafeInteger(record.processId) &&
    'address' in record &&
    typeof record.address === 'string' &&
    'leaseDuration' in record &&
    typeof record.leaseDuration === 'number' &&
    record.leaseDuration > 0
  ) {
    return {
      epoch: BigInt(record.epoch),
      processId: Number(record.processId),
      address: record.address,
      leaseDuration: record.leaseDuration,
    };
  }
  throw new SyntaxError(
    `The leader record ${path} holds ${JSON.stringify(text)}, not a leader record.`,
  );
}
