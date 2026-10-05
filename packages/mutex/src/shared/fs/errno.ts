export function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}
