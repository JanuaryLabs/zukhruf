#!/usr/bin/env -S node --conditions=@zukhruf/source
// The source condition runs this workspace's own package from src, so a
// fresh clone can commit before anything is built.
import {
  DependencyChecks,
  DockerfileInstallsFromLockfile,
  Format,
  InstallScriptsReviewed,
  LockfileSync,
  NoNumericPins,
  NpmrcPolicy,
  OneRuntimeCopy,
  Sync,
  WorkflowChecks,
  preCommit,
} from '@zukhruf/git-hooks';

import { ReadmeTable } from '../tools/readme-table/src/readme-table-step.ts';

await preCommit([
  new Sync(),
  new Format(),
  new NoNumericPins(),
  new NpmrcPolicy(),
  new LockfileSync(),
  new OneRuntimeCopy({
    allowed: {
      'node_modules/shadcn/node_modules/zod':
        'the shadcn CLI pins zod 3; @zukhruf/shadcn runs it only to write source, and no bundle loads it',
      'node_modules/@shadcn/registry/node_modules/zod':
        '@shadcn/registry, a dependency of the shadcn CLI, pins zod 3; no bundle loads it',
    },
  }),
  new InstallScriptsReviewed(),
  new DockerfileInstallsFromLockfile(),
  new DependencyChecks(),
  new WorkflowChecks(),
  new ReadmeTable(),
]);
