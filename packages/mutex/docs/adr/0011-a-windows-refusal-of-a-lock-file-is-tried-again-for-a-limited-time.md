# A Windows refusal of a lock file is tried again for a limited time

On Windows, the file lock stores failed now and then. A waiter read a lock file and got `EPERM`, and its process stopped. Windows refuses a file for a moment in two cases. First, a delete of the file is in progress: libuv sets the delete, and until it closes its handle the name is "delete pending", so each open gets `ERROR_ACCESS_DENIED`, which Node.js reports as `EPERM`. Second, another program holds the file open with no sharing, for example a virus scanner: then each open and delete gets `EBUSY`. A test makes the second case certain: PowerShell holds a lock file open with `FileShare.None` while a holder releases, and the release failed with `EBUSY`. Thus each file call on a lock path that other callers share goes through `patiently`. On Windows, `patiently` tries the call again while it gets `EPERM`, `EACCES`, or `EBUSY`, for up to 1 second. After that, the real error reaches the caller. The rename of `replaceFile` already did this, and `patiently` is that same rule for each call.

## Considered Options

- **Try again for as long as a waiter waits.** In `poll`, a refusal could mean "busy", and the waiter would try again at its next poll. But Windows gives the same error for a real permission denial. A waiter would then wait forever, and nobody would see the error.
- **A longer limit.** PostgreSQL tries for 10 seconds, and graceful-fs tries a rename for 60 seconds, because a virus scanner can hold a file for a long time. No failure showed a refusal of more than 1 second, and a longer limit makes a real permission error appear later.
- **Read the NT status.** Only `STATUS_DELETE_PENDING` tells a delete in progress from a permission denial. Node.js does not give that status.

## Consequences

- A release, a read of the holder, a reclaim, and a ticket append or read do not fail when Windows refuses the lock file for less than 1 second.
- When `createExclusive` created the lock file, a failure to remove its draft does not change the result. The draft has a unique name, so it never blocks a key. Before, that failure made the caller think that it did not hold a lock that it held.
- A refusal of more than 1 second fails the call with `EPERM`, `EACCES`, or `EBUSY`.
