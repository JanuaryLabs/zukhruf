// The canonical JSON of RFC 8785, the JSON Canonicalization Scheme: the
// properties of each object sorted by the UTF-16 code units of their names,
// no white space, and each string and number as JSON.stringify of ECMAScript
// writes it. As JSON.stringify does, an object leaves out a property that is
// undefined, and a number that is not finite, which JSON cannot hold, is
// null.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([one], [other]) => (one < other ? -1 : 1))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
