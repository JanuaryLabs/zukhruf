import type {
  DiagramLabelLine,
  DiagramTextColor,
} from '../../model/diagram-ir.ts';
import type { Font, FontWeight } from '../text/font.ts';
import {
  fontAscent,
  fontDescent,
  fontLineHeight,
  measureText,
} from '../text/measure-text.ts';
import type { TextAnchor, TextRun } from './graph-layout-result.ts';

export type TextLine = {
  text: string;
  color?: DiagramTextColor;
  weight?: FontWeight;
};

/** Lines of one font stacked at its line height, measured once and placed later. */
export type TextBlock = {
  w: number;
  h: number;
  /** `x` is the anchor of every line; `top` is the top of the first line box. */
  place(x: number, top: number, anchor: TextAnchor): TextRun[];
};

const FONT_WEIGHTS: FontWeight[] = [400, 500, 600, 700];

function nearestWeight(weight: number): FontWeight {
  return FONT_WEIGHTS.reduce((best, candidate) =>
    Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best,
  );
}

/** The non-empty lines of a label, each with its own colour and weight. */
export function labelLines(
  label: string | DiagramLabelLine[] | string[] | undefined,
  color?: DiagramTextColor,
): TextLine[] {
  const lines = [label ?? []].flat();
  return lines.flatMap((line): TextLine[] => {
    const { text, textColor, fontWeight } =
      typeof line === 'string' ? { text: line } : line;
    if (text.trim().length === 0) return [];
    const lineColor = textColor ?? color;
    return [
      {
        text,
        ...(lineColor ? { color: lineColor } : {}),
        ...(fontWeight === undefined
          ? {}
          : { weight: nearestWeight(fontWeight) }),
      },
    ];
  });
}

export function textBlock(lines: TextLine[], font: Font): TextBlock {
  const lineHeight = fontLineHeight(font);
  const runs = lines.map((line) => {
    const lineFont = line.weight ? { ...font, weight: line.weight } : font;
    return {
      line,
      font: lineFont,
      width: measureText(line.text, lineFont),
      ascent: fontAscent(lineFont),
      ink: fontAscent(lineFont) + fontDescent(lineFont),
    };
  });
  return {
    w: Math.max(0, ...runs.map((run) => run.width)),
    h: runs.length * lineHeight,
    place(x, top, anchor) {
      return runs.map((run, index) => {
        const inkTop = top + index * lineHeight + (lineHeight - run.ink) / 2;
        const left = lineLeft(x, run.width, anchor);
        return {
          text: run.line.text,
          x,
          y: inkTop + run.ascent,
          anchor,
          font: run.font,
          ...(run.line.color ? { color: run.line.color } : {}),
          bounds: { x: left, y: inkTop, w: run.width, h: run.ink },
        };
      });
    },
  };
}

function lineLeft(x: number, width: number, anchor: TextAnchor): number {
  switch (anchor) {
    case 'start':
      return x;
    case 'end':
      return x - width;
    case 'middle':
      return x - width / 2;
  }
}
