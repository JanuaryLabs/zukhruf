# @zukhruf/tcc

macOS keeps personal data and devices behind privacy grants: Full Disk Access, Contacts, Camera, Screen Recording and more. The subsystem that keeps them is TCC (Transparency, Consent, and Control), with its daemon `tccd`, its tool tccutil(1) and its database `TCC.db`. A program that needs one must answer the same questions each time. What is the status of the grant for this process? How does the program ask the user? Which program does macOS charge the access to: the terminal app, or the program itself? What must the user turn on, and where? macOS gives no status and no prompt for Full Disk Access: how does the program find out, and get the user to the right pane? This package answers them once, for each service that the leading tools cover.

It uses the words of TCC: a **service** is a kind of grant (`kTCCServiceSystemPolicyAllFiles` is Full Disk Access), and a **client** is the program that macOS charges the access to: an app bundle or an executable ([ADR 0001](./docs/adr/0001-the-package-is-named-after-tcc-and-uses-its-words.md)). Each service is a class with Apple's own status values ([ADR 0002](./docs/adr/0002-each-service-is-a-class-and-its-status-has-apples-values.md)). The package depends on no other package. It uses `node:ffi`, `node:fs` and `node:child_process`, and it works only on macOS.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/tcc
```

```ts
import { Camera, Client } from '@zukhruf/tcc';

const camera = new Camera();
if (camera.status() === 'notDetermined') await camera.request({ signal });
if (camera.status() !== 'authorized')
  console.error(camera.remedy(Client.responsibleFor(process.pid)));
```

## Read the status of a service

`status()` returns Apple's own value for the calling process. It never shows a prompt. The first call in a process loads `node:ffi`, and Node writes its `ExperimentalWarning` once.

| Class               | TCC service                       | `status()` values                                                    | Apple's API                                                        |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Contacts`          | `kTCCServiceAddressBook`          | `notDetermined`, `restricted`, `denied`, `authorized`                | `+[CNContactStore authorizationStatusForEntityType:]`              |
| `Calendars`         | `kTCCServiceCalendar`             | `notDetermined`, `restricted`, `denied`, `fullAccess`, `writeOnly`   | `+[EKEventStore authorizationStatusForEntityType:]`, event         |
| `Reminders`         | `kTCCServiceReminders`            | the same as `Calendars`                                              | the same, reminder                                                 |
| `Camera`            | `kTCCServiceCamera`               | `notDetermined`, `restricted`, `denied`, `authorized`                | `+[AVCaptureDevice authorizationStatusForMediaType:]`, video       |
| `Microphone`        | `kTCCServiceMicrophone`           | the same as `Camera`                                                 | the same, audio                                                    |
| `Photos`            | `kTCCServicePhotos`               | `notDetermined`, `restricted`, `denied`, `authorized`, `limited`     | `+[PHPhotoLibrary authorizationStatusForAccessLevel:]`, read-write |
| `PhotosAdd`         | `kTCCServicePhotosAdd`            | the same as `Photos`                                                 | the same, add only                                                 |
| `SpeechRecognition` | `kTCCServiceSpeechRecognition`    | `notDetermined`, `denied`, `restricted`, `authorized`                | `+[SFSpeechRecognizer authorizationStatus]`                        |
| `Bluetooth`         | `kTCCServiceBluetoothAlways`      | `notDetermined`, `restricted`, `denied`, `allowedAlways`             | `CBManager.authorization`                                          |
| `InputMonitoring`   | `kTCCServiceListenEvent`          | `granted`, `denied`, `unknown`                                       | `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)`                   |
| `Accessibility`     | `kTCCServiceAccessibility`        | `trusted`, `notTrusted`                                              | `AXIsProcessTrusted()`                                             |
| `ScreenRecording`   | `kTCCServiceScreenCapture`        | `granted`, `notGranted`                                              | `CGPreflightScreenCaptureAccess()`                                 |
| `Automation`        | `kTCCServiceAppleEvents`          | `permitted`, `notPermitted`, `wouldRequireUserConsent`, `notRunning` | `AEDeterminePermissionToAutomateTarget()`, with no prompt          |
| `FullDiskAccess`    | `kTCCServiceSystemPolicyAllFiles` | none: see the preflight below                                        | none                                                               |

`Automation` is a grant for one target app: `new Automation('com.apple.Finder')`. Its status is `notRunning` while the target app does not run, because macOS asks the target (`AppleEvents.h:346`, [ADR 0002](./docs/adr/0002-each-service-is-a-class-and-its-status-has-apples-values.md)).

## Ask the user for a service

`request()` asks macOS to show its prompt, and resolves with the status after the user answers. It runs `/usr/bin/osascript`, because macOS shows the prompt only to a program that holds Apple's private entitlement `com.apple.private.tcc.allow-prompting`, and `osascript` holds it ([ADR 0007](./docs/adr/0007-a-request-runs-in-osascript-which-may-show-the-prompt.md)). The grant goes to the client of the calling process, the same one that `status()` reads.

```ts
const status = await new Contacts().request({ signal }); // 'authorized' after Allow
```

macOS shows a prompt only while the status is `notDetermined` (or `writeOnly` for Calendars and Reminders, where the request asks for full access). After a denial it shows nothing, and `request()` resolves with the same status: send the user to the pane. For Accessibility, Input Monitoring and Screen Recording, macOS shows a dialog that sends the user to System Settings, where the user turns the client on; `request()` resolves when the dialog shows, with the status as it is then. `FullDiskAccess` has no `request()`: macOS shows nothing for it. The `signal` stops the wait: the package ends `osascript`, and the promise rejects with the signal's reason.

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

Do the preflight in the process that does the real work. A grant belongs to the client of a process, and other software, such as Endpoint Security, can also stop a read that Full Disk Access allows.

## Find the client of a process

macOS charges the access of a process to its responsible process: the app that started it, or the process itself when launchd started it. `Client.responsibleFor(pid)` asks macOS ([ADR 0004](./docs/adr/0004-the-client-comes-from-macos-through-node-ffi.md)):

```ts
import { Client } from '@zukhruf/tcc';

const client = Client.responsibleFor(process.pid);
client.type; // 'bundle' from a terminal app, 'executable' when launchd started the process
client.path; // '/Applications/cmux.app' or '/Users/me/.nvm/versions/node/v26.13.1/bin/node'
client.name; // 'cmux', or the path of the executable: what the user finds in System Settings
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

new Accessibility().remedy(client);
// 'Turn on cmux in System Settings › Privacy & Security › Device Control and Data Access.'

new FullDiskAccess().remedy(client);
// 'Turn on cmux in System Settings › Privacy & Security › Full Disk Access, then quit and reopen cmux. macOS does not ask for this access.'

new FullDiskAccess().remedy(Client.executable(node));
// 'Turn on /Users/me/.nvm/versions/node/v26.13.1/bin/node in System Settings › Privacy & Security › Full Disk Access, then start it again. macOS does not ask for this access.'
```

The pane names are the ones of System Settings on macOS 27: Accessibility is "Device Control and Data Access" there (`SecurityPrivacyExtension.appex`, `Localizable.loctable`, key `ACCESSIBILITY`). A grant of Full Disk Access applies to the processes that start after it, so its remedy tells the user to start the client again. A host that has its own command for that, such as a restart of a launchd job, writes its command after the remedy.

## Open the pane

```ts
await new FullDiskAccess().openSettings();
// /usr/bin/open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
```

Each service opens its own pane, with the anchor that `TCCServiceList.plist` of System Settings gives it, such as `Privacy_Camera` or `Privacy_ListenEvent`. Open a pane only when the user asked for the step: System Settings comes to the front.

## Errors

| Error             | When                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| The signal reason | `request()` was waiting for the user's answer, and the caller's signal was aborted |

A preflight gives a denied path and a missing path as data, because the caller does the same next step for each path of a kind. Any other failure of a read, such as `EIO`, is thrown as Node gives it. A failure to load `node:ffi`, for example in a process that runs with `--permission` and without `--allow-ffi`, is thrown as Node gives it.

## What macOS does not do

- **It gives no API that tells whether a process has Full Disk Access.** Kevin Elliott of Apple DTS, August 2026: "there isn't currently a 'general' solution to this issue". On macOS 27 the per-user `TCC.db` is in a protected container, so a read of it fails also when the grant is there ([Apple Developer Forums thread 841091](https://developer.apple.com/forums/thread/841091)).
- **It shows no prompt for Full Disk Access.** The user turns the client on in System Settings.
- **It shows the prompt of a request only to a program with Apple's private entitlement.** The request of any other executable completes with no prompt and no grant ([ADR 0007](./docs/adr/0007-a-request-runs-in-osascript-which-may-show-the-prompt.md)).
- **It asks the user once.** After a denial, a request shows nothing. Only the user changes the grant, in System Settings.

## What the package does not do

- **It does not grant access.** Only the user grants it. The package never writes `TCC.db` and never runs `tccutil reset`.
- **It does not guess Full Disk Access.** It has no call that reads a path of its own choice to say yes or no ([ADR 0003](./docs/adr/0003-full-disk-access-has-no-status-so-the-caller-preflights-its-own-paths.md)).
- **It keeps no state.** It exports classes, never an instance, and it has no slot in which a host installs a name ([ADR 0006](./docs/adr/0006-the-package-keeps-no-state.md)).
- **It does not cover Location.** `locationd`, not TCC, keeps the location grant ([ADR 0002](./docs/adr/0002-each-service-is-a-class-and-its-status-has-apples-values.md)).

## Scope

| Now (this release)                                                                                                                                 | Later                                                                                             | Never                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The 14 services of the status table, each with `remedy()` and `openSettings()`; the 13 other than Full Disk Access with `status()` and `request()` | Media & Apple Music: its only API that is not deprecated, MusicKit, is Swift only                 | A call that guesses Full Disk Access from a path the package chooses |
| `preflight(paths)` of Full Disk Access                                                                                                             | Motion, HomeKit and the other services of `TCCServiceList.plist`, when a leading tool covers them | A write to `TCC.db`, or `tccutil reset`                              |
| `Client.responsibleFor(pid)`, `Client.bundle(path)`, `Client.executable(path)`                                                                     | A watch that tells when a grant changes                                                           | Location, which `locationd` keeps                                    |
|                                                                                                                                                    | A spawn that makes a child process its own client (responsibility disclaim)                       | Support for a macOS older than the newest                            |

## Who uses it

| Consumer                                | How                                                                                                                                                                                                                                                                                                            | Record |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| elt `@eltjs/sdk-macos-app-database`     | Each `Store` names a service class; `StoreUnavailableError` writes `store.service.remedy(Client.responsibleFor(process.pid))`. Replaces `macOSAccess`, an instance with an `install({ program })` slot, its `Grant` type and its pane names (`src/macos-access.ts`, `src/store.ts:5-18`, `src/unavailable.ts`) | #5747  |
| elt `@eltjs/sdk-apple-eventkit`         | `Calendars` and `Reminders` give the remedy of its errors (`src/errors.ts:8,19`), and their `request()` replaces the request through `osascript` of its Swift helper (`src/helper/Access.swift:44-68`)                                                                                                         | #5747  |
| context-compiler `apps/cli`             | Nothing at its entry point: `responsibleProgram()` and its `macOSAccess.install()` go (`src/main.ts:39-59`). `sync watch start` writes `new FullDiskAccess().remedy(Client.executable(node))` (`src/commands/sync-watch-start.ts:18`)                                                                          | #5747  |
| context-compiler `@workspace/connector` | Each connector names the services of its stores in place of `guidance()`, `access()` and `fullDiskAccess` (27 classes, `packages/connectors/connector/src/connector.ts`)                                                                                                                                       | #5747  |

## The same concepts in other systems

| Concept                        | Other systems                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A class for each kind of grant | .NET MAUI `Permissions.ContactsRead`, `Permissions.CalendarRead` (dotnet/maui `src/Essentials/src/Permissions/Permissions.shared.cs:181-364`); react-native-permissions `PERMISSIONS.IOS.CONTACTS`                                                                                          |
| Status                         | MAUI `CheckStatusAsync<T>()` with `PermissionStatus`; node-mac-permissions `getAuthStatus(type)`; Flutter permission_handler `Permission.contacts.status`; react-native-permissions `check()`; Electron `systemPreferences.getMediaAccessStatus()`                                          |
| Request                        | MAUI `RequestAsync<T>()`; node-mac-permissions `askForContactsAccess()` and the other `askFor*` calls; Flutter `request()`; react-native-permissions `request()`; Electron `askForMediaAccess()`                                                                                            |
| Open the settings              | node-mac-permissions `OpenPrefPane("Privacy_AllFiles")` (`permissions.mm:140`); tauri-plugin-macos-permissions (`full_disk_access.rs:60`); Flutter `openAppSettings()`; react-native-permissions `openSettings()`; MAUI `AppInfo.ShowSettingsUI()`, which opens System Settings and no pane |
| Full Disk Access               | node-mac-permissions opens four files, `TCC.db` among them (`permissions.mm:296-320`); tauri-plugin-macos-permissions reads `Library/Safari` (`full_disk_access.rs:26`); Apple DTS: spot-check the locations your work needs (thread 841091)                                                |
| Client                         | `responsibility_get_pid_responsible_for_pid` in libSystem (private); the crate `disclaim` and npm `node-macos-disclaim` spawn a child as its own client; the columns `client` and `client_type` of `TCC.db`                                                                                 |
| Go and Rust                    | No maintained package checks TCC (pkg.go.dev and crates.io, 2026-11-26): Go `tmc/macgo/permissions` maps names to entitlements; Rust `axwatch` watches the Accessibility grant                                                                                                              |

## Why no npm package was used

Searched on 2026-11-26: the `@stdlib` scope ("permission", "privacy", "macos"), and npm for "macos permissions", "mac permissions", "tcc", "macos tcc", "full disk access", "macos privacy", "privacy settings macos" and "system preferences macos". The checks: Full Disk Access with no prompt (1), the status of each service (2), the client of the process (3), the pane of each service (4), Node 26 on macOS 27 (5), ES module with types (6), and no native toolchain (7).

| Package                                   | Last release | Weekly downloads | Why not                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node-mac-permissions 2.5.0                | 2025-03-15   | 8,667            | Fails 3 and 7: no client, and an Objective-C++ addon that node-gyp and Xcode build. Fails 6: its named ES module imports do not load. Its Full Disk Access check opens the per-user `TCC.db`, which macOS 27 moved. Its location anchor `Privacy_Location` is stale. |
| @nut-tree-fork/node-mac-permissions 2.2.1 | 2025-03-15   | 4,846            | A republish of an older node-mac-permissions with a prebuilt binary: fails 3 and 7.                                                                                                                                                                                  |
| @computer-use/node-mac-permissions 2.2.2  | 2025-01-08   | 6,441            | The same JavaScript as the fork above: fails 3 and 7.                                                                                                                                                                                                                |
| node-macos-disclaim 0.0.1                 | 2026-11-06   | 944              | Only the client (3), as a prebuilt binary: fails 1, 2, 4 and 7.                                                                                                                                                                                                      |
| @mgcrea/mcp-apple-core 1.43.0             | 2026-11-20   | 467              | An MCP server kit that maps an Automation denial after the fact: fails 1 to 4.                                                                                                                                                                                       |
| @stakeswky/openclaw-permctl 0.2.0         | 2026-02-18   | 7                | An agent plugin that matches error text: fails 1 to 3, and ships its TypeScript source as its entry.                                                                                                                                                                 |
| mac-screen-capture-permissions 2.1.0      | 2023-09-11   | 1,449            | Screen Recording only, with Electron prebuilds: fails 1 to 3 and 7.                                                                                                                                                                                                  |
| tauri-plugin-macos-permissions-api 2.3.0  | 2025-05-06   | 50,897           | Runs only in a Tauri app (5), and its plugin is Rust (7).                                                                                                                                                                                                            |

Node has no API for TCC: `process.permission` is the permission model of Node, not of macOS. Node 26 has `node:ffi`, which reaches the frameworks of macOS with no toolchain. The maintainer chose it over a native addon on 2026-11-26.

## API

```ts
export abstract class Service {
  readonly name: string; // the TCC service, e.g. 'kTCCServiceCamera'
  readonly pane: string; // the pane as System Settings names it, e.g. 'Camera'
  readonly url: URL; // x-apple.systempreferences:com.apple.preference.security?Privacy_Camera
  remedy(client: Client): string;
  openSettings(): Promise<void>;
}

// A service whose status a framework of macOS gives, and whose prompt a request shows.
export abstract class PromptedService<Status extends string> extends Service {
  status(): Status;
  request(options: { readonly signal: AbortSignal }): Promise<Status>;
}

export class Contacts extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'authorized'
> {}
export class Calendars extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'fullAccess' | 'writeOnly'
> {}
export class Reminders extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'fullAccess' | 'writeOnly'
> {}
export class Camera extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'authorized'
> {}
export class Microphone extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'authorized'
> {}
export class Photos extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'authorized' | 'limited'
> {}
export class PhotosAdd extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'authorized' | 'limited'
> {}
export class SpeechRecognition extends PromptedService<
  'notDetermined' | 'denied' | 'restricted' | 'authorized'
> {}
export class Bluetooth extends PromptedService<
  'notDetermined' | 'restricted' | 'denied' | 'allowedAlways'
> {}
export class InputMonitoring extends PromptedService<
  'granted' | 'denied' | 'unknown'
> {}
export class Accessibility extends PromptedService<'trusted' | 'notTrusted'> {}
export class ScreenRecording extends PromptedService<
  'granted' | 'notGranted'
> {}
export class Automation extends PromptedService<
  'permitted' | 'notPermitted' | 'wouldRequireUserConsent' | 'notRunning'
> {
  constructor(target: string); // the bundle identifier of the target app
}

export class FullDiskAccess extends Service {
  preflight(paths: readonly string[]): Promise<Preflight>;
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

| Call                                    | What it does                                                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status()` of a framework service       | Loads `node:ffi`, opens the framework, and sends the class method of the status table through `objc_msgSend`, or calls its C function. It maps Apple's raw value to its name.                                                                                       |
| `new Automation(target).status()`       | Builds an `AEDesc` of type `typeApplicationBundleID` with `AECreateDesc()`, and calls `AEDeterminePermissionToAutomateTarget(desc, 'aevt', 'odoc', false)`: `noErr` is permitted, `-1743` not permitted, `-1744` would require user consent, `-600` not running.    |
| `request({ signal })`                   | Runs `/usr/bin/osascript -l JavaScript` with a script that sends the framework's request and turns its run loop in 50 ms slices until the status is decided, or that calls the C function of the request; then reads the status again. The signal ends `osascript`. |
| `new FullDiskAccess().preflight(paths)` | Opens each path read-only with `node:fs` and closes it at once: EPERM and EACCES are denied, ENOENT and ENOTDIR are missing, any other code is thrown.                                                                                                              |
| `Client.responsibleFor(pid)`            | Calls `responsibility_get_pid_responsible_for_pid(pid)` and `proc_pidpath()` in libSystem through `node:ffi`. A path inside a `.app` folder gives a bundle; any other path gives an executable.                                                                     |
| `remedy(client)`                        | Writes the sentence of the service with `client.name` and `service.pane`.                                                                                                                                                                                           |
| `openSettings()`                        | Runs `/usr/bin/open` with `service.url`.                                                                                                                                                                                                                            |

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-the-package-is-named-after-tcc-and-uses-its-words.md): the package is named after TCC and uses its words.
- [ADR 0002](./docs/adr/0002-each-service-is-a-class-and-its-status-has-apples-values.md): each service is a class, and its status has Apple's values.
- [ADR 0003](./docs/adr/0003-full-disk-access-has-no-status-so-the-caller-preflights-its-own-paths.md): Full Disk Access has no status, so the caller preflights its own paths.
- [ADR 0004](./docs/adr/0004-the-client-comes-from-macos-through-node-ffi.md): the client comes from macOS, through node:ffi.
- [ADR 0005](./docs/adr/0005-the-remedy-names-the-client-and-the-pane-and-opening-the-pane-is-the-request.md): the remedy names the client and the pane, and opening the pane is the request.
- [ADR 0006](./docs/adr/0006-the-package-keeps-no-state.md): the package keeps no state.
- [ADR 0007](./docs/adr/0007-a-request-runs-in-osascript-which-may-show-the-prompt.md): a request runs in osascript, which may show the prompt.

On each Mac: `man tccutil`, the SDK headers of the frameworks in the status table, and `/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/Resources/TCCServiceList.plist`.

## Development

The project has the tag `platform:darwin`, so its targets run in the macOS job of CI ([root ADR 0005](../../../docs/adr/0005-a-project-that-needs-macos-runs-its-targets-on-a-macos-runner.md)). The tests call the real frameworks through `node:ffi`, on Node 26. A test of `request()` needs a person at the Mac to answer the prompt, so CI runs `test`: the status, preflight, client, remedy and pane tests. The tests that need a person at the Mac to answer a prompt, or that bring System Settings to the front, are `src/**/*.prompt.spec.ts`, which `npx nx run tcc:test-prompt` runs, as `test-network` runs the network tests of `mteb`.
