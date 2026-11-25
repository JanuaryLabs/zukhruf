# A request runs in osascript, which may show the prompt

Status: Accepted 2026-11-26 (backlog #5747).

Decision-makers: the context-compiler session context-compiler-99, from the evidence below. The maintainer's rule against polls ("find a way where we don't need timers, polls") lost to the probes: JXA gives no way to end the wait from the handler.

macOS shows the prompt of a request only to a program that holds the private entitlement `com.apple.private.tcc.allow-prompting`. `/usr/bin/osascript` holds it (`codesign -d --entitlements - /usr/bin/osascript`, `kTCCServiceAll`). elt's EventKit helper found this on macOS 27 (2026-09-30): its own `requestFullAccessToReminders` completed at once with "not granted", no error and no prompt, also with a bound signing identity, while the same request through `osascript` under the same terminal showed the prompt, and the grant went to the terminal app, which the helper inherits (`packages/sdks/apple/eventkit/src/helper/Access.swift:44-68`).

`node:ffi` also cannot make most requests: each framework request takes an Objective-C block, and `node:ffi` makes plain C callbacks only, which must run on the thread that made them. JXA, the JavaScript of `osascript`, passes a JavaScript function as a block (`ObjC.import`, `$.NSClassFromString`), and calls C functions with `ObjC.bindFunction`.

## Decision

`request({ signal })` runs `/usr/bin/osascript -l JavaScript` with a script of the service, and then reads the status again. A request of a framework sends the framework's request with an empty completion handler and turns the run loop of the script in 50 ms slices until the status is decided, as elt's `Access.swift` does. The completion handler is not waited for: JXA runs it on another thread, where a `CFRunLoopStop` does not end a `CFRunLoopRun` that JavaScript started, and it does not run at all for the requests of Photos and EventKit (probes of 2026-11-26, below). A request of a C function (Accessibility, Screen Recording, Input Monitoring) returns when macOS has shown its dialog, and Automation's `AEDeterminePermissionToAutomateTarget` with `askUserIfNeeded` returns when the user answered. The caller's signal ends `osascript`, and the promise rejects with the signal's reason. There is no time limit of the package's own: the signal bounds the wait.

The requests of the services are: `-[CNContactStore requestAccessForEntityType:completionHandler:]`, `-[EKEventStore requestFullAccessToEventsWithCompletion:]` and `…RemindersWithCompletion:` (the status is undecided while it is `notDetermined` or `writeOnly`), `+[AVCaptureDevice requestAccessForMediaType:completionHandler:]`, `+[PHPhotoLibrary requestAuthorizationForAccessLevel:handler:]`, `+[SFSpeechRecognizer requestAuthorization:]`, a `CBCentralManager` made with `init` (whose creation asks for Bluetooth; `initWithDelegate:queue:` with a `null` queue from JXA crashes `osascript` with "BUG IN CLIENT OF LIBDISPATCH: Cannot target object to cooperative root queue"), `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt`, `CGRequestScreenCaptureAccess()`, `IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)` and `AEDeterminePermissionToAutomateTarget` with `askUserIfNeeded`.

## Considered Options

- **The request in the Node process, through `node:ffi`.** macOS shows no prompt to it, and `node:ffi` cannot make a block.
- **A native helper of the package**, as elt's EventKit helper. Its own request shows no prompt either, so it runs `osascript` too, and it needs a toolchain.
- **`osascript` with a completion handler that stops its run loop.** No poll, but it does not work in JXA: the script never ended (probes 1 and 3 below).
- **`osascript` that turns its run loop until the completion handler has run.** It worked for Camera, but Photos and EventKit never ran their handler, and their requests timed out.
- **`osascript` that turns its run loop until the status is decided, with no time limit of its own.** This option was selected. It is the poll of `Access.swift`, without its fixed 30 seconds: the caller's signal bounds the wait.

## Consequences

- The prompt names the client of the calling process, because `osascript` runs as its child. A host whose client is an app shows the app's name in the prompt.
- A request needs a person at the Mac to answer. The tests of CI cover the status, and the request is proved on a Mac with its user present.

## Confirmation

- elt `Access.swift:44-68` and the context-compiler memory of 2026-09-30 (`eventkit-helper-tcc-signing`): after `tccutil reset Reminders com.cmuxterm.app`, the request through `osascript` showed the prompt and the helper then read 70 reminders.
- Probes of 2026-11-26 on macOS 27.2, under the terminal app cmux, with Camera already granted: (1) a handler that calls `CFRunLoopStop` with the run loop that the script captured left `CFRunLoopRun` running until `timeout` killed it at 20 s; (2) a run loop turned in 50 ms slices saw the handler run on a thread that is not the main thread (`NSThread.isMainThread` false) after the call returned, 110 ms later; (3) a handler that stops and wakes `CFRunLoopGetMain()` hung three times out of three.
- `request()` of the package on the same Mac, for each service whose status is decided: Camera, Microphone, Photos, PhotosAdd, Calendars, Reminders, Contacts, Accessibility, ScreenRecording, InputMonitoring and Automation of Finder each resolved with their status in 66 to 214 ms and showed no prompt. With a wait for the handler, Photos, PhotosAdd, Calendars and Reminders timed out at 15 s.
- `src/request.test.ts`: a request with an aborted signal rejects with the signal's reason before osascript runs.
- To prove with the user at the Mac (`npx nx run tcc:test-prompt`): a service whose status is `notDetermined` shows the prompt, and the answer resolves the request with the decided status.
- The run of `test-prompt` on 2026-11-26 with the user at the Mac: Speech Recognition showed its prompt and the answer decided the status after 27 s; Bluetooth's first script crashed `osascript` with SIGTRAP (the queue argument above), and with `init` the prompt showed and the answer gave `allowedAlways` after 10 s; the eleven decided services kept their status and showed nothing; `openSettings()` started System Settings.
