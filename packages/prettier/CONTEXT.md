# Prettier

An Nx workspace formats its files with Prettier. Each project needs two targets: one that writes the files, and one that only reads them. This package infers both targets for each project, so no workspace copies them. A check target never writes.

## Language

**Format target**:
The target `format`. It runs `prettier --write` on the project root. It writes files. It runs only when a person or an agent runs it on purpose. No target depends on it.
_Avoid_: Fix target, lint target, prettier target

**Check target**:
The target `format:check`. It runs `prettier --check` on the project root. It only reads files, and it fails when a file is not formatted. Nx caches its result. `typecheck` depends on it.
_Avoid_: Verify target, lint (lint is a different target), format (format writes)

**Inferred target**:
A target that a `createNodes` plugin gives to a project. Nx applies inferred targets first, so `targetDefaults` and `project.json` can change them.
_Avoid_: Default target (a target default only fills a target that exists), generated target

**Opt-in**:
An entry that a project adds only to get a target from `targetDefaults`, for example `"format": {}`. A target default never makes a target, so each project had to add one. This package removes the need for opt-ins.
_Avoid_: Stub, placeholder

**Override**:
A target in the `project.json` of a project that replaces an inferred target, for example `tofu fmt -recursive` for an OpenTofu project.
_Avoid_: Customization, patch

**Project root**:
A folder with a `project.json` or a `package.json`. Nx and `@nx/eslint/plugin` use the same rule. The plugin gives the two targets to each project root that the plugin entry does not exclude.
_Avoid_: Package folder (a project root can have no package), workspace (the workspace is the whole repo)

**Fixture**:
A folder that a test uses as input. It can have a `package.json`, but it is not a project of the workspace. The `exclude` of the plugin entry in `nx.json` leaves it out.
_Avoid_: Sample, mock project
