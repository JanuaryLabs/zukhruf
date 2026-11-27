# An error crosses as data and is rebuilt from a list of classes, without its constructor

Status: Accepted 2026-11-27 (backlog #4984).

Decision-makers: the zukhruf session mutex-91, which wrote paper v2 (errors cross as `{ name, message, stack, fields, cause }` and are rebuilt from a list of classes) and built step 1 of #4984, for the rebuild. Ezz approved paper v2 and gave the go on the API as built on 2026-11-27.

`structuredClone` and `v8.serialize` turn a `DatabaseError { code }` into a plain `Error`: the class and the own fields are gone (probe `4984v2/probe/native.mjs`). comlink 4.4.2, birpc 4.2.0 and vscode-jsonrpc 10.0.2 lose the `code` too (paper v2).

## Decision

`ErrorCodec.encode` sends the name of the error's own class (the `name` of its constructor), its message, its stack, its own properties other than `message`, `stack` and `cause`, and its cause, encoded the same way. A thrown value that is not an error crosses as `{ value }`.

`decode` rebuilds an error of a listed class, or of a native class, with `Reflect.construct(nativeBase, [message], Class)`. The result is a native error (`Error.isError` is true) whose prototype is the class's, and the class's constructor does not run. The stack, the cause and each field are own properties, defined with `Object.defineProperty`, so a field named `__proto__` cannot change the prototype. An error of any other class becomes a `ServerError` with the peer's name. Two classes of one name throw a `RangeError` at construction, because the name is what crosses.

## Considered Options

- **The nearest listed ancestor for an unlisted subclass.** Every error has `Error` in its chain, so no error would ever become a `ServerError`, and a caller could not tell an unlisted class from a plain `Error`.
- **`Object.create(Class.prototype)`.** The object has no `[[ErrorData]]`, so `Error.isError` and `util.types.isNativeError` are false.
- **Running the constructor.** Its parameters and side effects belong to the class, not to the codec.

## Consequences

Both ends list the same classes. A field that holds an error crosses as the channel clones it, as a plain error.

## Confirmation

`src/error/error-codec.test.ts` throws in a worker thread and checks the class, `code`, message, the thread's stack, the cause's class and that the constructor did not run; mutations E4a to E7 were CAUGHT (`mutate.mjs`, 2026-11-27).
