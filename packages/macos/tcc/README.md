# @zukhruf/tcc

> **Design for review.** This package has no code yet. The README, the glossary and the ADRs are the API on paper. Nothing is built before the maintainer approves them.

macOS keeps personal data behind privacy grants: Full Disk Access, Contacts, Calendars, Reminders and more. The subsystem that keeps them is TCC (Transparency, Consent, and Control), with its daemon `tccd`, its tool tccutil(1) and its database `TCC.db`. A program that reads a protected store must answer the same questions each time. Which grant opens this store? Does this process have it? Which program does macOS charge the access to, the terminal app or the program itself? What must the user turn on, and where? macOS asks the user for some grants, but never for Full Disk Access: how does the program get the user to the right pane? This package answers them once.

It uses the words of TCC: a **service** is a kind of grant (`kTCCServiceSystemPolicyAllFiles` is Full Disk Access), and a **client** is the program that macOS charges the access to: an app bundle or an executable ([ADR 0001](./docs/adr/0001-the-package-is-named-after-tcc-and-uses-its-words.md)). Each service is a class ([ADR 0002](./docs/adr/0002-each-service-is-a-class-and-its-status-has-apples-values.md)). The package depends on no other package. It uses `node:ffi`, `node:fs` and `node:child_process`. It works only on macOS.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The decisions are in the [ADRs](./docs/adr/).

## Use it

```sh
npm install @zukhruf/tcc
```

## Read the status of a service

Contacts, Calendars and Reminders have a status that macOS gives through their frameworks. `status()` returns Apple's own value for the process that calls it. It never shows a prompt.

```ts
import { Calendars, Contacts, Reminders } from '@zukhruf/tcc';

new Contacts().status(); // 'notDetermined' | 'restricted' | 'denied' | 'authorized'
new Calendars().status(); // 'notDetermined' | 'restricted' | 'denied' | 'fullAccess' | 'writeOnly'
new Reminders().status(); // the same values as Calendars
```

The values are the members of `CNAuthorizationStatus` and `EKAuthorizationStatus` in Apple's SDK headers ([ADR 0002](./docs/adr/0002-each-service-is-a-class-and-its-status-has-apples-values.md)). The first call of `status()` loads `node:ffi`, so Node writes its `ExperimentalWarning` once in that process.

## Check Full Disk Access with a preflight

Full Disk Access has no status. Apple gives no API for it, and no path that proves the grant ([ADR 0003](./docs/adr/0003-full-disk-access-has-no-status-so-the-caller-preflights-its-own-paths.md)). A process learns whether it can read a protected path only when it reads that path. Thus `preflight()` opens each path that you give, the paths that your work will read, and sorts them by the result:

```ts
import { FullDiskAccess } from '@zukhruf/tcc';

const result = await new FullDiskAccess().preflight([
  `${home}/Library/Mail`,
  `${home}/Library/Messages/chat.db`,
]);
result.readable; // the paths that opened
result.denied; // the paths that macOS or the file mode keeps from this process (EPERM, EACCES)
result.missing; // the paths that are not there (ENOENT, ENOTDIR)
```

Do the preflight in the process that does the real work. A grant belongs to the client of a process, and other software (Endpoint Security) can also stop a read that Full Disk Access allows.

## Find the client of a process

macOS charges the access of a process to its responsible process: the app that started it, or the process itself when launchd started it. `Client.responsibleFor(pid)` asks macOS ([ADR 0004](./docs/adr/0004-the-client-comes-from-macos-through-node-ffi.md)):

```ts
import { Client } from '@zukhruf/tcc';

const client = Client.responsibleFor(process.pid);
client.type; // 'bundle' from a terminal app, 'executable' when launchd started the process
client.path; // '/Applications/cmux.app' or '/Users/me/.nvm/versions/node/v26.13.1/bin/node'
client.name; // 'cmux' or the path of the executable: what the user finds in System Settings
```

A program that will run later, such as the `node` of a launchd job, has no process yet. Make its client from its path:

```ts
Client.executable('/Users/me/.nvm/versions/node/v26.13.1/bin/node');
Client.bundle('/Applications/cmux.app');
```

## Tell the user what to turn on

`remedy(client)` gives the sentence that the user acts on ([ADR 0005](./docs/adr/0005-the-remedy-names-the-client-and-the-pane-and-opening-the-pane-is-the-request.md)):

```ts
new Contacts().remedy(client);
// 'Turn on cmux in System Settings › Privacy & Security › Contacts.'

new FullDiskAccess().remedy(client);
// 'Turn on cmux in System Settings › Privacy & Security › Full Disk Access, then quit and reopen cmux. macOS does not ask for this access.'

new FullDiskAccess().remedy(Client.executable(node));
// 'Turn on /Users/me/.nvm/versions/node/v26.13.1/bin/node in System Settings › Privacy & Security › Full Disk Access, then start it again. macOS does not ask for this access.'
```

A grant of Full Disk Access applies to the processes that start after it. Thus the remedy of Full Disk Access tells the user to start the client again: a bundle is quit and opened, an executable is started again. A host that has its own command for that, such as a restart of a launchd job, writes its command after the remedy.

## Open the pane

macOS shows no prompt for Full Disk Access. The nearest step is to open its pane in System Settings, so that the user can turn the client on:

```ts
await new FullDiskAccess().openSettings();
// /usr/bin/open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
```

Each service opens its own pane. Open a pane only when the user asked for the step: System Settings comes to the front.

## Catch the errors that change what you do next

The package has no error class of its own. A preflight gives a denied path and a missing path as data, because the caller does the same next step for each path of a kind. Any other failure of a read, such as `EIO`, is thrown as Node gives it. A failure to load `node:ffi`, for example in a process that runs with `--permission` and without `--allow-ffi`, is thrown as Node gives it.

## What macOS does not do

- **It gives no API that tells whether a process has Full Disk Access.** Kevin Elliott of Apple DTS, August 2026: "there isn't currently a 'general' solution to this issue". On macOS 27, a read of `~/Library/Application Support/com.apple.TCC/TCC.db` fails also when the grant is there ([Apple Developer Forums thread 841091](https://developer.apple.com/forums/thread/841091)).
- **It shows no prompt for Full Disk Access.** The user turns the client on in System Settings.
- **It shows a prompt for Contacts, Calendars and Reminders only to some clients.** The request of a third-party executable completes with no prompt and no grant. `/usr/bin/osascript` holds the private entitlement `com.apple.private.tcc.allow-prompting`, so a request through it shows the prompt (context-compiler memory, 2026-09-30, macOS 27).

## What the package does not do

- **It does not grant access.** Only the user grants it, in System Settings. The package never writes `TCC.db` and never runs `tccutil reset`.
- **It does not guess Full Disk Access.** It has no call that reads a path of its own choice to say yes or no ([ADR 0003](./docs/adr/0003-full-disk-access-has-no-status-so-the-caller-preflights-its-own-paths.md)).
- **It keeps no state.** It exports classes, never an instance, and it has no slot in which a host installs a name ([ADR 0006](./docs/adr/0006-the-package-keeps-no-state.md)).
- **It does not ask for a grant yet.** A request that shows the prompt of Contacts, Calendars or Reminders is in the "later" column of the map below.

## Scope

| Now (this release)                                                                 | Later                                                                                                                             | Never                                                                     |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The services Full Disk Access, Contacts, Calendars and Reminders, with their panes | More services: Accessibility, Automation (Apple events), Screen Recording, Camera, Microphone, Photos, Location, Input Monitoring | A call that guesses Full Disk Access from a path that the package chooses |
| `status()` of Contacts, Calendars and Reminders                                    | `request()` of Contacts, Calendars and Reminders, through `/usr/bin/osascript`                                                    | A write to `TCC.db`, or `tccutil reset`                                   |
| `preflight(paths)` of Full Disk Access                                             | A watch that tells when a grant changes                                                                                           | Support for a macOS older than the newest                                 |
| `Client.responsibleFor(pid)`, `Client.bundle(path)`, `Client.executable(path)`     | A spawn that makes a child process its own client (responsibility disclaim)                                                       |                                                                           |
| `remedy(client)` and `openSettings()` of each service                              |                                                                                                                                   |                                                                           |

## Who uses it

Each consumer moves onto the package after its first release. Each copy is then deleted.

| Consumer                                                                                     | What it does now                                                                                                   | What it uses                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| elt `packages/sdks/macos/app-database/src/macos-access.ts`                                   | The `Grant` type, the pane names and `macOSAccess`, an instance with an `install({ program })` slot                | The service classes and `Client.responsibleFor(process.pid)`. The file is deleted. |
| elt `packages/sdks/macos/app-database/src/store.ts:5-18`                                     | `Store.grant` names the grant of a store                                                                           | `Store.service`, a service class                                                   |
| elt `packages/sdks/macos/app-database/src/unavailable.ts`                                    | `StoreUnavailableError` writes `macOSAccess.remedy(grant)`                                                         | `store.service.remedy(Client.responsibleFor(process.pid))`                         |
| elt `packages/sdks/apple/eventkit/src/errors.ts:8,19`                                        | Writes the remedy of Calendars and Reminders                                                                       | `Calendars` and `Reminders`                                                        |
| context-compiler `apps/cli/src/main.ts:39-59`                                                | `responsibleProgram()` finds the client from environment variables and Spotlight, and installs it in `macOSAccess` | Nothing: the stores ask macOS. The function is deleted.                            |
| context-compiler `apps/cli/src/commands/sync-watch-start.ts:18`                              | Writes the Full Disk Access step of the launchd job's `node`                                                       | `new FullDiskAccess().remedy(Client.executable(node))`                             |
| context-compiler `packages/connectors/connector/src/connector.ts`                            | `guidance()`, and `access()` and `fullDiskAccess` in 27 connector classes                                          | The services of each connector's stores                                            |
| context-compiler `apps/server/src/full-disk-access.ts` (deleted in 89df987, kept in b6bbd73) | `hasFullDiskAccess()` and `openFullDiskAccessSettings()`                                                           | `preflight()` and `openSettings()`                                                 |

## The same concepts in other systems

| System                               | Status                                                                                                      | Request                                            | Open the settings                                            | Full Disk Access                                                 | Client                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Apple frameworks                     | `CNContactStore.authorizationStatus(for:)`, `EKEventStore.authorizationStatus(for:)`                        | `requestAccess(for:)`, `requestFullAccessToEvents` | the URL scheme `x-apple.systempreferences`                   | no API                                                           | no public API; `responsibility_get_pid_responsible_for_pid` in libSystem is private |
| .NET MAUI `Permissions`              | `CheckStatusAsync<T>()`, `PermissionStatus`                                                                 | `RequestAsync<T>()`                                | `AppInfo.ShowSettingsUI()` opens System Settings, not a pane | none                                                             | none                                                                                |
| node-mac-permissions 2.5.0           | `getAuthStatus(type)`                                                                                       | `askForContactsAccess()` and others                | inside `askForFullDiskAccess()`                              | opens four files, `TCC.db` among them                            | none                                                                                |
| tauri-plugin-macos-permissions 2.3.0 | `checkFullDiskAccessPermission()`, a boolean                                                                | `requestFullDiskAccessPermission()`                | inside the request                                           | reads `Library/Safari` and `Library/Containers/com.apple.stocks` | none                                                                                |
| Electron `systemPreferences`         | `getMediaAccessStatus()`: microphone, camera, screen                                                        | `askForMediaAccess()`                              | none                                                         | none                                                             | none                                                                                |
| Flutter permission_handler           | `Permission.contacts.status`                                                                                | `request()`                                        | `openAppSettings()`                                          | none (no macOS package)                                          | none                                                                                |
| react-native-permissions             | `check()`                                                                                                   | `request()`                                        | `openSettings()`                                             | none (no macOS)                                                  | none                                                                                |
| Go (pkg.go.dev, 2026-11-26)          | no maintained package: `tmc/macgo/permissions` maps names to entitlements, imported by 0                    |                                                    |                                                              |                                                                  |                                                                                     |
| Rust (crates.io, 2026-11-26)         | no permission crate: `disclaim` spawns a child as its own client, `axwatch` watches the Accessibility grant |                                                    |                                                              |                                                                  |                                                                                     |

## Why no npm package was used

Searched on 2026-11-26: the `@stdlib` scope ("permission", "privacy", "macos"), and npm for "macos permissions", "mac permissions", "tcc", "macos tcc", "full disk access", "macos privacy", "privacy settings macos" and "system preferences macos". The checks: Full Disk Access with no prompt (1), the status of Contacts, Calendars and Reminders (2), the client of the process (3), the pane of each service (4), Node 26 on macOS 27 (5), ES module with types (6), and no native toolchain (7).

| Package                                   | Last release | Weekly downloads | Why not                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node-mac-permissions 2.5.0                | 2025-03-15   | 8,667            | Fails 3 and 7: no client, and an Objective-C++ addon that node-gyp and Xcode build. Fails 6: its named ES module imports do not load. Its Full Disk Access check opens `TCC.db`, which macOS 27 denies also with the grant. |
| @nut-tree-fork/node-mac-permissions 2.2.1 | 2025-03-15   | 4,846            | A republish of an older node-mac-permissions with a prebuilt binary: fails 3 and 7.                                                                                                                                         |
| @computer-use/node-mac-permissions 2.2.2  | 2025-01-08   | 6,441            | The same JavaScript as the fork above: fails 3 and 7.                                                                                                                                                                       |
| node-macos-disclaim 0.0.1                 | 2026-11-06   | 944              | Only the client (3), as a prebuilt binary: fails 1, 2, 4 and 7.                                                                                                                                                             |
| @mgcrea/mcp-apple-core 1.43.0             | 2026-11-20   | 467              | An MCP server kit that maps an Automation denial after the fact: fails 1 to 4.                                                                                                                                              |
| @stakeswky/openclaw-permctl 0.2.0         | 2026-02-18   | 7                | An agent plugin that matches error text: fails 1 to 3, and ships its TypeScript source as its entry.                                                                                                                        |
| mac-screen-capture-permissions 2.1.0      | 2023-09-11   | 1,449            | Screen Recording only, with Electron prebuilds: fails 1 to 3 and 7.                                                                                                                                                         |
| tauri-plugin-macos-permissions-api 2.3.0  | 2025-05-06   | 50,897           | Runs only in a Tauri app (5), and its plugin is Rust (7).                                                                                                                                                                   |

Node itself has no API for TCC: `process.permission` is the permission model of Node, not of macOS. Node 26 has `node:ffi`, which reaches the frameworks of macOS with no toolchain. The maintainer chose it over a native addon on 2026-11-26.

## API

```ts
export abstract class Service {
  readonly name: string; // the TCC service, e.g. 'kTCCServiceSystemPolicyAllFiles'
  readonly pane: string; // the pane as System Settings names it, e.g. 'Full Disk Access'
  readonly url: URL; // x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles
  remedy(client: Client): string;
  openSettings(): Promise<void>;
}

export class FullDiskAccess extends Service {
  preflight(paths: readonly string[]): Promise<Preflight>;
}

export class Contacts extends Service {
  status(): 'notDetermined' | 'restricted' | 'denied' | 'authorized';
}

export class Calendars extends Service {
  status():
    'notDetermined' | 'restricted' | 'denied' | 'fullAccess' | 'writeOnly';
}

export class Reminders extends Service {
  status():
    'notDetermined' | 'restricted' | 'denied' | 'fullAccess' | 'writeOnly';
}

export class Preflight {
  readonly readable: readonly string[];
  readonly denied: readonly string[];
  readonly missing: readonly string[];
}

export class Client {
  static responsibleFor(pid: number): Client;
  static bundle(path: string): Client;
  static executable(path: string): Client;
  readonly type: 'bundle' | 'executable';
  readonly path: string;
  readonly name: string;
}
```

### Each call and what it does

| Call                                    | What it does                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Contacts().status()`               | Loads `node:ffi`, opens `Contacts.framework`, and sends `+[CNContactStore authorizationStatusForEntityType:]` with `CNEntityTypeContacts` (0) through `objc_msgSend`                           |
| `new Calendars().status()`              | The same with `+[EKEventStore authorizationStatusForEntityType:]` and `EKEntityTypeEvent` (0)                                                                                                  |
| `new Reminders().status()`              | The same with `EKEntityTypeReminder` (1)                                                                                                                                                       |
| `new FullDiskAccess().preflight(paths)` | Opens each path read-only with `node:fs` and closes it at once: EPERM and EACCES are denied, ENOENT and ENOTDIR are missing, any other code is thrown                                          |
| `Client.responsibleFor(pid)`            | Calls `responsibility_get_pid_responsible_for_pid(pid)` and `proc_pidpath()` in libSystem through `node:ffi`. A path inside a `.app` folder gives a bundle; any other path gives an executable |
| `service.remedy(client)`                | Writes the sentence of the service with `client.name` and `service.pane`                                                                                                                       |
| `service.openSettings()`                | Runs `/usr/bin/open` with `service.url`                                                                                                                                                        |

## Documentation

- [CONTEXT.md](./CONTEXT.md): the glossary
- [ADRs](./docs/adr/)
- On each Mac: `man tccutil`, and the SDK headers `Contacts.framework/Headers/CNContactStore.h` and `EventKit.framework/Headers/EKTypes.h`
