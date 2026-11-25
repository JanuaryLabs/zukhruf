# The package is named after TCC and uses its words

> **Design for review.**

The concept needs a name with no platform prefix: "we prefix by platform/tool only to give it namespace" (the maintainer, 2026-11-26; [root ADR 0013](../../../../../docs/adr/0013-macos-packages-share-one-folder-and-keep-their-names.md)).

The survey of 2026-11-26 found these words for the concept:

| Source                                                                                 | Word for the concept                                    | Word for one kind          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| .NET MAUI, node-mac-permissions, tauri-plugin-macos-permissions, Flutter, React Native | permissions                                             | a permission               |
| Apple's frameworks                                                                     | authorization (`CNAuthorizationStatus`)                 | entity type                |
| Apple's System Settings and user guide                                                 | Privacy & Security                                      | Full Disk Access, Contacts |
| Apple's tool and database                                                              | TCC: tccutil(1) "manage the privacy database", `TCC.db` | service (`kTCCService…`)   |
| Go `tmc/macgo`, crates `disclaim` and `axwatch`, npm `node-macos-disclaim`             | TCC                                                     | service                    |

"Permissions" alone is not clear: Node has its own permission model (`process.permission`, `--permission`), and every platform has permissions. It needs a prefix, which the maintainer refused. "TCC" is clear alone, in the same way as launchd: it is the name of the macOS subsystem, of its daemon `tccd` and of its tool. Apple's guides say "transparency, consent, and control" in full (Apple Platform Security, "Controlling app access to files in macOS").

## Decision

The package is `@zukhruf/tcc`. Its words come from TCC: a **service** is a kind of grant (the column `service` of `TCC.db`, and tccutil(1)), and a **client** is the program that TCC charges (the columns `client` and `client_type`). The status keeps Apple's framework values ([ADR 0002](./0002-each-service-is-a-class-and-its-status-has-apples-values.md)).

## Considered Options

- **`@zukhruf/permissions`.** The word of the cross-platform tools, but it is not clear alone.
- **`@zukhruf/macos-permissions`.** Clear, but the maintainer refused the prefix.
- **`@zukhruf/privacy`.** Apple's section name, but privacy is wider than grants.
- **`@zukhruf/tcc`.** This option was selected.

## Consequences

- A reader who knows `tccutil reset SystemPolicyAllFiles` finds the same words in the code.
- "Grant" names the user's decision, not the kind (CONTEXT.md).
