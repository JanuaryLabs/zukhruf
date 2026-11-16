/** The cap of a prompt, an assistant text and a consumer call site. */
export const TEXT_EXCERPT = 1500;
/** Tool inputs are many and long; a shorter cap keeps a bundle readable. */
export const TOOL_INPUT_EXCERPT = 800;

/** At most `length` characters of text, around the first needle it holds. */
export function excerpt(
  text: string,
  needles: readonly string[],
  length: number,
): string {
  if (text.length <= length) {
    return text;
  }
  const hits = needles
    .map((needle) => text.indexOf(needle))
    .filter((index) => index >= 0);
  const anchor = hits.length > 0 ? Math.min(...hits) : 0;
  const before = Math.floor(length / 3);
  const start = Math.max(0, Math.min(anchor - before, text.length - length));
  const end = start + length;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
