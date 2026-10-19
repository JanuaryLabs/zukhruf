import type { CSSProperties } from 'react';

import type { Box, DiagramViewport } from '../../model/diagram-ir.ts';
import {
  formatZoom,
  normalizeZoom,
  roundDimension,
} from '../shared/viewport-zoom.ts';

type DiagramCanvasViewportProps = {
  className: string;
  style?: CSSProperties;
  'data-diagram-viewport-fit': NonNullable<DiagramViewport['fit']>;
  'data-diagram-viewport-zoom': string;
};

export function canvasViewportProps(
  box: Pick<Box, 'w' | 'h'>,
  viewport?: DiagramViewport,
): DiagramCanvasViewportProps {
  const fit = viewport?.fit ?? 'width';
  const zoom = normalizeZoom(viewport?.zoom);
  const common = {
    'data-diagram-viewport-fit': fit,
    'data-diagram-viewport-zoom': formatZoom(zoom),
  };

  if (fit === 'contain') {
    const scale = roundDimension(zoom * 100);
    return {
      ...common,
      style:
        zoom === 1
          ? { width: '100%', height: '100%', objectFit: 'contain' }
          : {
              width: `${scale}%`,
              height: `${scale}%`,
              maxWidth: 'none',
              maxHeight: 'none',
              objectFit: 'contain',
            },
      className:
        zoom === 1
          ? 'block min-h-0 min-w-0 max-h-full max-w-full'
          : 'block min-h-0 min-w-0 max-h-none max-w-none shrink-0',
    };
  }

  if (fit === 'natural') {
    return {
      ...common,
      style: {
        width: `${roundDimension(box.w * zoom)}px`,
        height: `${roundDimension(box.h * zoom)}px`,
      },
      className: 'block max-w-none shrink-0',
    };
  }

  if (zoom !== 1) {
    return {
      ...common,
      style: {
        width: `${roundDimension(zoom * 100)}%`,
        height: 'auto',
        maxWidth: 'none',
      },
      className: 'block max-w-none',
    };
  }

  return {
    ...common,
    style: { width: '100%', height: 'auto' },
    className: 'block max-w-full',
  };
}
