import { FONT_METRICS, type FaceMetrics } from './font-metrics.generated.ts';
import type { Font } from './font.ts';

type GlyphTable = {
  metrics: FaceMetrics;
  advances: Map<string, number>;
  kerning: Map<string, number>;
};

const glyphTables = new Map<string, GlyphTable>();

function glyphTable(font: Font): GlyphTable {
  const key = `${font.face} ${font.weight}`;
  const cached = glyphTables.get(key);
  if (cached) return cached;
  const metrics = FONT_METRICS[font.face][font.weight];
  const table = {
    metrics,
    advances: new Map(
      Object.entries(metrics.advances).flatMap(([advance, characters]) =>
        [...characters].map((character) => [character, Number(advance)]),
      ),
    ),
    kerning: new Map(
      Object.entries(metrics.kerning).flatMap(([kerning, pairs]) =>
        (pairs.match(/../gs) ?? []).map((pair) => [pair, Number(kerning)]),
      ),
    ),
  };
  glyphTables.set(key, table);
  return table;
}

function toPixels(units: number, font: Font, metrics: FaceMetrics): number {
  return (units * font.size) / metrics.unitsPerEm;
}

/**
 * The width of `text` drawn in `font` with kerning on and ligatures off, as
 * the renderers draw it, rounded up to the next half pixel.
 */
export function measureText(text: string, font: Font): number {
  const { metrics, advances, kerning } = glyphTable(font);
  const characters = [...text];
  const units = characters.reduce((sum, character, index) => {
    const advance = advances.get(character);
    if (advance === undefined) {
      const codePoint = (character.codePointAt(0) ?? 0)
        .toString(16)
        .toUpperCase()
        .padStart(4, '0');
      throw new Error(
        `Cannot measure ${JSON.stringify(text)}: U+${codePoint} has no glyph in the ${font.face} face at weight ${font.weight}`,
      );
    }
    const previous = characters[index - 1];
    const pairKerning =
      previous === undefined ? 0 : (kerning.get(previous + character) ?? 0);
    return sum + advance + pairKerning;
  }, 0);
  return Math.ceil(2 * toPixels(units, font, metrics)) / 2;
}

/** The distance from the top of the line box's content area to the baseline. */
export function fontAscent(font: Font): number {
  const { metrics } = glyphTable(font);
  return toPixels(metrics.ascent, font, metrics);
}

/** The distance from the baseline to the bottom of the content area. */
export function fontDescent(font: Font): number {
  const { metrics } = glyphTable(font);
  return toPixels(metrics.descent, font, metrics);
}

/** The height of one line at `line-height: normal`. */
export function fontLineHeight(font: Font): number {
  const { metrics } = glyphTable(font);
  return toPixels(
    metrics.ascent + metrics.descent + metrics.lineGap,
    font,
    metrics,
  );
}
