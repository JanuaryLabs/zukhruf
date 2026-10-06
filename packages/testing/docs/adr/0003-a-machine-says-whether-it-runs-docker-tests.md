# A machine says whether it runs Docker tests

A test that needs Docker can skip when Docker does not answer, or fail. Skipping is right on a machine that has no Docker, such as a macOS CI runner. It is wrong on the machine whose job is to run these tests: there a broken engine would turn every test into a skip, and the job would pass. Only the machine knows which case holds. Thus `ZUKHRUF_TESTING_DOCKER` says it: `required` fails when Docker does not answer, `skip` skips, and unset runs when Docker answers. `skipWithoutDocker(docker, process.env)` turns it into a test's `skip` option.

## Considered Options

- **Always fail without Docker.** deepagents did this, where every machine that runs the tests has Docker. This repository tests on macOS and Windows runners too.
- **Always skip without Docker.** A broken engine on the Docker job passes silently.
- **Select the Docker tests by file name.** The test runner takes globs but cannot exclude a pattern, and a test file that needs Docker for one test would have to be split.

## Consequences

- `ci.yml` sets `skip` on every operating system. `docker.yml` sets `required` on Linux and runs when the package, the file stores of the mutex, or the lock file change.
