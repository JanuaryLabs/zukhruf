/** An object whose every member is a method: the calls that one end can make of the other. */
export type Methods<T> = { [K in keyof T]: (...params: never[]) => unknown };

/**
 * For each method of the peer, the check of its answer. An answer arrives
 * from another thread or process, so its shape is checked before it is
 * given its type (mutex ADR 0017).
 */
export type AnswerChecks<Remote extends Methods<Remote>> = {
  [M in keyof Remote]: (
    answer: unknown,
  ) => answer is Awaited<ReturnType<Remote[M]>>;
};

/**
 * For each method that peers may call, the check of its parameters. A method
 * with no check is not served, also when the target has it.
 */
export type ParamChecks<Local extends Methods<Local>> = {
  [M in keyof Local]?: (
    params: readonly unknown[],
  ) => params is Parameters<Local[M]>;
};
