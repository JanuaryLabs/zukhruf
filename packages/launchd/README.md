# @zukhruf/launchd

> Status: design for review. The package has no code yet; this README is its API on paper.

launchd starts and stops the daemons and agents of macOS. A program that must run with no terminal, at login, on a schedule, or again after a crash, gives launchd a job: a property list file in the format of launchd.plist(5). `launchctl` loads the job into a domain, and launchd runs it as a service. Each program that does this must answer the same questions. Which domain is right? Which subcommands of `launchctl` are right, now that Apple calls `load` and `unload` legacy? How does a changed job replace the service that runs? When has launchd let go of the old service? What does each exit code of `launchctl` mean? This package answers them once.

It runs `/bin/launchctl` with the current subcommands of launchctl(1): `bootstrap`, `bootout`, `enable`, `disable`, `kickstart`, `kill` and `print` ([ADR 0001](./docs/adr/0001-launchctl-is-the-interface-and-only-its-current-subcommands.md)). A job is a TypeScript type with the keys of launchd.plist(5), in Apple's names ([ADR 0002](./docs/adr/0002-a-job-is-the-typed-launchd-plist-with-apples-key-names.md)). The package depends on `@zukhruf/async`, `@zukhruf/fs` and `plist`. It works only on macOS.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The decisions are in the [ADRs](./docs/adr/). The man pages are on each Mac: `man 5 launchd.plist`, `man 1 launchctl` and `man 3 xpc_events`. A line number in these documents is a line of `man -P cat <section> <page> | col -b | cat -n` on macOS 27.2.

## Install a job

`Launchd.agents()` gives the agents of this user. `install()` writes the job to its job file, `<Label>.plist` in the folder of the domain, and loads it ([ADR 0003](./docs/adr/0003-install-is-a-reconcile-that-enables-then-bootstraps.md)).

```ts
import { Launchd } from '@zukhruf/launchd';

const launchd = Launchd.agents({ clock: globalThis });
const service = await launchd.install({
  Label: 'com.example.sync',
  ProgramArguments: ['/opt/homebrew/bin/node', '/Users/me/sync/main.js'],
  KeepAlive: true,
  StandardErrorPath: '/Users/me/Library/Logs/sync.log',
});
console.log(launchd.domain, service.target, service.file);
// gui/501 gui/501/com.example.sync /Users/me/Library/LaunchAgents/com.example.sync.plist
```

`clock` is the clock of the waits of the package: the wait between two bootouts, and the wait of the atomic write of `@zukhruf/fs`. Give `globalThis` in production. It has no default ([root ADR 0004](../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md)).

An install is a reconcile. It renders the job to the bytes of its job file, and compares them with the file that is there:

- **The same bytes, and the service is loaded.** The install does nothing. A second install of the same job does not restart the process.
- **The same bytes, and the service is not loaded.** The install enables the service and bootstraps it.
- **Other bytes, or no file.** The install boots out the old service, and waits until launchd forgets it. It writes the job file with mode `0644` in one step. Then it enables the service and bootstraps it. Thus a changed job replaces the old service, and launchd reads the new file. An install that fails or stops halfway leaves the old bytes in the file, so the next install does the work again.
- **A label that is not one file name.** The label names the job file. An empty label, a label with `/` or a NUL character, and the labels `.` and `..` throw a `RangeError` before any file or launchctl call.

The package sorts the keys of each dictionary before it renders them, so the order of the keys in your object does not change the bytes ([ADR 0008](./docs/adr/0008-the-job-file-is-rendered-by-the-plist-package-with-sorted-keys.md)).

A bootstrap starts the process only when the job asks for it: with `RunAtLoad`, or with `KeepAlive`, which "implicitly implies RunAtLoad" (launchd.plist(5), lines 196-197). Else launchd waits for the launch conditions of the job, or for `kickstart()`.

A signal cancels the wait for the old service. The install then rejects with the reason of the signal. The new job file is in place, and launchd goes on with the bootout. Install again when launchd has forgotten the old service.

## Run the service now, and restart it

`kickstart()` makes launchd "run the specified service immediately, regardless of its configured launch conditions" (launchctl(1), lines 97-99). It gives the PID of the new process, or of the process that runs.

`kickstart({ kill: true })` kills the process that runs, and launchd starts it again (`kickstart -k`). This is a restart without a reload: launchd keeps the job that it loaded, and does not read the job file again. To change the job, install the changed job.

```ts
const pid = await service.kickstart();
const restarted = await service.kickstart({ kill: true });
```

When launchd has no such service in the domain, `kickstart()` rejects with `ServiceNotFoundError`.

## Send a process signal

`kill()` sends a process signal to the process of the service "if it is running" (launchctl(1), lines 198-201). It takes the name or the number of the signal.

```ts
await service.kill('SIGHUP');
await service.kill(15);
```

A job with `KeepAlive: true` starts again after its process ends. By default, launchd starts a job at most once every 10 seconds (`ThrottleInterval`, launchd.plist(5), lines 325-328).

## Read the state

`state()` runs `launchctl print <service-target>` one time. It gives one of three states:

```ts
const state = await service.state();
switch (state.state) {
  case 'not loaded':
    break;
  case 'running':
    console.log(state.pid, state.lastExitStatus);
    break;
  case 'not running':
    console.log(state.lastExitStatus);
    break;
}
```

- `not loaded`: launchd has no service with the label in the domain. `print` exits 113.
- `running`: the service has a process, with its `pid`.
- `not running`: the service is loaded, and has no process now.

`pid` and `lastExitStatus` come from two lines of the output: `pid =` and `last exit code =`. Apple says that the output of `print` "is NOT API in any sense at all" (launchctl(1), lines 222-224). [ADR 0006](./docs/adr/0006-the-state-of-one-service-comes-from-print-and-only-two-of-its-lines.md) says why the package reads it, and how it stays safe.

`lastExitStatus` is `undefined` when launchd shows no number: `(never exited)`, or no `last exit code` line. A service that the system ended for memory (a jetsam exit) shows `last exit reason` and no `last exit code` on macOS 27.2.

## Enable and disable

`disable()` sets the disabled override of the label. launchd then refuses to load the service in the domain until `enable()`, also after a restart of the computer (launchctl(1), lines 90-95). launchd keeps the override itself, apart from the job file. A disable changes only the next loads: boot out a loaded service too.

```ts
await service.bootout();
await service.disable(); // the next login does not load it

await service.enable();
await service.bootstrap();
```

Both take a label that is not loaded: `install()` enables the service before it bootstraps it, as Homebrew does (`cli.rb:465-473`). Thus an install undoes a disable.

## Unload and load again

`bootout()` removes the service from the domain. launchd stops the process and forgets the service. The job file stays in the folder, and "Some domains will implicitly bootstrap pre-defined paths as part of their creation" (launchctl(1), lines 85-88). Thus an enabled agent loads again at the next login.

launchd answers a bootout before the process is gone, and refuses a bootstrap of the label until then. Thus `bootout()` runs `launchctl bootout` again every second. While the bootout is in progress, launchd answers 36 (Operation now in progress). When launchd has forgotten the service, it answers 3 (No such process), and `bootout()` resolves ([ADR 0004](./docs/adr/0004-a-bootout-is-repeated-until-launchd-forgets-the-service.md)). launchd sends `SIGTERM` to the process, and `SIGKILL` after the `ExitTimeOut` of the job (launchd.plist(5), lines 319-323). A signal cancels the wait.

`bootstrap()` loads the job file into the domain again.

```ts
await service.bootout({ signal: AbortSignal.timeout(30_000) });
await service.bootstrap();
```

A bootout of a service that is not loaded resolves at once.

## Uninstall

`uninstall()` boots the service out, waits as `bootout()` does, and removes the job file. It resolves also when the service is not loaded and there is no file.

```ts
await service.uninstall({ signal: AbortSignal.timeout(30_000) });
```

launchd keeps the override of the label after an uninstall. A later install of the same label enables it again.

## List the installed jobs

`installed()` lists the files `*.plist` in the folder of the domain, sorted by name. It gives a `Service` for each file, with the label from the file name. launchd.plist(5) asks that a job file is named `<Label>.plist` (lines 59-62). `installed()` does not read the files. When the folder does not exist, the list is empty.

```ts
for (const service of await launchd.installed()) {
  console.log(service.label, (await service.state()).state);
}
```

The folder of agents holds the job files of other programs too, and `installed()` lists them.

`service(label)` gives the handle of one label in the domain. It reads nothing and runs nothing.

```ts
const sync = launchd.service('com.example.sync');
if ((await sync.state()).state === 'not loaded') await sync.bootstrap();
```

## Daemons

`Launchd.daemons()` gives the daemons of the `system` domain. Their job files are in `/Library/LaunchDaemons`. For the system domain, "root privileges are required to make modifications" (launchctl(1), lines 30-32). The package does not ask for root. A process that is not root gets `PermissionDeniedError`: from the write of the job file (`EACCES` or `EPERM`), or from `launchctl` (exit code 1).

```ts
import { Launchd, PermissionDeniedError } from '@zukhruf/launchd';

const daemons = Launchd.daemons({ clock: globalThis });
try {
  await daemons.install({
    Label: 'com.example.backup',
    Program: '/usr/local/libexec/backup',
    UserName: '_backup',
    StartCalendarInterval: { Hour: 3, Minute: 0 },
  });
} catch (error) {
  if (!(error instanceof PermissionDeniedError)) throw error;
  console.error('Run this as root, or install an agent.');
}
```

A daemon job can have `UserName`, `GroupName` and `InitGroups`. launchd applies them only in the system domain (launchd.plist(5), lines 74-83 and 333-337). An agent job can have `LimitLoadToSessionType`, which "only applies to jobs which are agents" (lines 104-107). The types `AgentJob` and `DaemonJob` hold this rule: `install()` of each domain takes only its own keys.

`state()` of a daemon needs no root: "Anyone may read or query the system domain" (launchctl(1), lines 30-31).

## Write a job

A job is an object with the keys of launchd.plist(5), with Apple's names and value types ([ADR 0002](./docs/adr/0002-a-job-is-the-typed-launchd-plist-with-apples-key-names.md)). The type has each key that the page documents as live.

| To do this                                | Key                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Run a program                             | `Program`, `ProgramArguments`, `WorkingDirectory`                                  |
| Give it its environment                   | `EnvironmentVariables`                                                             |
| Keep it running                           | `KeepAlive: true`                                                                  |
| Start it again after a failure only       | `KeepAlive: { SuccessfulExit: false }`                                             |
| Start it again after a crash              | `KeepAlive: { Crashed: true }`                                                     |
| Keep it running while a path exists       | `KeepAlive: { PathState: { '/path/to/file': true } }`                              |
| Run it at load                            | `RunAtLoad: true`                                                                  |
| Run it every N seconds                    | `StartInterval`                                                                    |
| Run it at a time of day, a day or a month | `StartCalendarInterval`                                                            |
| Run it when a path changes                | `WatchPaths`                                                                       |
| Run it while a folder is not empty        | `QueueDirectories`                                                                 |
| Run it on a connection                    | `Sockets`                                                                          |
| Run it on a device or a notification      | `LaunchEvents`                                                                     |
| Limit its resources                       | `ProcessType`, `SoftResourceLimits`, `HardResourceLimits`, `Nice`, `LowPriorityIO` |
| Keep its output                           | `StandardOutPath`, `StandardErrorPath`                                             |
| Wait between two starts                   | `ThrottleInterval`                                                                 |
| Give it time to stop                      | `ExitTimeOut`                                                                      |

```ts
import type { AgentJob } from '@zukhruf/launchd';

const nightly: AgentJob = {
  Label: 'com.example.nightly',
  ProgramArguments: ['/opt/homebrew/bin/node', '/Users/me/nightly/main.js'],
  EnvironmentVariables: {
    HOME: '/Users/me',
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  },
  StartCalendarInterval: [
    { Hour: 3, Minute: 0 },
    { Weekday: 0, Hour: 12, Minute: 30 },
  ],
  StandardOutPath: '/Users/me/Library/Logs/nightly.log',
  StandardErrorPath: '/Users/me/Library/Logs/nightly.log',
  ProcessType: 'Background',
};

const watcher: AgentJob = {
  Label: 'com.example.watcher',
  Program: '/usr/local/bin/watcher',
  KeepAlive: {
    SuccessfulExit: false,
    PathState: { '/Users/me/.watcher-on': true },
  },
  ThrottleInterval: 30,
  SoftResourceLimits: { NumberOfFiles: 4096 },
  HardResourceLimits: { NumberOfFiles: 8192 },
};

const server: AgentJob = {
  Label: 'com.example.server',
  Program: '/usr/local/bin/server',
  Sockets: {
    Listeners: { SockNodeName: '127.0.0.1', SockServiceName: 8080 },
  },
};
```

- **Program.** `Program` is an absolute path: "The Program key must be an absolute path" (launchd.plist(5), lines 142-143). With no `Program`, item 0 of `ProgramArguments` is the program. It can be a name, but launchd finds a name in `/usr/bin:/bin:/usr/sbin:/sbin` (`_PATH_STDPATH`, lines 144-146), not in your `PATH`. A job has `Program`, a non-empty `ProgramArguments`, or both: then `ProgramArguments` is the whole argument vector, with its item 0 (lines 719-726).
- **Paths.** Each other key that takes a path takes an absolute path, `` `/${string}` ``. launchd expands no `~` and no `$HOME`.
- **KeepAlive.** "If multiple keys are provided, launchd ORs them" (lines 191-193). The watcher above starts again after a failure, and while the file exists.
- **Calendar intervals.** A missing field is a wildcard (lines 366-367). The fields are unions of their ranges: `Minute` 0-59, `Hour` 0-23, `Day` 1-31, `Weekday` 0-7 (0 and 7 are Sunday), `Month` 1-12. When the computer sleeps through an interval, launchd starts the job when it wakes, and starts it once for many missed intervals (lines 372-375). A `StartInterval` that falls in a sleep is missed (lines 357-362).
- **Sockets.** A socket has `SockPathName`, or `SecureSocketWithKey`, or the keys of a network socket, never keys of two forms. `SockPathMode` is decimal: "Property lists don't support octal" (lines 635-638). The program gets the sockets through `launch_activate_socket(3)` (lines 578-581).
- **Integers.** Each number key is an integer. The package renders a whole number as `<integer>`.

`LaunchEvents` takes the two event streams of xpc_events(3), "currently the only two supported event streams" (lines 29-34). The names of the events are yours. An IOKit event is a matching dictionary, and it must have `IOMatchLaunchStream: true` (lines 89-92). Its other keys are matching keys, such as `IOProviderClass`, and the properties that the device must have. A notification event names the notification that `notify_post(3)` posts. The example of xpc_events(3), lines 52-81:

```ts
const onDevice: AgentJob = {
  Label: 'com.example.on-device',
  Program: '/usr/local/libexec/on-device',
  LaunchEvents: {
    'com.apple.iokit.matching': {
      'Device was attached': {
        IOMatchLaunchStream: true,
        IOProviderClass: 'IOUSBDevice',
        idVendor: 725,
        idProduct: 2794,
      },
    },
    'com.apple.notifyd.matching': {
      'interesting-notification was posted': {
        Notification: 'com.apple.interesting-notification',
      },
    },
  },
};
```

A job with `LaunchEvents` "MUST check in for the event with xpc_set_event_stream_handler() during its initialization" (xpc_events(3), lines 22-27), and a job with `MachServices` must check in for them (launchd.plist(5), lines 46-53). Node.js has no binding for these calls, so give these keys to a native program.

The type leaves out the keys that the page says are no longer supported, no longer implemented, or to remove: `LimitLoadToHosts`, `LimitLoadFromHosts`, `OnDemand` (use `KeepAlive`), `ServiceIPC`, `TimeOut`, `HopefullyExitsFirst`, `HopefullyExitsLast` and `NetworkState` of `KeepAlive`. It also leaves out `BundleProgram`, a key of SMAppService, and `Disabled`, which the override of `enable` replaces. [ADR 0002](./docs/adr/0002-a-job-is-the-typed-launchd-plist-with-apples-key-names.md) quotes the page for each.

## Catch the errors that change what you do next

An error has its own class when a caller does something different after it ([ADR 0007](./docs/adr/0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md)). Each class comes from the exit code of `launchctl`, or from the error of Node.js.

| Class                     | When                                                                                                                                        | What the caller does next                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `ServiceNotFoundError`    | `kickstart()` or `kill()`, and launchctl exits 113 (Could not find specified service): the domain has no service with the label             | Install the job, or bootstrap its job file |
| `PermissionDeniedError`   | The write or the removal of the job file fails with `EACCES` or `EPERM`, or launchctl exits 1 (Operation not permitted). Daemons need root. | Run as root, or install an agent           |
| `LaunchdUnavailableError` | `/bin/launchctl` does not start (`ENOENT`): this system is not macOS                                                                        | Skip the work for launchd on this system   |
| `ServiceDisabledError`    | Only if bootstrap of a disabled service gives its own exit code; the build probes it                                                        | `enable()`, then `bootstrap()`             |

Each class extends a base class, so a broad catch still works. `LaunchdError` is the base of every error of the package. `LaunchctlError` is the base of every answer of launchctl that is an error: it has `args`, `exitCode` and `stderr`. An exit code with no class of its own is a `LaunchctlError`. For example, a bootstrap that launchd refuses often exits 5 (Input/output error) with no reason, and stderr says "Try re-running the command as root for richer errors." `launchctl error <code>` decodes each code.

`PermissionDeniedError` comes from the file or from launchctl, so it extends `LaunchdError`. Its `cause` is the error of Node.js or the `LaunchctlError`. Another error of the file system, such as `ENOSPC`, stays the error of Node.js. A cancel rejects with the reason of the signal, as each cancel does ([the async glossary](../async/CONTEXT.md)).

Some answers of launchctl are not errors here:

| Call                                    | Answer of launchctl            | Result                    |
| --------------------------------------- | ------------------------------ | ------------------------- |
| `state()`                               | 113                            | `{ state: 'not loaded' }` |
| `bootout()`, `uninstall()`, `install()` | 36 (Operation now in progress) | the wait goes on          |
| `bootout()`, `uninstall()`, `install()` | 3 (No such process)            | the wait ends             |

```ts
import {
  Launchd,
  LaunchdUnavailableError,
  ServiceNotFoundError,
} from '@zukhruf/launchd';

const launchd = Launchd.agents({ clock: globalThis });
const sync = launchd.service('com.example.sync');

const pid = await sync.kickstart().catch(async (error) => {
  if (!(error instanceof ServiceNotFoundError)) throw error;
  await launchd.install(job);
  return sync.kickstart();
});

async function loaded(): Promise<boolean> {
  try {
    return (await sync.state()).state !== 'not loaded';
  } catch (error) {
    if (error instanceof LaunchdUnavailableError) return false;
    throw error;
  }
}
```

## What launchd does not do

- **It has no limit on restarts.** A `KeepAlive` job that exits starts again after `ThrottleInterval`, 10 seconds by default (launchd.plist(5), lines 325-328), forever. context-compiler found this (its backlog #4288). A program that must stop after many failures counts them itself. Or it uses `KeepAlive: { SuccessfulExit: false }`, and exits with status 0 to stop: launchd then does not start it again (lines 208-213).
- **A job does not inherit the environment of the program that installs it.** context-compiler found this (its backlog #4280). Give each variable in `EnvironmentVariables`. The job file has mode `0644`, and each user of the computer can read it, so do not put a secret in it.
- **It has no shell.** launchd gives `ProgramArguments` to execvp(3) (lines 136-140). It expands no `~`, no `$HOME` and no other variable, and it has no pipes. `EnableGlobbing` expands globs (lines 148-150). Thus each path in a job is absolute.
- **macOS charges file access to the program that the job runs.** "Daemons and agents managed by launchd are subject to macOS user privacy protections" (lines 692-696). A job that reads a protected folder needs Full Disk Access for its program, for example the `node` binary, not for the terminal app that installed it. context-compiler records this in `apps/cli/src/background-watch.ts:22-23`.

## What the package does not do

- **It does not ask for root.** It runs no `sudo`, and no `osascript` with administrator privileges. Install a daemon from a process that is root already. No leading tool escalates: Homebrew prints "Try: sudo".
- **It does not grant privacy access** (TCC, Full Disk Access). Only the user grants it, in System Settings.
- **It does not use SMAppService.** SMAppService registers a job that is inside an app bundle (`Contents/Library/LaunchAgents`), and Node.js can call it only through a native binding ([ADR 0001](./docs/adr/0001-launchctl-is-the-interface-and-only-its-current-subcommands.md)). An app that installs a job file without SMAppService "should include this key with a value of the app's bundle identifier": `AssociatedBundleIdentifiers` (launchd.plist(5), lines 686-690).
- **It does not read logs.** launchd writes the output of the job to `StandardOutPath` and `StandardErrorPath`. Read those files.
- **It does not read a job file that it did not render.** It never parses a property list. `installed()` takes the labels from the file names. A program that inspects the job files of other programs reads them itself.

## The same concepts in other systems

| Concept                           | Other systems                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A job with Apple's key names      | `serviceConfig` of nix-darwin's `launchd.agents`, `launchd.daemons` and `launchd.user.agents`; the Rust crate koenichiwa/launchd                                                                                                                                                                                                                                                                                                                        |
| Install and load a job            | `brew services start` (`cli.rb:529-573`); the activation of nix-darwin; Ansible's `community.general.launchd`; `Install` and `Start` of kardianos/service, with the option `UserService` for an agent; the `service` resource of Puppet with its launchd provider                                                                                                                                                                                       |
| The reconcile                     | nix-darwin reloads a job only when its rendered file differs from the installed file (`modules/system/launchd.nix:19,37`). Homebrew's `start` does nothing when the service runs.                                                                                                                                                                                                                                                                       |
| The current subcommands           | Only Homebrew (`cli.rb:465-473`). nix-darwin, Ansible, kardianos and Puppet use the legacy `load` and `unload`.                                                                                                                                                                                                                                                                                                                                         |
| The wait after a bootout          | Homebrew: `bootout` again every second, up to 60 seconds by default (`cli.rb:291-329`, `stop.rb:37`). Ansible sleeps 5 seconds, and kardianos 50 ms.                                                                                                                                                                                                                                                                                                    |
| The state of one service          | Homebrew reads `print` (`formula_wrapper.rb:498-525`). Ansible, kardianos and Puppet read `list`.                                                                                                                                                                                                                                                                                                                                                       |
| The domain of agents              | Homebrew's `system.rb:94-117`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A job from an app bundle          | SMAppService of the ServiceManagement framework                                                                                                                                                                                                                                                                                                                                                                                                         |
| For orientation: systemd on Linux | A unit file in `~/.config/systemd/user/` or `/etc/systemd/system/` is a job file, and `systemctl --user` works in the domain of the user. `systemctl start`, `restart`, `kill` and `show` are near `kickstart`, `kickstart -k`, `kill` and `print`. `enable` differs: in systemd it makes a unit start at boot, and in launchd it only sets the override. systemd's `StartLimitBurst` stops a unit after many fast restarts; launchd has no such limit. |

## API

```ts
import type { Clock } from '@zukhruf/async';

/** The jobs of one domain, and the folder of their job files. */
export class Launchd<J extends AgentJob | DaemonJob> {
  /** This user's agents: gui/<uid> when this uid owns /dev/console, else user/<uid>. The folder is Library/LaunchAgents in the home folder of the uid. */
  static agents(options: LaunchdOptions): Launchd<AgentJob>;
  /** The daemons of the system domain, in /Library/LaunchDaemons. A change needs root. */
  static daemons(options: LaunchdOptions): Launchd<DaemonJob>;

  /** The domain-target: 'gui/501', 'user/501' or 'system'. */
  readonly domain: Domain;
  /** The absolute path of the folder of the job files. */
  readonly folder: string;

  /** The reconcile: writes <folder>/<Label>.plist when its bytes differ, boots out the old service, enables, bootstraps. */
  install(job: J, options?: CancelOptions): Promise<Service>;
  /** The handle of a label in this domain. Reads nothing and runs nothing. */
  service(label: string): Service;
  /** A handle for each <folder>/*.plist, with the label from the file name, sorted. No folder gives []. */
  installed(options?: CancelOptions): Promise<Service[]>;
}

export interface LaunchdOptions {
  /** The clock of the waits: the bootout wait and the atomic write. Production gives `globalThis`. */
  clock: Clock;
}

export interface CancelOptions {
  /** Cancels the wait. The call then rejects with `signal.reason`. */
  signal?: AbortSignal;
}

/** A domain-target of launchctl(1). */
export type Domain = `gui/${number}` | `user/${number}` | 'system';

/** One label in one domain. A handle: it holds no state, and it exists also when launchd has no such service. */
export class Service {
  readonly label: string;
  /** The job file: <folder>/<label>.plist. */
  readonly file: string;
  /** The service-target: <domain>/<label>, such as 'gui/501/com.example.sync'. */
  readonly target: string;

  /** One `launchctl print <target>`: exit code 113 and the lines `pid =` and `last exit code =`. */
  state(options?: CancelOptions): Promise<ServiceState>;
  /** Runs the service now (`kickstart -p`). With `kill`, kills the process that runs first (`-k`). Gives the PID of the new process, or of the process that runs. */
  kickstart(options?: CancelOptions & { kill?: boolean }): Promise<number>;
  /** Sends a process signal, by name or number, to the process of the service. */
  kill(
    processSignal: NodeJS.Signals | number,
    options?: CancelOptions,
  ): Promise<void>;
  /** Enables the service: launchd may load it again. */
  enable(options?: CancelOptions): Promise<void>;
  /** Disables the service: launchd does not load it until enable(), also after a restart. */
  disable(options?: CancelOptions): Promise<void>;
  /** Loads the job file into the domain. */
  bootstrap(options?: CancelOptions): Promise<void>;
  /** Removes the service from the domain, and waits until launchd forgets it. The job file stays. */
  bootout(options?: CancelOptions): Promise<void>;
  /** bootout(), then removes the job file. Resolves when neither is there. */
  uninstall(options?: CancelOptions): Promise<void>;
}

/** What `launchctl print` shows of one service. */
export type ServiceState =
  | { readonly state: 'not loaded' }
  | {
      readonly state: 'running';
      readonly pid: number;
      /** undefined: no number in a `last exit code` line, or no such line. */
      readonly lastExitStatus: number | undefined;
    }
  | {
      readonly state: 'not running';
      readonly lastExitStatus: number | undefined;
    };

/** An absolute path. launchd expands no `~` and no `$HOME`. */
export type AbsolutePath = `/${string}`;

/** The keys of launchd.plist(5) that agents and daemons share: `Program`, or a non-empty `ProgramArguments`, or both. */
export type Job = {
  /** Unique in the domain. The job file is <Label>.plist. */
  Label: string;
  inetdCompatibility?: { Wait?: boolean };
  /** Keys of the "hw" sysctl(3) domain, such as model. */
  LimitLoadToHardware?: Readonly<Record<string, readonly string[]>>;
  LimitLoadFromHardware?: Readonly<Record<string, readonly string[]>>;
  EnableGlobbing?: boolean;
  EnableTransactions?: boolean;
  EnablePressuredExit?: boolean;
  KeepAlive?: boolean | KeepAliveConditions;
  RunAtLoad?: boolean;
  RootDirectory?: AbsolutePath;
  WorkingDirectory?: AbsolutePath;
  EnvironmentVariables?: Readonly<Record<string, string>>;
  /** A decimal integer, or a string that strtoul(3) reads: '022' is octal. */
  Umask?: number | string;
  /** Seconds from SIGTERM to SIGKILL. 0 is infinity: do not use it. */
  ExitTimeOut?: number;
  /** Seconds between two starts. 10 by default. */
  ThrottleInterval?: number;
  WatchPaths?: readonly AbsolutePath[];
  QueueDirectories?: readonly AbsolutePath[];
  StartOnMount?: boolean;
  /** Seconds. A start that falls in a sleep is missed. */
  StartInterval?: number;
  StartCalendarInterval?: CalendarInterval | readonly CalendarInterval[];
  StandardInPath?: AbsolutePath;
  StandardOutPath?: AbsolutePath;
  StandardErrorPath?: AbsolutePath;
  Debug?: boolean;
  WaitForDebugger?: boolean;
  SoftResourceLimits?: ResourceLimits;
  HardResourceLimits?: ResourceLimits;
  Nice?: number;
  ProcessType?: 'Background' | 'Standard' | 'Adaptive' | 'Interactive';
  AbandonProcessGroup?: boolean;
  LowPriorityIO?: boolean;
  LowPriorityBackgroundIO?: boolean;
  MaterializeDatalessFiles?: boolean;
  LaunchOnlyOnce?: boolean;
  /** Each key is the name of a Mach service. The program must check in for it. */
  MachServices?: Readonly<Record<string, true | MachService>>;
  /** Each key is a name of your own for a socket or a group of sockets. */
  Sockets?: Readonly<Record<string, Socket | readonly Socket[]>>;
  LaunchEvents?: LaunchEvents;
  SessionCreate?: boolean;
  LegacyTimers?: boolean;
  AssociatedBundleIdentifiers?: string | readonly string[];
} & (
  | { Program: AbsolutePath; ProgramArguments?: readonly string[] }
  | { Program?: never; ProgramArguments: readonly [string, ...string[]] }
);

/** A job for the agents of a user. */
export type AgentJob = Job & {
  LimitLoadToSessionType?: SessionType | readonly SessionType[];
};

/** The session types of launchctl(1): Aqua is the default. */
export type SessionType = 'Aqua' | 'Background' | 'LoginWindow';

/** A job for the daemons of the system domain. */
export type DaemonJob = Job & {
  UserName?: string;
  /** Without it, the primary group of UserName. */
  GroupName?: string;
  /** true by default. Ignored without UserName. */
  InitGroups?: boolean;
};

/** launchd ORs the conditions. */
export interface KeepAliveConditions {
  /** Evaluates the other conditions only after the first launch for another reason. PathState is not affected. */
  AfterInitialDemand?: boolean;
  /** true: start again after exit status 0. false: start again after another exit status. */
  SuccessfulExit?: boolean;
  /** true keeps the job running while the path exists; false, while it does not. */
  PathState?: Readonly<Record<AbsolutePath, boolean>>;
  /** Each key is a label: true keeps the job running while that job is loaded. */
  OtherJobEnabled?: Readonly<Record<string, boolean>>;
  /** true: start again after a crash signal (SIGILL, SIGSEGV …). false: start again after another exit. */
  Crashed?: boolean;
}

/** A missing field is a wildcard. When Day and Weekday are both set, either one matches. */
export interface CalendarInterval {
  // The code lists each value of a range.
  Minute?: 0 | 1 | 2 | /* … */ 59;
  Hour?: 0 | 1 | 2 | /* … */ 23;
  Day?: 1 | 2 | 3 | /* … */ 31;
  /** 0 and 7 are Sunday. */
  Weekday?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  Month?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
}

/** The limits of setrlimit(2), in bytes, seconds or counts. */
export interface ResourceLimits {
  Core?: number;
  CPU?: number;
  Data?: number;
  FileSize?: number;
  MemoryLock?: number;
  NumberOfFiles?: number;
  NumberOfProcesses?: number;
  ResidentSetSize?: number;
  Stack?: number;
}

export interface MachService {
  ResetAtClose?: boolean;
  HideUntilCheckIn?: boolean;
}

/** One socket: a Unix domain socket at a path, a secure Unix domain socket, or a network socket. A form never takes the keys of another form (they are `?: never` in the code). */
export type Socket = {
  SockType?: 'stream' | 'dgram' | 'seqpacket';
  /** true (the default) listens; false connects. */
  SockPassive?: boolean;
} & (
  | {
      SockPathName: AbsolutePath;
      SockPathOwner?: number;
      SockPathGroup?: number;
      /** Decimal: property lists have no octal. */
      SockPathMode?: number;
    }
  | {
      /** The name of the environment variable that gets the path. */
      SecureSocketWithKey: string;
      SockPathOwner?: number;
      SockPathGroup?: number;
      SockPathMode?: number;
    }
  | {
      SockNodeName?: string;
      /** A port number, or a service name such as 'ssh'. */
      SockServiceName?: string | number;
      SockFamily?: 'IPv4' | 'IPv6' | 'IPv4v6';
      SockProtocol?: 'TCP' | 'UDP';
      Bonjour?: boolean | string | readonly string[];
      MulticastGroup?: string;
    }
);

/** The two event streams of xpc_events(3). The keys of a stream are event names of your own. */
export interface LaunchEvents {
  'com.apple.iokit.matching'?: Readonly<Record<string, MatchingDictionary>>;
  'com.apple.notifyd.matching'?: Readonly<
    Record<string, { Notification: string }>
  >;
}

/** An IOKit matching dictionary. Its other keys are the matching keys of IOKitKeys.h and the properties that the device must have, such as idVendor. */
export type MatchingDictionary = {
  /** Required by xpc_events(3). launchd removes it before IOKit matches. */
  IOMatchLaunchStream: true;
  IOProviderClass?: string;
  [key: string]: PropertyListValue;
};

/** A value of a property list that IOKit matches: a string, a number, a boolean, an array or a dictionary of these. */
export type PropertyListValue =
  | string
  | number
  | boolean
  | readonly PropertyListValue[]
  | { readonly [key: string]: PropertyListValue };

/** The base of every error of the package. */
export class LaunchdError extends Error {}

/** launchctl exited with a code that is not 0. The base of every answer of launchctl that is an error. */
export class LaunchctlError extends LaunchdError {
  /** The arguments after /bin/launchctl, such as ['kickstart', '-p', 'gui/501/com.example.sync']. */
  readonly args: readonly string[];
  /** `launchctl error <code>` decodes it. */
  readonly exitCode: number;
  readonly stderr: string;
}

/** launchctl exited 113 (Could not find specified service) for kickstart or kill. */
export class ServiceNotFoundError extends LaunchctlError {
  readonly target: string;
}

/** Only if bootstrap of a disabled service gives its own exit code; the build probes it. */
export class ServiceDisabledError extends LaunchctlError {
  readonly target: string;
}

/** EACCES or EPERM on the job file, or launchctl exit code 1. `cause` is the error of Node.js or the LaunchctlError. */
export class PermissionDeniedError extends LaunchdError {}

/** /bin/launchctl did not start (ENOENT): this system is not macOS. `cause` is the error of Node.js. */
export class LaunchdUnavailableError extends LaunchdError {}
```

## Each call and what it runs

Each `launchctl` below is `/bin/launchctl`, started with `execFile` and no shell. `<target>` is `<domain>/<label>`, and `<file>` is `<folder>/<label>.plist`.

| Call                     | What it runs                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Launchd.agents()`       | A stat of `/dev/console` for its owner, and `os.userInfo()` for the home folder                                                                                                                                                                                                                                                                                                                                      |
| `Launchd.daemons()`      | Nothing                                                                                                                                                                                                                                                                                                                                                                                                              |
| `launchd.install(job)`   | Render the job with `plist`, keys sorted; read `<file>`. The same bytes: `launchctl print <target>`; when it exits 113, `launchctl enable <target>` and `launchctl bootstrap <domain> <file>`. Other bytes or no file: `launchctl bootout <target>` every second until it exits 3; make `<folder>`; an atomic write of `<file>` with mode `0644`; `launchctl enable <target>`; `launchctl bootstrap <domain> <file>` |
| `launchd.service(label)` | Nothing                                                                                                                                                                                                                                                                                                                                                                                                              |
| `launchd.installed()`    | A read of the names in `<folder>`                                                                                                                                                                                                                                                                                                                                                                                    |
| `service.state()`        | `launchctl print <target>`                                                                                                                                                                                                                                                                                                                                                                                           |
| `service.kickstart()`    | `launchctl kickstart -p <target>`; with `kill`, `launchctl kickstart -k -p <target>`                                                                                                                                                                                                                                                                                                                                 |
| `service.kill(sig)`      | `launchctl kill <sig> <target>`                                                                                                                                                                                                                                                                                                                                                                                      |
| `service.enable()`       | `launchctl enable <target>`                                                                                                                                                                                                                                                                                                                                                                                          |
| `service.disable()`      | `launchctl disable <target>`                                                                                                                                                                                                                                                                                                                                                                                         |
| `service.bootstrap()`    | `launchctl bootstrap <domain> <file>`                                                                                                                                                                                                                                                                                                                                                                                |
| `service.bootout()`      | `launchctl bootout <target>` every second until it exits 3                                                                                                                                                                                                                                                                                                                                                           |
| `service.uninstall()`    | As `bootout()`, then a removal of `<file>` that ignores a missing file                                                                                                                                                                                                                                                                                                                                               |

## What each repository changes

The package leads. Each repository below changes to fit it, with no adapter. Each change is a backlog item in that repository.

| Repository                                          | Change                                                                                                                                                                                                                                                                                                                                                  | Backlog              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| context-compiler `apps/cli/src/background-watch.ts` | `BackgroundWatch` moves onto the package: `Launchd.agents()`, `install()` in place of `plutil` and its own bootout loop, and `uninstall()`. The job file becomes mode `0644`, so the Google client secret leaves it first (#4280). The end-to-end test (`apps/cli/src/cli.e2e.test.ts:4211-4330`) reads `state()` in place of its own parse of `print`. | backlog item to come |
| mac-cleanup `src/tasks/macos/launch-agents.ts`      | `assertNotLoaded` reads `launchd.service(label).state()` in place of `launchctl print` and its check of 113, and its advice names `service.target`. It still reads the job files of other programs itself. Its tests (`test/learned.test.ts:476-532, 847-872`) change with it.                                                                          | backlog item to come |
| agent-plugin                                        | The nightly job of backlog #3821, with `StartCalendarInterval`, uses `install()` when it is built.                                                                                                                                                                                                                                                      | backlog item to come |
