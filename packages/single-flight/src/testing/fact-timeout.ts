/**
 * How long a test waits for a fact that real I/O brings: a new process, a
 * server, an engine, a closed connection. It only catches a fact that never
 * comes. It claims no speed, and a test never asserts that a fact came sooner.
 */
export const factTimeout = 10_000;
