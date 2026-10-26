# A test never changes the environment of its process

About 50 places in 5 repositories change `process.env` in a test and restore it at the end. 6 of them restore a key that was absent as the string `"undefined"`. Thus an environment scope was built (65a8fc5): `new Environment().set(values)` held each key alone and restored each earlier value or absence. It was removed before its release. A probe ran a suite with `{ concurrency: true }`. One test opened a scope with `REGION = "us"`. A second test with no scope read `process.env.REGION` and got `"us"`. The scope refused only a second scope on the same key. It cannot see a test that only reads the key. `TestContext` does not tell a helper that tests run at the same time. Go's [`testing.T.Setenv`](https://pkg.go.dev/testing#T.Setenv) panics in a parallel test for the same reason: the environment belongs to the whole process. Thus a test never changes `process.env`, and the package gives no helper for it. The code under test takes the environment, or the value, as its input, as a database fixture does (ADR 0007). Or the test runs the code in a child process and gives the child its `env`.

## Considered Options

- **An environment scope that holds each key alone.** A test that only reads the key has no scope, so the scope does not guard it.
- **No concurrency in a file that changes the environment.** Rejected: tests that run at the same time are encouraged, not forbidden.
- **`t.mock.property(process.env, …)`.** It throws, because `process.env` refuses an accessor descriptor.

## Consequences

- A lint rule reports each change to `process.env` in a test.
- A consumer changes the code under test to take the environment or the value, such as a home directory or a time zone. Or it runs the code in a child process with `env`.
