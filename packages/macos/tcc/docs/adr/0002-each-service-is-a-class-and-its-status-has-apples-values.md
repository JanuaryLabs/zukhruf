# Each service is a class, and its status has Apple's values

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the maintainer, on the scope ("think of an outsider, they don't have acces to our eventkit elts stuff … we are diesnging std package and it happens that our repos is a customer of it", 2026-11-26); the context-compiler session context-compiler-99 on the services and their values, from the sources below.

A program that installs the package from npm needs, for each service, what the leading tools give: a status, a request and a way to the settings. node-mac-permissions covers accessibility, bluetooth, calendar, camera, contacts, full disk access, input monitoring, location, microphone, music library, photos (add only and read-write), reminders, screen recording, speech recognition and Apple events. tauri-plugin-macos-permissions covers accessibility, full disk access, screen recording, microphone, camera and input monitoring.

The services differ in what macOS can tell. Each framework has its own status enum (MacOSX27.2.sdk):

- `CNAuthorizationStatus` (`Contacts/CNContactStore.h:35-47`): `NotDetermined` 0, `Restricted` 1, `Denied` 2, `Authorized` 3. `Limited` 4 is iOS only.
- `EKAuthorizationStatus` (`EventKit/EKTypes.h:27-34`): `NotDetermined`, `Restricted`, `Denied`, `FullAccess`, `WriteOnly`.
- `AVAuthorizationStatus` (`AVFoundation/AVCaptureDevice.h:2159-2163`): `NotDetermined`, `Restricted`, `Denied`, `Authorized`, for camera and microphone.
- `PHAuthorizationStatus` (`Photos/PHPhotoLibrary.h:21-28`): `NotDetermined`, `Restricted`, `Denied`, `Authorized`, `Limited`, for each access level (`PHAccessLevelAddOnly` 1, `PHAccessLevelReadWrite` 2).
- `SFSpeechRecognizerAuthorizationStatus` (`Speech/SFSpeechRecognizer.h:25-39`): `NotDetermined` 0, `Denied` 1, `Restricted` 2, `Authorized` 3. The order of 1 and 2 is not the order of the others.
- `CBManagerAuthorization` (`CoreBluetooth/CBManager.h:62-67`): `NotDetermined`, `Restricted`, `Denied`, `AllowedAlways`.
- `IOHIDAccessType` (`IOKit/hidsystem/IOHIDLib.h:171-178`): `Granted` 0, `Denied` 1, `Unknown` 2.
- `AXIsProcessTrusted()` (`HIServices/AXUIElement.h:74`) and `CGPreflightScreenCaptureAccess()` (`CoreGraphics/CGWindow.h:300`) return a boolean.
- `AEDeterminePermissionToAutomateTarget()` (`AE/AppleEvents.h:363`) returns `noErr`, `errAEEventNotPermitted` (-1743) or `errAEEventWouldRequireUserConsent` (-1744) for one target app, and `procNotFound` (-600) while the target does not run (`:346`).
- Full Disk Access has no status ([ADR 0003](./0003-full-disk-access-has-no-status-so-the-caller-preflights-its-own-paths.md)).

.NET MAUI models each permission as a class over a `BasePermission` (dotnet/maui `src/Essentials/src/Permissions/Permissions.shared.cs:129-364`), but it maps every platform to one `PermissionStatus`. That map loses values: on Mac Catalyst, `WriteOnly` of EventKit becomes `Unknown` (`Permissions.ios.watchos.cs:15-38`).

Two services of the leaders are not like the others. Location is kept by `locationd`, not by TCC: it has no `kTCCService` name, and `TCCServiceList.plist` gives it a class of its own (`PrivacyLocationService`). Media & Apple Music (`kTCCServiceMediaLibrary`) has one status API in Objective-C, `+[SKCloudServiceController authorizationStatus]`, which macOS 15 deprecated for the Swift-only `MusicAuthorization.currentStatus`; `node:ffi` cannot call Swift.

## Decision

Each service is a class. An abstract `Service` holds the TCC name, the pane, the URL, `remedy()` and `openSettings()`. An abstract `PromptedService<Status>` adds `status()` and `request()`, typed with the values of the service's framework, in camel case. The classes are `Contacts`, `Calendars`, `Reminders`, `Camera`, `Microphone`, `Photos`, `PhotosAdd`, `SpeechRecognition`, `Bluetooth`, `InputMonitoring`, `Accessibility`, `ScreenRecording`, `Automation` (with the bundle identifier of its target) and `FullDiskAccess`, which has `preflight()` in place of `status()` and no `request()`.

A boolean API gets two names of the package's own: `trusted` and `notTrusted` for Accessibility, after the "trusted" of `AXIsProcessTrusted`; `granted` and `notGranted` for Screen Recording. `Automation` maps `noErr` to `permitted` (the package's word), the two errors to `notPermitted` and `wouldRequireUserConsent`, and `procNotFound` to `notRunning`.

Location is not a service of this package. Media & Apple Music waits until it can be reached without Swift.

## Considered Options

- **Only the services that our own repositories read** (Full Disk Access, Contacts, Calendars, Reminders). The maintainer refused it: the package is for any program, and our repositories are its customers.
- **One status type for every service**, as MAUI. It cannot hold `writeOnly` or `limited`, and it gives Full Disk Access a status that macOS does not have.
- **A table of services indexed by name.** The repositories model a set of things that share an algorithm as classes, not as a table.
- **A class for each service of the leaders that TCC keeps, with the values of its framework.** This option was selected. A call of `status()` on Full Disk Access does not compile, and each value is one that macOS can give.

## Consequences

- A new service is a new class, with the values of its framework.
- Speech Recognition keeps Apple's order: `denied` is 1 and `restricted` is 2.

## Confirmation

- A probe of each status through `node:ffi` on macOS 27.2 (2026-11-26), under the terminal app cmux: Camera, Microphone, Photos, Contacts, Calendars and Reminders gave 3; Speech Recognition and Bluetooth gave 0; `IOHIDCheckAccess` gave 0 (granted); `AXIsProcessTrusted` and `CGPreflightScreenCaptureAccess` gave true; `AEDeterminePermissionToAutomateTarget` with no prompt gave 0 for Finder and -600 for System Events, which did not run. The same reads through JXA gave the same values.
- The tests read each status through the package and compare it with the same read through `osascript`.
