import type { Font } from '../text/font.ts';

export type Density = 'compact' | 'regular' | 'spacious';

export type LayoutFonts = {
  /** The title of a Card, or of a Box with an icon. */
  title: Font;
  /** A Card's description and items. */
  body: Font;
  caption: Font;
  /** A centred Box label without an icon. */
  boxLabel: Font;
  note: Font;
  marker: Font;
  connector: Font;
  appliance: Font;
  groupLabel: Font;
  edgeLabel: Font;
  badge: Font;
  portLabel: Font;
};

export type LayoutTokens = {
  PAD_X: number;
  PAD_Y: number;
  ICON: number;
  ICON_GAP: number;
  GAP: number;
  CHANNEL: number;
  STUB: number;
  LABEL_GAP: number;
  CONTENT_PAD: number;
  GROUP_PAD: number;
  BAND_PAD: number;
  BULLET_INDENT: number;
  BLOCK_GAP: number;
  CAPTION_GAP: number;
  PORT_SPACING: number;
  STACK_STEP: { x: number; y: number };
  MARKER_ICON: number;
  CONNECTOR_ICON: number;
  BADGE_ICON: number;
  JUNCTION: number;
  APPLIANCE: { w: number; h: number };
  RADIUS: number;
  FLAT_RADIUS: number;
  fonts: LayoutFonts;
};

const SPACING_SCALE: Record<Density, number> = {
  compact: 0.75,
  regular: 1,
  spacious: 1.5,
};

/**
 * The sizes the engine lays out with. Density scales only the space between
 * elements (gaps, channels, group and diagram padding); node content and
 * fonts keep their size, so text never shrinks to fit.
 */
export function layoutTokens(density: Density = 'regular'): LayoutTokens {
  const scale = SPACING_SCALE[density];
  return {
    PAD_X: 16,
    PAD_Y: 12,
    ICON: 28,
    ICON_GAP: 12,
    GAP: 24 * scale,
    CHANNEL: 8 * scale,
    STUB: 16,
    LABEL_GAP: 4,
    CONTENT_PAD: 40 * scale,
    GROUP_PAD: 12 * scale,
    BAND_PAD: 6,
    BULLET_INDENT: 12,
    BLOCK_GAP: 8,
    CAPTION_GAP: 8,
    PORT_SPACING: 24,
    STACK_STEP: { x: 12, y: 8 },
    MARKER_ICON: 34,
    CONNECTOR_ICON: 16,
    BADGE_ICON: 22,
    JUNCTION: 16,
    APPLIANCE: { w: 112, h: 72 },
    RADIUS: 16,
    FLAT_RADIUS: 4,
    fonts: {
      title: { face: 'sans', size: 14, weight: 600 },
      body: { face: 'sans', size: 11, weight: 400 },
      caption: { face: 'sans', size: 11, weight: 500 },
      boxLabel: { face: 'mono', size: 12, weight: 500 },
      note: { face: 'sans', size: 10, weight: 600 },
      marker: { face: 'sans', size: 11, weight: 700 },
      connector: { face: 'sans', size: 10, weight: 700 },
      appliance: { face: 'sans', size: 12, weight: 600 },
      groupLabel: { face: 'sans', size: 12, weight: 600 },
      edgeLabel: { face: 'mono', size: 10, weight: 400 },
      badge: { face: 'sans', size: 10, weight: 600 },
      portLabel: { face: 'sans', size: 9, weight: 600 },
    },
  };
}
