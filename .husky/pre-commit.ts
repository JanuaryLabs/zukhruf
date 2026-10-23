#!/usr/bin/env -S node --conditions=@zukhruf/source
// The source condition runs this workspace's own package from src, so a
// fresh clone can commit before anything is built.
import { Format, Sync, preCommit } from '@zukhruf/git-hooks';

await preCommit([new Sync(), new Format()]);
