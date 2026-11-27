/**
 * The process could not start: its file is not there, or it is not
 * executable. The `cause` is the error of the file, with its `code` (`ENOENT`,
 * `EACCES`). The message names the file and never the arguments, because
 * arguments can hold prompts or secrets.
 */
export class StartError extends Error {
  override readonly name = 'StartError';
}
