# Full Disk Access has no status, so the caller preflights its own paths

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the context-compiler session context-compiler-99, from Apple's answer and the probes below.

Apple gives no API that tells whether a process has Full Disk Access. In August 2026 a developer reported that a read of `~/Library/Application Support/com.apple.TCC/TCC.db` fails on macOS 27 also when the grant is there. Kevin Elliott of Apple DTS answered that there is no API, no other supported method and no path that proves the grant: "The answer to all three of these questions remains 'no'". His advice: "create a list of data locations you know to be critical … and spot-check those locations", and "make your preflight check process match your actual backup process as closely as possible", because Endpoint Security can stop a read "even [with] FDA" ([thread 841091](https://developer.apple.com/forums/thread/841091)).

The leading tools guess from a path of their own choice. node-mac-permissions opens Safari's `Bookmarks.plist`, `TCC.db`, the Time Machine preferences and Safari's `CloudTabs.db` (`permissions.mm:296-320`). tauri-plugin-macos-permissions reads `Library/Safari` and `Library/Containers/com.apple.stocks` (`full_disk_access.rs:26`). On this Mac (macOS 27.2) the per-user `com.apple.TCC` folder is not there at all (ENOENT, probe of 2026-11-26), and the system folder `/Library/Application Support/com.apple.TCC` opened only because the process had the grant.

The context-compiler server had such a guess, `hasFullDiskAccess()` over the system folder (deleted in 89df987).

## Decision

`FullDiskAccess` has no `status()`. It has `preflight(paths)`: the caller gives the paths that its work will read, and the package opens each one read-only in the calling process, closes it, and sorts it as readable, denied (EPERM, EACCES) or missing (ENOENT, ENOTDIR). Any other error is thrown. These are the codes that `@zukhruf/sqlite-open` sorts the same way for a database (`packages/sqlite/open/src/unavailable-error.ts:12`).

## Considered Options

- **A status from a path that the package chooses**, as node-mac-permissions and Tauri do. Apple says no path proves the grant, and the path of the leading tool fails on macOS 27.
- **No call for Full Disk Access.** Each caller writes the same open-and-sort loop again.
- **A preflight of the caller's own paths.** This option was selected: it is Apple's advice, and it is EAFP (the real operation is the test).

## Consequences

- A preflight tells about the paths it opened, not about the grant. A denied path can also come from the file mode or from Endpoint Security, so the remedy says what to turn on, and the caller says which paths failed.

## Confirmation

- Apple Developer Forums thread 841091 (August 2026), the answers of Kevin Elliott, DTS.
- Probe of 2026-11-26 on macOS 27.2: `~/Library/Application Support/com.apple.TCC` gives ENOENT; `lsof` on the user `tccd` shows its `TCC.db` in `/private/var/containers/Data/ProtectedSystem/…`, which sqlite3 cannot open also with the grant.
- The tests of `preflight()` sort a readable file, a file with mode `000` (EACCES), a missing path (ENOENT) and a path under a file (ENOTDIR).
