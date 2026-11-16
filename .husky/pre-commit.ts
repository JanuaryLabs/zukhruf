#!/usr/bin/env -S node --conditions=@zukhruf/source
// The source condition runs this workspace's own package from src, so a
// fresh clone can commit before anything is built.
import {
  DependencyChecks,
  Format,
  NoNumericPins,
  Sync,
  preCommit,
} from '@zukhruf/git-hooks';

import { ReadmeTable } from '../tools/readme-table/src/readme-table-step.ts';

await preCommit([
  new Sync(),
  new Format(),
  new NoNumericPins(),
  new DependencyChecks(),
  new ReadmeTable(),
]);
