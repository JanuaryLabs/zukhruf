# A test that needs Docker requires it

A test that needs Docker fails when the engine does not answer. It has no skip option, and no environment variable changes this. CI runs on `ubuntu-latest` only, and that runner has an engine for Linux containers. Thus every machine that runs the tests has an engine, and a green run means that every Docker test ran.

## Considered Options

- **A machine says whether it runs Docker tests (ADR 0003, replaced).** `ZUKHRUF_TESTING_DOCKER` was `required`, `skip`, or unset. CI needed it because its macOS and Windows runners had no engine for Linux containers. CI no longer runs on them, so no machine needs `skip`. A variable that can turn every Docker test into a skip can also hide a broken engine.
- **Skip when the engine does not answer.** A broken engine on CI then turns every Docker test into a skip, and the run passes.
- **Docker on every CI system.** The macOS runners on Apple silicon cannot run Linux containers, because they have no nested virtualization. On Windows, Docker's setup action gives only Windows containers, so Docker Desktop must be installed by hand. An Intel macOS runner and Docker Desktop add minutes to every run, and each needs its own setup.

## Consequences

- A developer without Docker sees the Docker tests fail. Start Docker to run them.
- The first acquisition fails with "Docker is required for container-backed tests", and the engine's error is the cause.
- A test that cannot run on a platform for another reason still skips with that reason. On Windows, the acquisition tests and the supervisor tests skip.
- CI runs `nx affected`, so the Docker tests run when a change can break them.
