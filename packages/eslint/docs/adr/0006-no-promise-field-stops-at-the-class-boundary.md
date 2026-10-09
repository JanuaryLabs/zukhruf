# no-promise-field looks inside records, and stops at a class

`zukhruf/no-promise-field` reported a field whose type is a promise, or carries one as a type argument. A promise in a property was not seen. `readonly #ended = Promise.withResolvers<T>()` passed, because the promise of a `PromiseWithResolvers` is in its `promise` property. A map of pending requests, `Map<string, { key: string; answer: PromiseWithResolvers<boolean> }>`, passed too. In `@zukhruf/single-flight`, a field of that form rejected when the work failed, and the process was safe only because another class attached a handler in the same step. `Record<string, Promise<X>>` and intersections passed as well.

The rule now looks where the class keeps its own data. It knows `PromiseWithResolvers` by name, when the lib or a library declares it. It reads the arguments of a type alias, such as `Record` and `Partial`, and each member of an intersection. It walks the properties and index signatures of a record that the project declares: an interface or a type literal in a project file. It counts each property step and stops after four, so a record such as `Chain<T>` with `next: Chain<Box<T>>` ends. It remembers only the types on the current path. A type that one branch meets at the limit is still walked when another branch meets it higher up.

The walk does not enter a class or a library's type, and it does not follow what a function returns.

- **A class.** The rule checks the fields of that class on their own. If the walk entered classes, every field that holds a `Latch` would be reported, and a `Latch` is what the rule recommends.
- **What a function or a method returns.** A function that returns a promise makes a new promise for each call. A record that can be called and also has a promise property, such as `{ (): void; done: Promise<void> }`, keeps that promise, so it is reported.
- **A library's type.** Its promises, such as a stream writer's `closed` and `ready`, belong to the library. A field that holds a writer is not a promise that the class keeps. The rule is published, so a walk into library types would report such fields in every repo that uses it.

## Considered Options

- **Know only `PromiseWithResolvers`.** This closes the case that was found first. A record with a promise property, the shape of a pending-request map, still passes.
- **Walk every property of every type.** A field that holds a `Latch`, a `Flight` or a library client would be reported for a promise that another class keeps. In this workspace, 13 fields would be reported for this reason.
- **Walk the records that the project declares, and stop at classes and libraries.** This option was selected. In this workspace it reported the four fields that kept a promise in a property, and nothing else.

## Consequences

- A pending-request map keeps the functions that settle each promise, `{ resolve, reject }`, and gives the promise to its caller. vscode-jsonrpc and json-rpc-2.0 do the same.
- A `Latch` holds a promise that never rejects. Its field is the one exemption in this workspace, with an `eslint-disable-next-line` comment that gives the reason. `reportUnusedDisableDirectives` fails the lint if the rule stops reporting that line.
- `Pick<Query, 'key'>` is reported when `Query` has a promise property that the pick leaves out, because the rule reads the arguments of the alias, not the picked properties.
- A workspace package that a project imports through `node_modules` counts as a library, so its records are not walked. A repo that maps a package to its source with tsconfig `paths` has those records walked.
- A class that holds a record with a promise property is reported. If the record is a handle to something that a library or another class owns, make the property a method.
