// Writes the versions that the conventional commits since the last release tag
// ask into the checkout only: it commits, tags and pushes nothing, whatever
// release.version.git says (zukhruf docs/adr/0008). It prints version and
// tagged for GITHUB_OUTPUT, or that the commit has nothing to release.
//
// When a release tag already names HEAD, a run of this commit made the tag and
// stopped before the end (#4692): the version of that tag is written again, so
// that the publish can send what npm does not have. The lock file is not
// updated: nothing reads it after this step.
//
// Run it from the workspace root as `node --input-type=module - < version.mjs`:
// nx/release resolves from the workspace's node_modules.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { releaseVersion } from 'nx/release';

const tagged = execFileSync(
  'git',
  [
    'for-each-ref',
    '--points-at',
    'HEAD',
    '--format=%(refname:strip=2)',
    'refs/tags/release/*',
  ],
  { encoding: 'utf8' },
).trimEnd();
const { workspaceVersion } = await releaseVersion({
  specifier: tagged === '' ? undefined : tagged.slice('release/'.length),
  gitCommit: false,
  gitTag: false,
  gitPush: false,
  stageChanges: false,
  versionActionsOptionsOverrides: { skipLockFileUpdate: true },
});
if (workspaceVersion) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${workspaceVersion}\ntagged=${tagged !== ''}\n`,
  );
} else {
  console.log(`${process.env.GITHUB_SHA} has nothing to release.`);
}
