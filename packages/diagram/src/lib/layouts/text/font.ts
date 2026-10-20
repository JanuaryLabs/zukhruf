export type FontFace = 'sans' | 'mono';

export type FontWeight = 400 | 500 | 600 | 700;

export type Font = {
  face: FontFace;
  size: number;
  weight: FontWeight;
};

export const FONT_FAMILY: Record<FontFace, string> = {
  sans: "'Geist Sans', ui-sans-serif, system-ui, sans-serif",
  mono: "'Geist Mono', ui-monospace, monospace",
};
