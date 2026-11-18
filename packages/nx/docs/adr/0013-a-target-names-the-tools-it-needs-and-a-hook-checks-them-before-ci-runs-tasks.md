# A target names the tools it needs, and a hook checks them before CI runs tasks

Status: Proposed 2026-11-18 (backlog #4654), for the owner's review.

The standard says: CI installs each tool that a target runs ([Rules that are still prose](../../README.md#rules-that-are-still-prose)). No check enforces it. A **tool** here is a command that a target runs and that `npm ci` does not install, for example `tofu`, `zig` or `docker`. Nx puts `node_modules/.bin` first on the `PATH` of each `nx:run-commands` task (`nx/dist/src/executors/run-commands/running-tasks.js:516-533`), so a command from the lockfile is always there. A tool is not.

The incident: the first CI run of whatisgoingon failed with `tofu: not found` (commit `61a8e57`, 2026-10-29). `@whatisgoingon/infra:typecheck` runs `tofu fmt` and `tofu validate`. It passed on the laptop only because Homebrew had `tofu`. The fix added `opentofu/setup-opentofu@v2` to `ci.yml` by hand.

Facts read on 2026-11-18, Nx 23.2.1:

- Each place that runs a tool in CI today keeps the link between the target and the setup step by hand, in a comment:
  - zukhruf `ci.yml`: `opentofu/setup-opentofu@v2` for the test of the `dokploy` generator, and `./.github/actions/setup-zig` in both jobs for the `native` target of `@zukhruf/sqlite-open`.
  - whatisgoingon and meddit `ci.yml`: `opentofu/setup-opentofu@v2` for the `typecheck` of the infra project. The `dokploy` generator writes this step (`src/generators/dokploy/files.ts:506-511`).
  - text2sql: none. Its CI runs only `test` through Nx. Its OpenTofu workflows install `tofu` and run it with no Nx.
  - Docker: the Docker tests (`test:docker`) run on `ubuntu-latest`, which has Docker. A macOS runner has none. No project with Docker tests runs in the `darwin` job today.
- A missing tool can pass with no error. The test of the `dokploy` generator skips when `tofu version` fails (`src/generators/dokploy/generator.test.ts:463-468`). If zukhruf's `ci.yml` lost its OpenTofu step, CI would stay green and stop checking the HCL that the generator writes.
- The command string does not name the tool. `sqlite-open:native` runs `node src/native/build.ts`, and that script runs `zig`. The test of the `dokploy` generator runs `tofu` from the test code. The OpenTofu targets that read the state start with `: "${TF_ENCRYPTION_PASSPHRASE:?…}" && TF_VAR_tf_encryption_passphrase=… tofu …`, so the first word is `:`. text2sql has 3 targets that start with `:`.
- A runtime input does not catch a missing tool. The OpenTofu checks have the input `{ "runtime": "tofu version" }`. In a probe workspace, a target with the runtime input `no-such-tool version` hashed and ran, and exited 0.
- `TargetConfiguration.metadata` is a `TargetMetadata`, with `[k: string]: any` (`nx/dist/src/config/workspace-json-project-json.d.ts:137-149`, `:248`). When an inferred target and `project.json` both give an array under the same metadata key, Nx joins the two arrays (`nx/dist/src/project-graph/utils/project-configuration/target-merging.js:34-45`, called at `:432`).
- An Nx plugin can export `preTasksExecution` (`nx/dist/src/project-graph/plugins/public-api.d.ts:108-121`, `:132`). Nx calls it in `runCommand` before it creates the tasks (`nx/dist/src/tasks-runner/run-command.js:329-338`). Its context has `workspaceRoot`, `nxJsonConfiguration` and `argv`, and no task graph. An error that it throws stops the run with exit 1, and Nx prints the first line of the message as the title and the other lines as the body (`nx/dist/src/utils/handle-errors.js`). With the daemon on, the hook runs in the daemon (`nx/dist/src/project-graph/plugins/tasks-execution-hooks.js:10-36`). In CI the daemon is off unless `NX_DAEMON=true` (`nx/dist/src/daemon/client/client.js:118-130`).
- `nx affected`, `nx run-many` and `nx run` with `--graph=<file>.json` write the project graph and the task graph to the file, and run no task (`nx/dist/src/command-line/affected/affected.js:36-48`, `run-many/run-many.js:29`, `run/run-one.js:40`; the file in `nx/dist/src/command-line/graph/graph.js:276-283`). The task graph is the one that the run would create: `createJsonOutput` calls `createTaskGraph` with the same projects and targets (`graph.js:946-968`). In the probe workspace, a target with `dependsOn` gave both tasks in `tasks.tasks`, and `graph.nodes.<project>.data.targets.<target>.metadata` gave the metadata. `graph` with `--graph` returns before `runCommand`, so it does not call `preTasksExecution` again.
- `createTaskGraph` and the parser of the Nx arguments (`splitArgsIntoNxArgsAndOverrides`) are not exported by `@nx/devkit` (`nx/dist/src/devkit-exports.d.ts`).
- A probe plugin with a `preTasksExecution` that runs `nx <argv> --graph=<file>.json`, reads the tasks and throws, stopped `nx run-many -t probe` with `CI=true` before any task ran.

## Decision

1. **A target names its tools in `metadata.tools`.** Each entry is a `Tool`: the command that proves the tool runs, and the step that installs it.

   ```ts
   // @zukhruf/nx/tools
   export interface Tool {
     /** A command that only reads, for example ['tofu', 'version']. */
     probe: [string, ...string[]];
     /** The GitHub Actions step that installs the tool, as YAML. */
     install: string;
   }
   ```

   The plugin that writes a target writes its tools. The `opentofu` area gives `tools: [tofu]` to each of its 7 targets. A target that no plugin writes gets its tools in its own `project.json`, in the same key. Nx joins the two arrays, so a project adds a tool to an inferred target and keeps the plugin's tools.

2. **A new area, `@zukhruf/nx/tools`, is a plugin with only `preTasksExecution`.** A workspace lists it in `plugins` in `nx.json`. The `init` generator writes it.

3. **The hook runs only when `CI` is `true`.** On a laptop the tools are there or the task fails at once, and a second graph pass for each `nx run` would slow each run.

4. **The hook sees the tasks that the run will run.** It runs the same Nx command again with `--graph=<temporary file>.json`: `process.argv` of the context, plus the flag. Thus `affected`, `run-many`, `run`, `--exclude`, `NX_BASE` and `NX_HEAD` give the same tasks, with their `dependsOn` tasks. It reads `tasks.tasks`, and the `metadata.tools` of each task's target from `graph.nodes`. It parses no command string and no Nx argument.

5. **The hook tries each tool, it does not look it up** (EAFP). It runs each distinct `probe` one time, with a timeout, and with the environment of the run. A tool is missing when the probe cannot start or exits with a code that is not 0. `docker info` also fails when the Docker daemon is not running, which a lookup on the `PATH` would not see.

6. **A missing tool stops the run before the first task, with the fix.** The message names each tool, the error of its probe, the tasks that need it, and the step to add:

   ```text
    NX   2 tasks need a tool that this runner does not have

   tofu: spawn tofu ENOENT
     needed by @meddit/infra:format:check, @meddit/infra:typecheck
     add this step to the job, before the step that runs nx:
       - uses: opentofu/setup-opentofu@v2
         with:
           tofu_wrapper: false
   ```

   Under GitHub Actions the hook also writes one `::error::` annotation for each tool, so the summary of the run shows it.

7. **A task that the cache will answer still needs its tools.** The hook cannot know a hit before the hash, and a miss must not fail later.

8. **At the start, three places name tools:** the `opentofu` area (`tofu`); in zukhruf, the `test` target of `@zukhruf/nx` (`tofu`) and the `native` target of `@zukhruf/sqlite-open` (`zig`), in their `project.json`. The `test` area adds `docker` for the `test:docker` tag when a Docker test first runs on a runner with no Docker.

## Considered Options

**Where a target says which tools it needs:**

- **Read the tools from the command string.** REJECTED. The command does not name the tool in 3 of the cases above: `node src/native/build.ts` runs `zig`, a test runs `tofu`, and a guarded OpenTofu command starts with `:` and an assignment. `npx`, `sh -c` and `&&` chains add more forms. Each form would need a parser, and the parser would still miss a tool that a script runs.
- **The tools come from the plugin that writes the target, in target metadata.** CHOSEN. The `opentofu` area knows that its targets run `tofu` and how CI installs it. That is a fact of its own domain, so it passes the zero-consumer test. `metadata` is the field that Nx gives for this, and Nx joins its arrays across the plugin and `project.json`.
- **The tools are declared for each project, in a list of the project.** REJECTED as the only source. A project has targets that need different tools, and CI runs only some of them: `mteb:chart` runs `uv`, and no CI runs `chart`. The same `metadata.tools` key in `project.json` covers a hand-written target.
- **The runtime inputs name the tools.** REJECTED. A runtime input is for the hash, a target with no cache has none, and a missing command still hashes (the probe above).

**What runs the check, and when:**

- **A `preTasksExecution` hook of an `@zukhruf/nx` area.** CHOSEN. It runs inside the Nx command that CI runs, before any task, with its exact arguments. No workflow step can drift from the Nx step, and each repo gets the check when it lists the plugin.
- **A command of `@zukhruf/nx` (a `bin`) that a CI step runs before `nx affected`, with the same `-t` list.** REJECTED, kept as the fallback. The list is written twice, and the two copies can drift; the generated CI also switches between `run-many` and `affected`. It needs a `bin` and a step in each workflow.
- **A composite action in zukhruf's `.github`.** REJECTED. A repo calls the actions at `@main`, but the metadata comes from the `@zukhruf/nx` that the repo installed. The check must have the version of the package that wrote the metadata.
- **An Nx target, for example `tools:check`.** REJECTED. A task cannot see the other tasks of its run, and the other tasks would each need a `dependsOn` on it to wait for it.
- **A step of `@zukhruf/git-hooks`.** REJECTED. A hook runs on the laptop, which has the tools. The question is the CI runner.
- **Each plugin checks its own tool, for example a `command -v tofu` guard in the OpenTofu commands.** REJECTED. The task already fails with `tofu: not found`, so a guard adds only a hint, and it still fails late. It cannot cover a target that no plugin writes (`native`, the generator test). Each plugin would copy the same code to find the tasks of the run and to probe.

**How it sees the tasks of the run:**

- **`nx <same arguments> --graph=<file>.json`.** CHOSEN. It is the public CLI, and it gives the task graph that the run creates, with the `dependsOn` tasks.
- **`createTaskGraph` and the argument parser of Nx, imported from `nx/src/...`.** REJECTED. They are not public, so an update of Nx can break them.
- **`nx show projects --affected --withTarget <target>`.** REJECTED. It gives projects, not tasks: no `dependsOn`, and one call for each target.

**The Rule of Three:**

The knowledge "target T runs tool X, so the CI job installs X with step S" is kept by hand in 3 workspaces (zukhruf, whatisgoingon, meddit), in 5 steps for 2 tools, and the `dokploy` generator writes one of them. That is strike 3 of the same knowledge. The check is one piece of code with no copy, so it does not wait for a count. The declarations stay with each plugin and project, because each one knows its own tool. The `dokploy` generator keeps writing `setup-opentofu`: the check does not install, it proves that the install is there.

## Consequences

- A workspace lists `@zukhruf/nx/tools` in `plugins`. A repo that does not list it gets no check.
- Each Nx command in CI computes the task graph two times. The second pass also hashes the tasks (`graph.js:952-960`). The project graph comes from the cache of the first pass.
- The hook depends on the shape of the `--graph` JSON file: `tasks.tasks` and `graph.nodes.<project>.data.targets`. A test of the area runs the real Nx on a fixture, so an update of Nx that changes the shape fails the test.
- A missing tool in CI fails the run before any task, and the message gives the step to add. The `dokploy` test that skips without `tofu` stays, because a laptop with no `tofu` still runs the other tests; in zukhruf CI the hook fails first.
- The check proves that a tool runs, not its version. `setup-zig` pins `0.16.0`; a probe that checks the version would be a different `probe`.
