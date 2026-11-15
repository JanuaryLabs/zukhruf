# Install is a reconcile that enables, then bootstraps

A program installs its job at each start, or at each run of its own install command. A second install of the same job must not restart the service. A changed job must replace the loaded service, because launchd keeps the job that it loaded and does not read the job file again: launchctl(1) calls `debug` "a convenient alternative to editing the launchd.plist(5) for the service and then reloading it" (lines 130-133). And launchd refuses to bootstrap a label that it still has. context-compiler found this: "launchd refuses a label it already runs" (`apps/cli/src/background-watch.ts:47-48`).

The leading tools (research record, 2026-11-15):

- nix-darwin renders the job file, compares it with the installed file, and reloads the service only when they differ (`modules/system/launchd.nix:19,37`).
- Homebrew's `start` does nothing when the service runs. Else it writes the job file with mode `0644` and bootstraps it (`cli.rb:529-573`). It runs `enable` before `bootstrap` (`cli.rb:465-473`), so a start also undoes a disable.
- kardianos/service fails when the job is already installed. Ansible's module compares the state that it reads with the state that the caller asks for.
- context-compiler boots out and bootstraps at each install (`background-watch.ts:49-73`), so each install restarts the process.

The package compares the bytes, as nix-darwin does. It boots out the old service before it writes the new file, as nix-darwin and Homebrew both do: nix-darwin unloads, copies and loads (`modules/system/launchd.nix:37`), and Homebrew's `restart` stops the service and removes its file before it writes the file again (`restart.rb:29-40`). It enables before it bootstraps, as Homebrew does:

1. Render the job to the bytes of its job file ([ADR 0008](./0008-the-job-file-is-rendered-by-the-plist-package-with-sorted-keys.md)), and read the file at `<folder>/<Label>.plist`.
2. The bytes are the same: `print` the service. When it is loaded, the install is done. When it is not loaded (113), go to step 5.
3. The bytes differ, or there is no file: boot out the old service, and wait until launchd forgets it ([ADR 0004](./0004-a-bootout-is-repeated-until-launchd-forgets-the-service.md)). When nothing is loaded, the first bootout answers 3 at once.
4. Make the folder, and write the file with mode `0644` in one step (`atomicWrite` of `@zukhruf/fs`).
5. `enable` the service, then `bootstrap` the job file.

## Considered Options

- **Boot out and bootstrap at each install, as context-compiler.** Each install restarts the process, also when nothing changed.
- **Fail when the job is installed, as kardianos.** Each caller then writes the compare itself.
- **Compare the bytes, as nix-darwin, and enable before the bootstrap, as Homebrew.** This option was selected.

## Consequences

- A second install of the same job runs one `print`, writes nothing, and does not restart the process.
- A changed job replaces the loaded service. The new process runs the new job.
- An install enables the service. It undoes an earlier `disable()`, as Homebrew's `start` does.
- The job file has mode `0644`. Each user of the computer can read it, so a job holds no secret. context-compiler writes its file with mode `0600`, because it holds a client secret, and that secret leaves the file first (its backlog #4280).
- A failed, cancelled or interrupted install is safe to repeat, and the next install repairs it. Until the write of step 4, the file keeps the old bytes, so the next install sees other bytes and runs steps 3 to 5 again. A cancel during the wait of step 3 leaves the old file, and launchd goes on with the bootout. A write that fails after the bootout leaves the service stopped, and the install rejects with the error of the write.
- The other order, a write before the bootout, leaves a window that no install repairs. When the process dies between the write and the bootout, the old service stays loaded beside the new file, and the next install finds the same bytes and a loaded service, and does nothing.
- The label names the job file, so an install refuses a label that is not one file name: an empty label, a label with `/` or a NUL character, and the labels `.` and `..`. It throws a `RangeError` before any file or launchctl call, as other zukhruf packages do for an argument that cannot be right. Without the check, a label such as `../x` writes outside the folder.
- A job file that another program changed, even only in its spaces, has other bytes. The next install writes it again and reloads the service.
