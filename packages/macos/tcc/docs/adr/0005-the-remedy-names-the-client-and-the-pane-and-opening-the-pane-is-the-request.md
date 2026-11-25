# The remedy names the client and the pane, and opening the pane is the request

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the context-compiler session context-compiler-99, from the four copies and the leaders below.

Each consumer writes the same sentence today: elt's `macOSAccess.remedy()` ("Turn on <program> in System Settings › Privacy & Security › <pane>."), context-compiler's `Connector.guidance()` ("… then quit and reopen <grantee>. macOS does not ask for this access."), its Calendar, Contacts and Reminders connectors, and its `sync watch start` text. Four places hold one piece of knowledge.

macOS shows no prompt for Full Disk Access. The leaders open its pane in place of a request: node-mac-permissions `askForFullDiskAccess()` opens `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` (`permissions.mm:140`), and so does tauri-plugin-macos-permissions (`full_disk_access.rs:60`). System Settings of macOS 27.2 registers the scheme, and its Privacy & Security extension holds the anchors `Privacy_AllFiles`, `Privacy_Contacts`, `Privacy_Calendars` and `Privacy_Reminders` (probe of 2026-11-26). A grant of Full Disk Access applies to processes that start after it.

## Decision

`service.remedy(client)` gives "Turn on <client name> in System Settings › Privacy & Security › <pane>." For Full Disk Access it adds the step to start the client again ("then quit and reopen <name>" for a bundle, "then start it again" for an executable) and "macOS does not ask for this access." The title of the pane is read from System Settings of the Mac at each call (`plutil -extract en.<key> raw` on the `Localizable.loctable` of `SecurityPrivacyExtension.appex`), because macOS renames panes: the key `ACCESSIBILITY` is "Accessibility" on macOS 26 and "Device Control and Data Access" on macOS 27. `service.openSettings()` runs `/usr/bin/open` with the URL of the pane. A store that two services open names the narrower one, by the principle of least privilege: the Contacts stores name Contacts, not "Contacts or Full Disk Access".

## Considered Options

- **Each consumer keeps its sentence.** Four copies, and a fix in one misses three.
- **A sentence with the host's own restart command**, such as `sync watch restart`. The package cannot know a host's commands. The host writes its command after the remedy.
- **Pane titles written in the package for one macOS version.** The first build named Accessibility "Device Control and Data Access", as macOS 27 does, and CI run 45714385573 on the `macos-26-arm64` runner failed: System Settings there names the same pane "Accessibility". A table for each version would go stale at the next rename.
- **One remedy and one opener for each service, with the title that System Settings of the Mac gives.** This option was selected.

## Consequences

- The sentence of elt's stores for Contacts no longer says "or › Full Disk Access".
- The context-compiler connectors keep only what is theirs to say, such as "Mail's local store is read even while Mail is closed".

## Confirmation

- The pane names and anchors of `Localizable.loctable` and `TCCServiceList.plist` in `SecurityPrivacyExtension.appex` (macOS 27.2), such as `ACCESSIBILITY` = "Device Control and Data Access" and `ALL_FILES` = "Full Disk Access", and the strings `ALL_FILES_QUIT_ALLOW_TITLE` = "“%@” will not have full disk access until it is quit."
- node-mac-permissions `permissions.mm:140`, tauri-plugin-macos-permissions `full_disk_access.rs:60`.
- CI run 45714385573 (2026-11-25, `macos-26-arm64`): `Localizable.loctable` gives "Accessibility" for the key `ACCESSIBILITY`; on this Mac (macOS 27.2) it gives "Device Control and Data Access". `src/services.test.ts` compares each title with the same table read through `plutil -convert json`.
