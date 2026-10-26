export interface EnvironmentScope extends Disposable {
  /** Give each key its earlier value, or delete it when it was absent. */
  cleanup: () => void;
}

/** The keys of the open scopes in this process. */
const held = new Set<string>();

/** Windows treats `Path` and `PATH` as one variable. */
const identity = (key: string) =>
  process.platform === 'win32' ? key.toUpperCase() : key;

/** Each acquisition holds its keys of `process.env` alone until its disposal. */
export class Environment {
  /** A value of `undefined` deletes the key for the scope. */
  set(values: Record<string, string | undefined>): EnvironmentScope {
    const keys = Object.keys(values);
    const taken = keys.filter((key) => held.has(identity(key)));
    if (taken.length > 0)
      throw new Error(
        `An open environment scope holds ${taken.join(', ')}. Dispose it before a new set.`,
      );

    using resources = new DisposableStack();
    for (const key of keys) {
      const earlier = process.env[key];
      held.add(identity(key));
      resources.defer(() => {
        if (earlier === undefined) delete process.env[key];
        else process.env[key] = earlier;
        held.delete(identity(key));
      });
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const owned = resources.move();
    const cleanup = () => owned.dispose();

    return { cleanup, [Symbol.dispose]: cleanup };
  }
}
