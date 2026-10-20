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

/** The shaping the glyph-width table measures with; renderers draw text the same way. */
export const TEXT_SHAPING = {
  fontKerning: 'normal',
  fontVariantLigatures: 'none',
} as const;
