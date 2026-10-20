import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  openFont,
  shapedAdvance,
} from '../../../testing/font-metrics-from-files.ts';
import {
  fontAscent,
  fontDescent,
  fontLineHeight,
  measureText,
} from './measure-text.ts';

describe('measureText', () => {
  test('throws for a character the shipped font has no glyph for, naming the text, the code point, the face and the weight', () => {
    // Act & Assert
    assert.throws(
      () => measureText('Tokyo 東京', { face: 'sans', size: 14, weight: 600 }),
      {
        message:
          'Cannot measure "Tokyo 東京": U+6771 has no glyph in the sans face at weight 600',
      },
    );
  });

  test('a label measures the width the font file shapes it to, with kerning on and ligatures off, rounded up to half a pixel', () => {
    // Arrange
    const text = 'Tokyo AVATAR -> "quoted" fi, 1/2';
    const font = { face: 'sans', size: 14, weight: 500 } as const;
    const file = openFont('sans', 500);
    const expected =
      Math.ceil((2 * shapedAdvance(file, text) * 14) / file.unitsPerEm) / 2;

    // Act
    const width = measureText(text, font);

    // Assert
    assert.equal(width, expected);
  });

  test('a kerned pair measures narrower than its two letters apart', () => {
    // Arrange
    const font = { face: 'sans', size: 100, weight: 400 } as const;

    // Act
    const pair = measureText('AV', font);
    const apart = measureText('A', font) + measureText('V', font);

    // Assert
    assert.ok(pair < apart, `AV is ${pair}px, A + V is ${apart}px`);
  });

  test('a width grows in proportion to the font size', () => {
    // Arrange
    const text = 'Order service';

    // Act
    const small = measureText(text, { face: 'sans', size: 10, weight: 400 });
    const large = measureText(text, { face: 'sans', size: 40, weight: 400 });

    // Assert
    assert.ok(
      Math.abs(large - 4 * small) <= 2,
      `${text} is ${small}px at 10px and ${large}px at 40px`,
    );
  });

  test('every mono character is 0.6em wide', () => {
    // Arrange
    const font = { face: 'mono', size: 20, weight: 700 } as const;

    // Act
    const widths = ['i', 'W', '@', ' ', 'ü'].map((text) =>
      measureText(text, font),
    );

    // Assert
    assert.deepEqual(widths, [12, 12, 12, 12, 12]);
  });
});

describe('vertical font metrics', () => {
  test('ascent, descent and line height are the font file’s hhea metrics at the font size', () => {
    // Arrange
    const file = openFont('sans', 400);
    const font = { face: 'sans', size: 20, weight: 400 } as const;
    const pixels = (units: number) => (units * 20) / file.unitsPerEm;

    // Act
    const metrics = [fontAscent(font), fontDescent(font), fontLineHeight(font)];

    // Assert
    assert.deepEqual(metrics, [
      pixels(file.hhea.ascent),
      pixels(-file.hhea.descent),
      pixels(file.hhea.ascent - file.hhea.descent + file.hhea.lineGap),
    ]);
  });
});
