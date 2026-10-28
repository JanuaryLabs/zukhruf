import type { TextKind } from '../answer-key.ts';
import { EcbPlusCorpus } from './ecbplus.ts';
import { GunViolenceCorpus } from './gvc.ts';
import { HeadlineGroupingRelease } from './hlgd.ts';
import type { TextSource } from './text-source.ts';
import { WcepRows } from './wcep.ts';
import { WebPages } from './web.ts';

// The source of the texts of each kind of set.
export const SOURCES: Record<TextKind, TextSource> = {
  gvc: new GunViolenceCorpus(),
  ecbplus: new EcbPlusCorpus(),
  hlgd: new HeadlineGroupingRelease(),
  wcep: new WcepRows(),
  web: new WebPages(),
};
