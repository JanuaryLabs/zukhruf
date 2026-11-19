/** Whether `error` is a Node system error with the code `code`, such as ENOENT. */
export function isErrno(error: unknown, code: string): boolean {
  return Error.isError(error) && 'code' in error && error.code === code;
}
