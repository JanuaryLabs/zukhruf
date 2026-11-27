# Code copied from the mutex

This repository follows the Rule of Three, and it counts places, not packages. A second place copies code, and a note records the copy. A third place extracts the code to one home, and the copies go. While both copies exist, a fix to one goes into the other too, and the commit names both files.

## In two places

**`bundled()`: a test's container script with its imports inlined.**

- Places: `mutex/src/lock-stores/file-system/containers.test.ts` and `shutdown/src/shutdown.test.ts`.
- Same: esbuild bundles the script from stdin (the test's folder resolves its imports, with the `@zukhruf/source` condition) into one ES module that `node --eval` runs in a container with Node.js alone. A bind mount would name a path on this machine, and a remote engine (`DOCKER_CONTEXT=devbox`) does not have it.
- Differs: nothing.

Backlog #5981 extracts it when a third test needs it.
