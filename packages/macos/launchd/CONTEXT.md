# launchd

A client for launchd, the service manager of macOS. It installs jobs, and it drives their services with the current subcommands of launchctl(1). The words are Apple's, from launchd.plist(5), launchctl(1) and xpc_events(3). It owns no policy: what a job runs, and when, stay in the program that installs it. Cancel and signal have the meanings that [the async glossary](../../async/CONTEXT.md) gives them.

## Language

**Job**:
The definition of a daemon or an agent, as launchd.plist(5) gives it: a `Label`, the program to run, and the keys that say when launchd runs it. In code, a job is an `AgentJob` or a `DaemonJob` object. On disk, it is a job file.
_Avoid_: Service (the loaded job in a domain), task, script, plist (the file format), unit (systemd's word)

**Job file**:
The file that holds one job: `<Label>.plist` in the folder of its domain. launchd.plist(5) calls it a launchd property list file, and asks that its name is `<Label>.plist` (launchd.plist(5), lines 59-62). The package writes it with mode `0644`.
_Avoid_: Plist (the format of the file), unit file, configuration

**Label**:
The name that identifies a job to launchd: "This required key uniquely identifies the job to launchd" (launchd.plist(5), lines 64-65). The job file and the service take their names from it.
_Avoid_: Name, ID, service name

**Service**:
A job that launchd has loaded into a domain. launchctl names it with a service-target, `<domain>/<label>`, such as `gui/501/com.example.sync` (launchctl(1), lines 67-70). A `Service` object is a handle for one label in one domain: it holds no state, and it exists also when launchd has no such service.
_Avoid_: Job (the definition), process (a service has a process only while it runs), daemon and agent (two kinds of job)

**Domain**:
A context in which launchd runs a collection of services, with its own execution policy (launchctl(1), lines 15-16). launchctl names it with a domain-target. The package uses three:

- `gui/<uid>`: the domain of a user who logged in at the GUI (launchctl(1), lines 39-51).
- `user/<uid>`: the domain of a user. It "may exist independently of a logged-in user" (launchctl(1), lines 34-37).
- `system`: the privileged domain of the computer. "Anyone may read or query the system domain, but root privileges are required to make modifications" (launchctl(1), lines 27-32).

_Avoid_: Session (a session type limits where an agent loads, `LimitLoadToSessionType`), context, scope

**Agent**:
A job that runs for one user, in the `gui/<uid>` or the `user/<uid>` domain of that user. Its job file is in `~/Library/LaunchAgents`.
_Avoid_: User service, login item (an entry in System Settings)

**Daemon**:
A job that runs for the whole computer, in the `system` domain. Its job file is in `/Library/LaunchDaemons`. A change of a daemon needs root.
_Avoid_: System service, server

**Folder**:
The folder of the job files of a domain: `~/Library/LaunchAgents` for agents, and `/Library/LaunchDaemons` for daemons (launchd.plist(5), lines 735-742).
_Avoid_: Directory, search path (the `-D` option of the legacy `load`, launchctl(1), lines 403-419)

**Installed**:
The job file of a label is in the folder of the domain. An installed job is not always loaded.
_Avoid_: Registered, deployed

**Loaded**:
launchd has the service in the domain. `bootstrap` loads a job file into a domain, and `bootout` removes the service: launchd stops its process and forgets the service (launchctl(1), lines 73-88). A loaded service is not always running.
_Avoid_: Started (a loaded service runs on demand or by its launch conditions), active, registered

**Running**:
A loaded service whose process exists. `launchctl print` then shows its PID.
_Avoid_: Alive, up, started

**Enabled, disabled**:
The override of a label in a domain. launchd keeps it itself, apart from the job file: "Now the state of the Disabled key is stored elsewhere on-disk in a location that may not be directly manipulated by any process other than launchd" (launchctl(1), lines 379-385). A disabled service "cannot be loaded in the specified domain until it is once again enabled. This state persists across boots of the device" (launchctl(1), lines 90-95).
_Avoid_: On and off, the `Disabled` key (the key in the job file that the override replaces), active and inactive

**Kickstart**:
An instruction to launchd to "run the specified service immediately, regardless of its configured launch conditions" (launchctl(1), lines 97-99). With `-k`, launchd first kills the process that runs: a restart that does not read the job file again.
_Avoid_: Start (the legacy subcommand, launchctl(1), lines 449-452), reload (a reload reads the job file again: bootout, then bootstrap)

**Last exit status**:
How the process of a service ended the last time (launchctl(1), lines 218-220). `launchctl print` shows it in the line `last exit code`.
_Avoid_: Exit code (the code of launchctl itself), return code

**Exit code**:
The code with which launchctl ends. 0 is success. Another code is the error, and `launchctl error <code>` decodes it (launchctl(1), lines 585-588). For example, 113 is "Could not find specified service".
_Avoid_: Status, last exit status (of a service)

**Process signal**:
A Unix signal, such as `SIGTERM`, that `launchctl kill` sends to the process of a running service (launchctl(1), lines 198-201).
_Avoid_: Signal (an `AbortSignal`, as the async glossary says)

**Program, ProgramArguments**:
The keys that say what launchd runs. `Program` is the absolute path of the executable. `ProgramArguments` is the argument vector, as execvp(3) takes it (launchd.plist(5), lines 124-146). launchd runs the program with no shell.
_Avoid_: Command, script, entry point

**Launch event**:
An event of an event stream that launches a job on demand, given in the `LaunchEvents` key. xpc_events(3) supports two streams: `com.apple.iokit.matching` and `com.apple.notifyd.matching` (xpc_events(3), lines 29-34).
_Avoid_: Trigger, hook, notification (one kind of launch event)

**Reconcile**:
What `install` does: it makes the job file and the loaded service match the job it gets, and it changes only what differs. This is the word of Kubernetes controllers for the same work.
_Avoid_: Sync, upsert, deploy
