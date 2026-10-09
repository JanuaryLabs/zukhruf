# Fs

Helpers that write files. A reader of the file never sees a part of a write. A process that stops during a write leaves the old content or the new content in the file.

## Language

**Write**:
A caller puts new content into the file at a path.
_Avoid_: Save, store, persist

**Draft**:
A file beside the path, with a unique name. A write fills the draft first. Then it puts the draft at the path.
_Avoid_: Temp file, scratch file

**Replace in one step**:
A write moves its draft over the path with one rename. A reader sees the old content or the new content, never a part of it.
_Avoid_: Atomic (it has more than one meaning), swap, overwrite

**Durable**:
The new content and its replacement are on the disk. They stay after a power loss.
_Avoid_: Safe, flushed, synced (the sync is the operation, not the result)

**Create if absent**:
A write puts its draft at the path only when no file is at the path. When a file is there, the write changes nothing.
_Avoid_: Exclusive (it also names a lock mode), lock

**Refused for now**:
Windows refuses a file for a moment with `EPERM`, `EACCES`, or `EBUSY`. A delete of the file is in progress, or another program holds the file open with no sharing.
_Avoid_: Locked, busy (SQLite uses busy for a different thing)

**Error code**:
The `code` of a Node.js system error, for example `ENOENT`.
_Avoid_: Errno (the C name of a number), status

**Network directory**:
A directory on a file system that other machines share, for example NFS or SMB. File locks in it are not shared reliably between machines.
_Avoid_: Remote directory, mounted directory (a local disk is mounted too)
