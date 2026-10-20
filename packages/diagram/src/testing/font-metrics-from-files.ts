import { createRequire } from 'node:module';

import * as fontkit from 'fontkit';

import type {
  FaceMetrics,
  FontMetricsTable,
} from '../lib/layouts/text/font-metrics.generated.ts';
import type { FontFace, FontWeight } from '../lib/layouts/text/font.ts';

const FONT_PACKAGES: Record<FontFace, string> = {
  sans: '@fontsource/geist-sans',
  mono: '@fontsource/geist-mono',
};

const ASCII_PRINTABLE = Array.from({ length: 0x7f - 0x20 }, (_, index) =>
  String.fromCodePoint(0x20 + index),
);

/**
 * The features `font-variant-ligatures: none` turns off. Kerning stays on, as
 * `font-kerning: normal` keeps it in the renderers.
 */
const SHAPING_FEATURES = {
  liga: false,
  clig: false,
  dlig: false,
  hlig: false,
  calt: false,
};

const require = createRequire(import.meta.url);

/** The latin woff2 file that the package's stylesheet loads for one face and weight. */
export function fontFile(face: FontFace, weight: FontWeight): string {
  const name = FONT_PACKAGES[face];
  return require.resolve(
    `${name}/files/${name.split('/')[1]}-latin-${weight}-normal.woff2`,
  );
}

export function openFont(face: FontFace, weight: FontWeight): fontkit.Font {
  const font = fontkit.openSync(fontFile(face, weight));
  if (!('unitsPerEm' in font)) {
    throw new Error(`${fontFile(face, weight)} is a font collection`);
  }
  return font;
}

/** The width in font units that the shaper gives `text`, kerned and without ligatures. */
export function shapedAdvance(font: fontkit.Font, text: string): number {
  return font
    .layout(text, SHAPING_FEATURES)
    .positions.reduce((sum, position) => sum + position.xAdvance, 0);
}

/** Reads the glyph-width table from the installed font files. */
export function readFontMetrics(): FontMetricsTable {
  return {
    sans: readFace('sans'),
    mono: readFace('mono'),
  };
}

function readFace(face: FontFace): Record<FontWeight, FaceMetrics> {
  return {
    400: readFaceMetrics(face, 400),
    500: readFaceMetrics(face, 500),
    600: readFaceMetrics(face, 600),
    700: readFaceMetrics(face, 700),
  };
}

function readFaceMetrics(face: FontFace, weight: FontWeight): FaceMetrics {
  const font = openFont(face, weight);
  const { hhea } = font;
  const os2 = font['OS/2'];
  // macOS lays out lines with hhea; Windows with OS/2 typo metrics when
  // USE_TYPO_METRICS is set. The two agree only when both hold the same values.
  if (
    !os2.fsSelection.useTypoMetrics ||
    os2.typoAscender !== hhea.ascent ||
    os2.typoDescender !== hhea.descent ||
    os2.typoLineGap !== hhea.lineGap
  ) {
    throw new Error(
      `${fontFile(face, weight)}: hhea and OS/2 typo metrics differ, so the line box differs between macOS and Windows`,
    );
  }

  const characters = font.characterSet
    .filter((codePoint) => font.glyphForCodePoint(codePoint).id !== 0)
    .filter((codePoint) => codePoint !== 0xffff)
    .map((codePoint) => String.fromCodePoint(codePoint));
  const advanceOf = new Map(
    characters.map((character) => [character, shapedAdvance(font, character)]),
  );

  const kerningPairs = ASCII_PRINTABLE.flatMap((left) =>
    ASCII_PRINTABLE.map((right) => {
      const pair = left + right;
      const kerning =
        shapedAdvance(font, pair) -
        (advanceOf.get(left) ?? 0) -
        (advanceOf.get(right) ?? 0);
      return [pair, kerning] as const;
    }),
  ).filter(([, kerning]) => kerning !== 0);

  return {
    unitsPerEm: font.unitsPerEm,
    ascent: hhea.ascent,
    descent: -hhea.descent,
    lineGap: hhea.lineGap,
    advances: groupByValue([...advanceOf]),
    kerning: groupByValue(kerningPairs),
  };
}

/** `{ value: keys joined }`: few distinct values, so the table stays small. */
function groupByValue(
  entries: (readonly [string, number])[],
): Record<string, string> {
  const groups = Map.groupBy(entries, ([, value]) => value);
  return Object.fromEntries(
    [...groups]
      .sort(([a], [b]) => a - b)
      .map(([value, members]) => [
        String(value),
        members
          .map(([key]) => key)
          .sort()
          .join(''),
      ]),
  );
}
