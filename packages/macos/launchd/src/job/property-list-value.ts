/** A value of a property list that IOKit matches: a string, a number, a boolean, an array or a dictionary of these. */
export type PropertyListValue =
  | string
  | number
  | boolean
  | readonly PropertyListValue[]
  | { readonly [key: string]: PropertyListValue };
