import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFontMetrics } from '../../../testing/font-metrics-from-files.ts';
import { FONT_METRICS } from './font-metrics.generated.ts';

test('the committed glyph-width table matches the installed Geist font files; run `nx run diagram:generate-font-metrics` after an @fontsource upgrade', () => {
  // Act
  const installed = readFontMetrics();

  // Assert
  assert.deepEqual(FONT_METRICS, installed);
});
