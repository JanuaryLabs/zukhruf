// What a call did: 'resolved', or the error class and message it rejected or
// threw with.
export async function outcome(call: () => unknown) {
  try {
    await call();
    return 'resolved';
  } catch (error) {
    return Error.isError(error)
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}
