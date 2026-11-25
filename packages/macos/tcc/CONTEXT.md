# tcc

The privacy grants of macOS, in the words of TCC (Transparency, Consent, and Control): which services there are, the status of a service for this process, the client that macOS charges an access to, and what the user turns on. The words are Apple's, from tccutil(1), the schema of `TCC.db`, the SDK headers of the frameworks that give a status, and the System Settings app (`SecurityPrivacyExtension.appex`). The package owns no policy: when to check, when to open a pane and what to do after a denial stay in the program that uses it.

## Language

**Service**:
A kind of grant that TCC keeps, as tccutil(1) names it: "reset service [bundle_id]". `TCC.db` stores it in the column `service` of the table `access`, as `kTCCServiceSystemPolicyAllFiles` for Full Disk Access, `kTCCServiceAddressBook` for Contacts, `kTCCServiceCalendar` for Calendars and `kTCCServiceReminders` for Reminders. In code, each service is a class, such as `FullDiskAccess`, `Contacts` or `Camera`.
_Avoid_: Permission (the word of other platforms, and of the permission model of Node), grant (what the user gives to a client for a service), privilege, entitlement (a signed claim in a binary)

**Client**:
The program that TCC charges an access to. `TCC.db` stores it in the columns `client` and `client_type`: a bundle identifier (type 0) or the path of an executable (type 1). In code, a `Client` is a bundle (an `.app` folder) or an executable, with the name that the user finds in System Settings.
_Avoid_: Program (too wide), app (an executable is a client too), grantee, responsible program

**Responsible process**:
The process that macOS charges the access of a process to: the app that started it, or the process itself when launchd started it. libSystem gives it with the private function `responsibility_get_pid_responsible_for_pid`. Its executable gives the client.
_Avoid_: Parent process (the parent can be a shell that the app started), owner

**Grant**:
The decision of the user that a client may use a service. `TCC.db` stores it as `auth_value`. The user gives it in System Settings, or in the prompt that macOS shows for some services.
_Avoid_: Permission, consent, authorization (Apple's word for the status in code)

**Status**:
What macOS says about the grant of a service for the calling process, in the values of the service's own framework, such as `CNAuthorizationStatus` for Contacts and `EKAuthorizationStatus` for Calendars and Reminders. A service whose API gives only a boolean has two values: `trusted` and `notTrusted` for Accessibility (`AXIsProcessTrusted`), `granted` and `notGranted` for Screen Recording (`CGPreflightScreenCaptureAccess`); these four words are the package's own. Full Disk Access has no status.
_Avoid_: State, result, authorization (Apple's word for the type in code, kept only in the citations)

**Request**:
A call that asks macOS to show the prompt of a service to the user, and that ends when the user answers. macOS shows the prompt only to a program with the private entitlement `com.apple.private.tcc.allow-prompting`, such as `/usr/bin/osascript`, and only while the status is not decided.
_Avoid_: Ask (the word of node-mac-permissions' `askFor*`), prompt (what macOS shows), permission request

**Preflight**:
A read of the paths that the real work will read, done before the work, in the process that does it. Apple's advice when no status exists: "create a list of data locations you know to be critical … and spot-check those locations".
_Avoid_: Check, probe (the word for a read of a path that the work does not need), test

**Pane**:
The page of a service in System Settings › Privacy & Security, such as "Full Disk Access". Its URL is `x-apple.systempreferences:com.apple.preference.security?<anchor>`, with an anchor such as `Privacy_AllFiles`.
_Avoid_: Panel, preference pane (the old name of System Preferences), settings page

**Remedy**:
The sentence that tells the user what to turn on, and where: "Turn on <client> in System Settings › Privacy & Security › <pane>." For Full Disk Access it also tells the user to start the client again.
_Avoid_: Guidance, hint, instructions, fix
