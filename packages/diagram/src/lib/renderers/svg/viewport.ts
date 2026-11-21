import type { Box, DiagramViewport } from '../../model/diagram-ir.ts';
import {
  formatZoom,
  normalizeZoom,
  roundDimension,
} from '../shared/viewport-zoom.ts';

type DiagramSvgViewportProps = {
  className: string;
  height?: number;
  /** The zoomed size as a percentage of the container; the className reads it as --dgm-viewport-scale. */
  scale?: string;
  width?: number;
  'data-diagram-viewport-fit': NonNullable<DiagramViewport['fit']>;
  'data-diagram-viewport-zoom': string;
};

export function svgViewportProps(
  box: Pick<Box, 'w' | 'h'>,
  viewport?: DiagramViewport,
): DiagramSvgViewportProps {
  const fit = viewport?.fit ?? 'width';
  const zoom = normalizeZoom(viewport?.zoom);
  const common = {
    'data-diagram-viewport-fit': fit,
    'data-diagram-viewport-zoom': formatZoom(zoom),
  };

  if (fit === 'contain') {
    const scale = roundDimension(zoom * 100);
    return zoom === 1
      ? {
          ...common,
          className: 'block size-full min-h-0 min-w-0 max-h-full max-w-full',
        }
      : {
          ...common,
          scale: `${scale}%`,
          className:
            'block h-(--dgm-viewport-scale) w-(--dgm-viewport-scale) min-h-0 min-w-0 max-h-none max-w-none shrink-0',
        };
  }

  if (fit === 'natural') {
    return {
      ...common,
      width: roundDimension(box.w * zoom),
      height: roundDimension(box.h * zoom),
      className: 'block h-auto max-w-none shrink-0',
    };
  }

  if (zoom !== 1) {
    return {
      ...common,
      scale: `${roundDimension(zoom * 100)}%`,
      className: 'block h-auto w-(--dgm-viewport-scale) max-w-none',
    };
  }

  return {
    ...common,
    className: 'block h-auto w-full max-w-full',
  };
}
