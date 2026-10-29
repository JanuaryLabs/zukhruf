# Nx

This package is the Nx part of the monorepo standard. Each area gives one part of the Nx configuration that the workspaces copied. The `format` area gives each project two targets: one that writes the files with Prettier, and one that only reads them. No workspace copies them. A check target never writes.

## Language

**Area**:
One part of the package, with its own import path, for example `@zukhruf/nx/format`. The package has no root entry point. An area comes into the package when its own count is due under the Rule of Three.
_Avoid_: Module, feature, sub-package

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
A folder that Nx makes a project: each folder with a `project.json`, and a folder with a `package.json` when the workspace globs match it or it has a `project.json` too. The workspace root is one only with a `project.json` or an `nx` key in its `package.json`. The plugin uses the matcher of Nx itself, and it gives the two targets to each project root that the plugin entry does not exclude.
_Avoid_: Package folder (a project root can have no package), workspace (the workspace is the whole repo)

**Fixture**:
A folder that a test uses as input. It can have a `package.json`, but it is not a project of the workspace. Outside the workspace globs, it gets no targets. Inside them, the `exclude` of the plugin entry in `nx.json` leaves it out.
_Avoid_: Sample, mock project
