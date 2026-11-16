#!/usr/bin/env -S node --conditions=@zukhruf/source
// The source condition runs this workspace's own package from src, so the
// hook works before anything is built. Every session pushes from this one
// checkout, and each push sends every local commit: Build proves each of them
// in a snapshot, not the working tree that peers are editing.
import { Build, prePush } from '@zukhruf/git-hooks';

await prePush([new Build()]);
