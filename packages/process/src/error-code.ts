/** The `code` of a Node.js error, such as `ENOENT`, which no type declares. */
export function errorCode(error: unknown): unknown {
  return Reflect.get(Object(error), 'code');
}
