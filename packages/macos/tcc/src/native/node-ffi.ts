// node:ffi loads on the first call that needs it: Node writes its
// ExperimentalWarning then, so a process that only builds a remedy writes none.
export function nodeFfi(): typeof import('node:ffi') {
  return process.getBuiltinModule('node:ffi');
}
