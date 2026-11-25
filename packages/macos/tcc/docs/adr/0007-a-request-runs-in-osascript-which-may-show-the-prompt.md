# A request runs in osascript, which may show the prompt

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the context-compiler session context-compiler-99, from the evidence below.

macOS shows the prompt of a request only to a program that holds the private entitlement `com.apple.private.tcc.allow-prompting`. `/usr/bin/osascript` holds it (`codesign -d --entitlements - /usr/bin/osascript`, `kTCCServiceAll`). elt's EventKit helper found this on macOS 27 (2026-09-30): its own `requestFullAccessToReminders` completed at once with "not granted", no error and no prompt, also with a bound signing identity, while the same request through `osascript` under the same terminal showed the prompt, and the grant went to the terminal app, which the helper inherits (`packages/sdks/apple/eventkit/src/helper/Access.swift:44-68`).

`node:ffi` also cannot make most requests: each framework request takes an Objective-C block, and `node:ffi` makes plain C callbacks only, which must run on the thread that made them. JXA, the JavaScript of `osascript`, passes a JavaScript function as a block (`ObjC.import`, `$.NSClassFromString`), and calls C functions with `ObjC.bindFunction`.

## Decision

`request({ signal })` runs `/usr/bin/osascript -l JavaScript` with a script of the service. The script sends the request, with a completion handler that stops the run loop of the script (`CFRunLoopStop` of the main run loop), and runs that run loop until then (`CFRunLoopRun`). Then it reads the status again and prints it. The package resolves with that status. The caller's signal ends `osascript`, and the promise rejects with the signal's reason. The wait has no timer and no poll.

The requests of the services are: `-[CNContactStore requestAccessForEntityType:completionHandler:]`, `-[EKEventStore requestFullAccessToEventsWithCompletion:]` and `…RemindersWithCompletion:`, `+[AVCaptureDevice requestAccessForMediaType:completionHandler:]`, `+[PHPhotoLibrary requestAuthorizationForAccessLevel:handler:]`, `+[SFSpeechRecognizer requestAuthorization:]`, a `CBCentralManager` (whose creation asks for Bluetooth), `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt`, `CGRequestScreenCaptureAccess()`, `IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)` and `AEDeterminePermissionToAutomateTarget` with `askUserIfNeeded`.

## Considered Options

- **The request in the Node process, through `node:ffi`.** macOS shows no prompt to it, and `node:ffi` cannot make a block.
- **A native helper of the package**, as elt's EventKit helper. Its own request shows no prompt either, so it runs `osascript` too, and it needs a toolchain.
- **A script that polls the status**, as `Access.swift` does every 50 ms for 30 seconds. A poll and a fixed time limit, where the completion handler can end the wait and the caller's signal can bound it.
- **`osascript` with a completion handler that stops its run loop.** This option was selected.

## Consequences

- The prompt names the client of the calling process, because `osascript` runs as its child. A host whose client is an app shows the app's name in the prompt.
- A request needs a person at the Mac to answer. The tests of CI cover the status, and the request is proved on a Mac with its user present.

## Confirmation

- elt `Access.swift:44-68` and the context-compiler memory of 2026-09-30 (`eventkit-helper-tcc-signing`): after `tccutil reset Reminders com.cmuxterm.app`, the request through `osascript` showed the prompt and the helper then read 70 reminders.
- To prove on a Mac with its user present, for each service whose status is `notDetermined`: `request()` shows the prompt, Allow gives the granted value, and an aborted signal ends `osascript`.
