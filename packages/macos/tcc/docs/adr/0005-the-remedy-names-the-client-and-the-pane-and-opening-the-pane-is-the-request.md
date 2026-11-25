# The remedy names the client and the pane, and opening the pane is the request

> **Design for review.**

Each consumer writes the same sentence today: elt's `macOSAccess.remedy()` ("Turn on <program> in System Settings › Privacy & Security › <pane>."), context-compiler's `Connector.guidance()` ("… then quit and reopen <grantee>. macOS does not ask for this access."), its Calendar, Contacts and Reminders connectors, and its `sync watch start` text. Four places hold one piece of knowledge.

macOS shows no prompt for Full Disk Access. The leaders open its pane in place of a request: node-mac-permissions `askForFullDiskAccess()` opens `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` (`permissions.mm:140`), and so does tauri-plugin-macos-permissions (`full_disk_access.rs:60`). System Settings of macOS 27.2 registers the scheme, and its Privacy & Security extension holds the anchors `Privacy_AllFiles`, `Privacy_Contacts`, `Privacy_Calendars` and `Privacy_Reminders` (probe of 2026-11-26). A grant of Full Disk Access applies to processes that start after it.

## Decision

`service.remedy(client)` gives "Turn on <client name> in System Settings › Privacy & Security › <pane>." For Full Disk Access it adds the step to start the client again ("then quit and reopen <name>" for a bundle, "then start it again" for an executable) and "macOS does not ask for this access." `service.openSettings()` runs `/usr/bin/open` with the URL of the pane. A store that two services open names the narrower one, by the principle of least privilege: the Contacts stores name Contacts, not "Contacts or Full Disk Access".

## Considered Options

- **Each consumer keeps its sentence.** Four copies, and a fix in one misses three.
- **A sentence with the host's own restart command**, such as `sync watch restart`. The package cannot know a host's commands. The host writes its command after the remedy.
- **One remedy and one opener for each service.** This option was selected.

## Consequences

- The sentence of elt's stores for Contacts no longer says "or › Full Disk Access".
- The context-compiler connectors keep only what is theirs to say, such as "Mail's local store is read even while Mail is closed".
