# The domain of agents follows the owner of the console

An agent runs in a domain of its user, and launchctl(1) gives two of them. "A user-login domain is created when the user logs in at the GUI", and `gui/<uid>` targets it (launchctl(1), lines 39-51). `user/<uid>` targets the user domain, which "may exist independently of a logged-in user" (lines 34-37). The two domains share their Mach names, "But they still have discrete sets of services" (lines 53-59). So a user who did not log in at the GUI, for example over SSH, has no `gui/<uid>` domain, and a service in `user/<uid>` is not a service in `gui/<uid>`.

The leading tools and the consumers (research record, 2026-11-15):

- Homebrew picks the domain in `system.rb:94-117`. Root gets `system`. A user under `sudo`, or on an SSH terminal that does not own `/dev/console`, gets `user/<uid>`. Each other user gets `gui/<uid>`.
- context-compiler always uses `gui/<uid>` (`apps/cli/src/background-watch.ts:32`), and so does mac-cleanup (`src/tasks/macos/launch-agents.ts:58`).
- All the leaders put the job file of an agent in `~/Library/LaunchAgents/<Label>.plist`, and of a daemon in `/Library/LaunchDaemons/<Label>.plist`.

The owner of `/dev/console` is the user at the GUI. When this process's user owns it, the `gui/<uid>` domain exists. Else the user domain is the one that exists.

## Considered Options

- **Always `gui/<uid>`, as context-compiler and mac-cleanup.** A user who is not at the GUI has no such domain.
- **Homebrew's whole rule, with its own checks for `sudo` and SSH.** The package does not escalate, and a process under `sudo` is root, which installs daemons with `Launchd.daemons()`. The owner of the console alone tells whether `gui/<uid>` exists.
- **A domain that each caller gives.** Each caller then repeats the same rule.
- **`gui/<uid>` when this user owns `/dev/console`, else `user/<uid>`; `system` for daemons.** This option was selected.

## Consequences

- `Launchd.agents()` reads the owner of `/dev/console` one time, when it makes the handle, and the handle keeps its domain. When the owner of the console changes, for example after a switch of users, make a new handle.
- The folder of agents is `Library/LaunchAgents` under `$HOME`, from `os.homedir()`, which reads `$HOME` and falls back to the user database. `<uid>` comes from `os.userInfo()`. See _The folder of agents_ below.
- `Launchd.daemons()` uses the `system` domain and the folder `/Library/LaunchDaemons`. It reads nothing.
- Over SSH, an agent loads into `user/<uid>`. `state()` reads the domain of its handle, so it finds that service, and a handle for `gui/<uid>` does not.

## The folder of agents (amended 2026-11-16, #4439)

The folder of agents first came from the home folder in the user database, `os.userInfo().homedir`, so that the domain and the folder named the same user. A program run with another `$HOME` then wrote its job files to the real `~/Library/LaunchAgents`: context-compiler's e2e tests run its CLI with a temporary `$HOME`, and their test jobs would land among the user's own agents.

The leaders split, and the macOS ones read `$HOME`:

- Homebrew: `Pathname.new("#{Dir.home}/Library/LaunchAgents")` in `user_path` (`/opt/homebrew/Library/Homebrew/services/system.rb:78-80`). Ruby's `Dir.home` reads `$HOME`.
- pm2: `path.join(process.env.HOME, 'Library/LaunchAgents/' + launchd_service_name + '.plist')` (`lib/API/Startup.js:146` and `:283`).
- kardianos/service reads the user database first: `getHomeDir()` returns `user.Current().HomeDir`, and reads `$HOME` only when that fails (`service_darwin.go:89-100`). Go's `user.Current()` ignores `$HOME`, with cgo or without.

Decision: the folder is `Library/LaunchAgents` under `os.homedir()`, which reads `$HOME` first and falls back to the user database, as Homebrew and pm2 do. The user database lost because `$HOME` is how a caller says where its files go, and a program that sets it, such as a test, expects its files there. The domain is unchanged: `<uid>` names the user to launchd, and a `$HOME` cannot change it. A caller that sets `$HOME` to another user's home folder gets job files there and services in its own domain.
