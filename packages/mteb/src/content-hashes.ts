import { createHash } from 'node:crypto';

// mteb/_content_hashes.py, for text. MTEB appends the hashes of the image,
// audio and video of an item; this package has text only.

// hash_item: the sha256 of the UTF-8 bytes of the text of the item. Python's
// str.encode() raises on a lone surrogate, where Node would encode U+FFFD,
// so two texts that Python refuses never share a key here.
export function hashItem(item: { readonly text: string }): string {
  const { text } = item;
  if (!text.isWellFormed()) {
    const characters = [...text];
    const position = characters.findIndex((character) =>
      /^\p{Cs}$/u.test(character),
    );
    const code = characters[position]?.codePointAt(0)?.toString(16);
    throw new Error(
      `'utf-8' codec can't encode character '\\u${code}' in position ${position}: surrogates not allowed`,
    );
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
