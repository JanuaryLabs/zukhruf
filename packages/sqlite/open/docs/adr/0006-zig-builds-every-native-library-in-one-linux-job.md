# Zig builds every native library in one Linux job

The native library ([ADR 0003](./0003-persistent-wal-through-a-native-library.md)) is code for one platform. The package must work on macOS, Linux and Windows: zukhruf keeps Windows support, the CI of zukhruf runs on Linux, and text2sql ships a desktop app for the three systems. The CI and the release of zukhruf are one job on `ubuntu-latest`, with no macOS or Windows job, by the decision of the maintainer of this repository.

`zig cc` compiles C for each platform from one machine. Probes on 2026-11-06 with zig 0.16.0 built the library for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-x64` and `win32-arm64`. The `darwin-arm64` library has the ad-hoc signature that Apple Silicon requires, and `node:sqlite` loads it. The `linux-arm64` library works in the `node:26-slim` container.

## Decision

- The target `native` runs `src/native/build.ts`, which runs `zig cc` once for each platform. It writes `lib/<platform>-<arch>/persist_wal.<dylib|so|dll>` at the root of the package. `build` depends on `native`.
- The library is at the root of the package, not in `dist` or `src`. The tests run the files in `src`, and the package runs the files in `dist`. Both find `../lib`.
- The package has the official headers of SQLite 3.54.0, the version that `node:sqlite` 26.13 has, in `src/native/`. Linux has no macOS SDK, and the header of the macOS SDK turns off the macros of an extension.
- The Linux library is built with `-nostdlib`. It calls no function of the C library, so one file can load with glibc and with musl. A test in the `node:26-slim` and `node:26-alpine` containers proves the load before the consumers use the release.
- The shared action `setup-workspace` installs zig 0.16.0 with a published setup action. CI and the release both use it.

## Considered Options

- **A macOS job and a Windows job.** The CI of this repository is one Linux job.
- **Build on the machine of the user, at install.** Each user then needs a C compiler.
- **Commit the built files.** Binary files in git, which nobody can check against the source.
- **One package for each platform, as `sqlite-vec` does.** Useful when the files are large. These files are less than 200 KB.
- **Zig in the one Linux job.** This option was selected.

## Consequences

- One job builds and tests all the platforms that it can run. Linux CI tests the Linux library.
- Nothing in CI loads the macOS or Windows library. A test on this Mac loads the macOS library from the published package before the consumers use it. The Windows load is not proven yet.
