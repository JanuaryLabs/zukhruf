import { acquireModes } from './acquire-modes.ts';
import { holderCheck } from './holder-check.ts';
import { singleProcess } from './single-process.ts';
import type { Host, Subject } from './subject.ts';

/** The contract of every lock store. */
export function lockStore<H extends Host>(store: Subject<H>): void {
  singleProcess(store);
  acquireModes(store);
  holderCheck(store);
}
