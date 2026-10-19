export type DiagramFontFace = 'mono' | 'sans';

const MONO_CHAR_EM = 0.6;

const SANS_EM_NARROW = 0.32;
const SANS_EM_WIDE = 0.92;
const SANS_EM_CAPITAL = 0.68;
const SANS_EM_DEFAULT = 0.54;
const SANS_NARROW_CHARS = new Set([...` .,:;'"|!iIjlt()[]-`]);
const SANS_WIDE_CHARS = new Set([...'MWmw@%']);

const ASCENT_EM: Record<DiagramFontFace, number> = { mono: 0.942, sans: 0.972 };
const LINE_BOX_EM: Record<DiagramFontFace, number> = {
  mono: 1.185,
  sans: 1.19,
};

function sansCharEm(char: string) {
  if (SANS_NARROW_CHARS.has(char)) return SANS_EM_NARROW;
  if (SANS_WIDE_CHARS.has(char)) return SANS_EM_WIDE;
  if (char >= 'A' && char <= 'Z') return SANS_EM_CAPITAL;
  return SANS_EM_DEFAULT;
}

export function textWidth(
  text: string,
  fontSize: number,
  face: DiagramFontFace,
): number {
  if (face === 'mono') return text.length * MONO_CHAR_EM * fontSize;
  let em = 0;
  for (const char of text) em += sansCharEm(char);
  return em * fontSize;
}

export function widestLine(
  lines: string[],
  fontSize: number,
  face: DiagramFontFace,
): number {
  return Math.max(0, ...lines.map((line) => textWidth(line, fontSize, face)));
}

export function textAscent(fontSize: number, face: DiagramFontFace): number {
  return fontSize * ASCENT_EM[face];
}

export function textLineBox(fontSize: number, face: DiagramFontFace): number {
  return fontSize * LINE_BOX_EM[face];
}

export function centeredBaselineOffset(
  fontSize: number,
  face: DiagramFontFace,
): number {
  return textAscent(fontSize, face) - textLineBox(fontSize, face) / 2;
}
