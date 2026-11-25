# The job file is rendered by the plist package, with sorted keys

`install` compares the bytes of the rendered job with the installed job file ([ADR 0003](./0003-install-is-a-reconcile-that-enables-then-bootstraps.md)). Thus one job must give the same bytes each time, whatever the order of the keys in the caller's object. The output of nix-darwin's `toPlist` has sorted keys, because the attribute sets of Nix are sorted, and nix-darwin compares that output with the installed file (`modules/system/launchd.nix:19,37`).

Three ways render a job to XML:

- **Hand-written XML.** The package then owns the escaping of strings, the choice of `<integer>` or `<real>`, and the nesting.
- **`plutil -convert xml1` from JSON.** context-compiler does this (`apps/cli/src/background-watch.ts:51-68`). It starts a process for each render. And `JSON.stringify(2.0)` writes `2`, so JSON from JavaScript cannot say that a whole number is a real. A probe on macOS 27.2: `plutil` renders `{"a":1,"b":1.5}` as `<integer>1</integer>` and `<real>1.5</real>`.
- **The npm package `plist`.** Version 5.1.1 (2026-11-09) is ESM, needs Node.js 18 or later, and has 34.55 million downloads a week. It depends on `xmlbuilder` (^15.1.1) and `@xmldom/xmldom` (^0.9.10). An install measured 3 packages and 1.1 MB. Its `build(obj: PlistValue)` is typed. It escapes through `xmlbuilder`. It renders a number as `<integer>` when `Number.isInteger` is true, so the integer keys of launchd render right. It skips a key whose value is `null` or `undefined`.

The other npm packages do less: `@expo/plist` is typed `any` and has a bug with `null`, `simple-plist` is not maintained, `fast-plist` only parses, and `bplist-creator` writes the binary format (research record, 2026-11-15).

## Considered Options

- **Hand-written XML.** Our rules prefer an exact, maintained package to our own code, and `plist` is one.
- **`plutil -convert xml1` from JSON, as context-compiler.** The process decided: the integer gap is the same in `plist`, and launchd's number keys are integers, so only the process for each render differs, and it makes a render that could be a pure function into a call that can fail.
- **`plist`, with the keys of each dictionary sorted before `build`.** This option was selected.

## Consequences

- `@zukhruf/launchd` depends on `plist` at `^5.1.1`.
- The package sorts the keys of each dictionary, at each level, before it calls `build`. The order of the keys in the caller's object does not change the bytes, so it does not make `install` reload.
- An array keeps its order. Order has a meaning in `ProgramArguments` and in an array of calendar intervals.
- A key with the value `undefined` renders as no key. `{ RunAtLoad: undefined }` and `{}` give the same bytes.
- A number renders as `<integer>` when it is whole, else as `<real>`. Each number key of launchd.plist(5) is an integer.
- The render reads no file and starts no process. A test of the bytes needs no macOS.
- The package never parses a job file. It renders its own, and compares bytes.
