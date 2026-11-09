export function isErrno(error: unknown, code: string): boolean {
  return Error.isError(error) && 'code' in error && error.code === code;
}
