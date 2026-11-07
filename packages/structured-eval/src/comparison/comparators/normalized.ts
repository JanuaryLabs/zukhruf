// Unicode NFKC, lower case, and one space between words.
export const normalized = (text: string) =>
  text.normalize('NFKC').toLowerCase().replaceAll(/\s+/gu, ' ').trim();
