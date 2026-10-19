import { createContext, useContext } from 'react';

import type { DiagramTone } from '../../model/diagram-ir.ts';

const ACCENT_GREEN = 'var(--dgm-accent-green, #7CFF8E)';
const ACCENT_PRIMARY = 'var(--dgm-accent-primary, #e84a00)';
const ACCENT_NEUTRAL = 'var(--dgm-accent-neutral, #ffffff)';

export const DIAGRAM_NEUTRAL = 'var(--dgm-neutral, rgba(255,255,255,0.85))';
export const DIAGRAM_DIM = 'var(--dgm-dim, rgba(255,255,255,0.45))';
export const DIAGRAM_LIFELINE = 'var(--dgm-lifeline, rgba(255,255,255,0.32))';
export const DIAGRAM_BG = 'var(--dgm-bg, #000000)';
export const DIAGRAM_SURFACE_MUTED =
  'var(--dgm-surface-muted, rgba(255,255,255,0.04))';
export const DIAGRAM_TEXT = 'var(--dgm-text, #ffffff)';
export const DIAGRAM_BORDER = 'var(--dgm-border, rgba(255,255,255,0.15))';
export const DIAGRAM_DIVIDER = 'var(--dgm-divider, rgba(255,255,255,0.10))';
export const DIAGRAM_HOVER = 'var(--dgm-hover, rgba(255,255,255,0.05))';
export const DIAGRAM_DOT = 'var(--dgm-dot, rgba(255,255,255,0.18))';
export const DIAGRAM_HATCH = 'var(--dgm-hatch, rgba(255,255,255,0.18))';
export const DIAGRAM_ON_ACCENT = 'var(--dgm-on-accent, #000000)';

const DIAGRAM_TONE_FILL: Record<DiagramTone, string> = {
  neutral: 'var(--dgm-tone-neutral-fill, rgba(255,255,255,0.04))',
  green: 'var(--dgm-tone-green-fill, rgba(124,255,142,0.12))',
  blue: 'var(--dgm-tone-blue-fill, rgba(96,165,250,0.12))',
  amber: 'var(--dgm-tone-amber-fill, rgba(251,191,36,0.12))',
  rose: 'var(--dgm-tone-rose-fill, rgba(251,113,133,0.12))',
  purple: 'var(--dgm-tone-purple-fill, rgba(168,85,247,0.12))',
  slate: 'var(--dgm-tone-slate-fill, rgba(148,163,184,0.12))',
};

const DIAGRAM_TONE_STROKE: Record<DiagramTone, string> = {
  neutral: 'var(--dgm-tone-neutral-stroke, rgba(255,255,255,0.55))',
  green: 'var(--dgm-tone-green-stroke, rgba(124,255,142,0.78))',
  blue: 'var(--dgm-tone-blue-stroke, rgba(96,165,250,0.78))',
  amber: 'var(--dgm-tone-amber-stroke, rgba(251,191,36,0.78))',
  rose: 'var(--dgm-tone-rose-stroke, rgba(251,113,133,0.78))',
  purple: 'var(--dgm-tone-purple-stroke, rgba(168,85,247,0.78))',
  slate: 'var(--dgm-tone-slate-stroke, rgba(148,163,184,0.78))',
};

export const DIAGRAM_THEME_CLASS = [
  '[--dgm-bg:#ffffff]',
  '[--dgm-surface-muted:rgba(15,23,42,0.035)]',
  '[--dgm-neutral:rgba(15,23,42,0.78)]',
  '[--dgm-dim:rgba(15,23,42,0.44)]',
  '[--dgm-lifeline:rgba(15,23,42,0.22)]',
  '[--dgm-text:#0f172a]',
  '[--dgm-border:rgba(15,23,42,0.14)]',
  '[--dgm-divider:rgba(15,23,42,0.10)]',
  '[--dgm-hover:rgba(15,23,42,0.05)]',
  '[--dgm-dot:rgba(15,23,42,0.10)]',
  '[--dgm-hatch:rgba(15,23,42,0.14)]',
  '[--dgm-tone-neutral-fill:rgba(15,23,42,0.035)]',
  '[--dgm-tone-neutral-stroke:rgba(15,23,42,0.30)]',
  '[--dgm-tone-green-fill:rgba(22,163,74,0.10)]',
  '[--dgm-tone-green-stroke:rgba(21,128,61,0.62)]',
  '[--dgm-tone-blue-fill:rgba(37,99,235,0.09)]',
  '[--dgm-tone-blue-stroke:rgba(29,78,216,0.58)]',
  '[--dgm-tone-amber-fill:rgba(245,158,11,0.12)]',
  '[--dgm-tone-amber-stroke:rgba(180,83,9,0.56)]',
  '[--dgm-tone-rose-fill:rgba(225,29,72,0.09)]',
  '[--dgm-tone-rose-stroke:rgba(190,18,60,0.54)]',
  '[--dgm-tone-purple-fill:rgba(147,51,234,0.09)]',
  '[--dgm-tone-purple-stroke:rgba(126,34,206,0.55)]',
  '[--dgm-tone-slate-fill:rgba(71,85,105,0.07)]',
  '[--dgm-tone-slate-stroke:rgba(51,65,85,0.42)]',
  '[--dgm-accent-green:#14883f]',
  '[--dgm-accent-primary:#d54500]',
  '[--dgm-accent-neutral:#0f172a]',
  '[--dgm-on-accent:#ffffff]',
  'dark:[--dgm-bg:#000000]',
  'dark:[--dgm-surface-muted:rgba(255,255,255,0.04)]',
  'dark:[--dgm-neutral:rgba(255,255,255,0.85)]',
  'dark:[--dgm-dim:rgba(255,255,255,0.45)]',
  'dark:[--dgm-lifeline:rgba(255,255,255,0.32)]',
  'dark:[--dgm-text:#ffffff]',
  'dark:[--dgm-border:rgba(255,255,255,0.15)]',
  'dark:[--dgm-divider:rgba(255,255,255,0.10)]',
  'dark:[--dgm-hover:rgba(255,255,255,0.05)]',
  'dark:[--dgm-dot:rgba(255,255,255,0.18)]',
  'dark:[--dgm-hatch:rgba(255,255,255,0.20)]',
  'dark:[--dgm-tone-neutral-fill:rgba(255,255,255,0.04)]',
  'dark:[--dgm-tone-neutral-stroke:rgba(255,255,255,0.46)]',
  'dark:[--dgm-tone-green-fill:rgba(124,255,142,0.12)]',
  'dark:[--dgm-tone-green-stroke:rgba(124,255,142,0.76)]',
  'dark:[--dgm-tone-blue-fill:rgba(96,165,250,0.12)]',
  'dark:[--dgm-tone-blue-stroke:rgba(96,165,250,0.78)]',
  'dark:[--dgm-tone-amber-fill:rgba(251,191,36,0.12)]',
  'dark:[--dgm-tone-amber-stroke:rgba(251,191,36,0.76)]',
  'dark:[--dgm-tone-rose-fill:rgba(251,113,133,0.12)]',
  'dark:[--dgm-tone-rose-stroke:rgba(251,113,133,0.76)]',
  'dark:[--dgm-tone-purple-fill:rgba(168,85,247,0.12)]',
  'dark:[--dgm-tone-purple-stroke:rgba(168,85,247,0.76)]',
  'dark:[--dgm-tone-slate-fill:rgba(148,163,184,0.12)]',
  'dark:[--dgm-tone-slate-stroke:rgba(148,163,184,0.70)]',
  'dark:[--dgm-accent-green:#7CFF8E]',
  'dark:[--dgm-accent-primary:#e84a00]',
  'dark:[--dgm-accent-neutral:#ffffff]',
  'dark:[--dgm-on-accent:#000000]',
].join(' ');

export const DIAGRAM_SKETCH_THEME_CLASS = [
  '[--dgm-bg:#ffffff]',
  '[--dgm-surface-muted:rgba(17,24,39,0.025)]',
  '[--dgm-neutral:rgba(17,24,39,0.82)]',
  '[--dgm-dim:rgba(17,24,39,0.58)]',
  '[--dgm-lifeline:rgba(17,24,39,0.28)]',
  '[--dgm-text:#111827]',
  '[--dgm-border:rgba(17,24,39,0.18)]',
  '[--dgm-divider:rgba(17,24,39,0.18)]',
  '[--dgm-hover:rgba(17,24,39,0.04)]',
  '[--dgm-dot:rgba(17,24,39,0.08)]',
  '[--dgm-hatch:rgba(17,24,39,0.13)]',
  '[--dgm-tone-neutral-fill:rgba(17,24,39,0.028)]',
  '[--dgm-tone-neutral-stroke:rgba(17,24,39,0.62)]',
  '[--dgm-tone-green-fill:rgba(17,24,39,0.028)]',
  '[--dgm-tone-green-stroke:rgba(17,24,39,0.66)]',
  '[--dgm-tone-blue-fill:rgba(17,24,39,0.028)]',
  '[--dgm-tone-blue-stroke:rgba(17,24,39,0.66)]',
  '[--dgm-tone-amber-fill:rgba(17,24,39,0.028)]',
  '[--dgm-tone-amber-stroke:rgba(17,24,39,0.66)]',
  '[--dgm-tone-rose-fill:rgba(17,24,39,0.028)]',
  '[--dgm-tone-rose-stroke:rgba(17,24,39,0.66)]',
  '[--dgm-tone-purple-fill:rgba(17,24,39,0.028)]',
  '[--dgm-tone-purple-stroke:rgba(17,24,39,0.66)]',
  '[--dgm-tone-slate-fill:rgba(17,24,39,0.028)]',
  '[--dgm-tone-slate-stroke:rgba(17,24,39,0.66)]',
  '[--dgm-accent-green:#111827]',
  '[--dgm-accent-primary:#111827]',
  '[--dgm-accent-neutral:#111827]',
  '[--dgm-on-accent:#ffffff]',
].join(' ');

export type DiagramAccent = 'green' | 'primary' | 'neutral' | (string & {});

export type DiagramMode = 'static' | 'reveal' | 'scrub';

export type DiagramStylePreset = 'default' | 'sketch';

export function resolveAccent(accent: DiagramAccent): string {
  if (accent === 'green') return ACCENT_GREEN;
  if (accent === 'primary') return ACCENT_PRIMARY;
  if (accent === 'neutral') return ACCENT_NEUTRAL;
  return accent;
}

export function resolveDiagramToneFill(tone: DiagramTone): string {
  return DIAGRAM_TONE_FILL[tone];
}

export function resolveDiagramToneStroke(tone: DiagramTone): string {
  return DIAGRAM_TONE_STROKE[tone];
}

export type DiagramIds = {
  dots: string;
  hatch: string;
  arrowAccent: string;
  arrowNeutral: string;
  arrowDim: string;
};

export type DiagramTheme = {
  accent: string;
  ids: DiagramIds;
  stylePreset: DiagramStylePreset;
};

export const DiagramThemeContext = createContext<DiagramTheme | null>(null);

export function useDiagramTheme(): DiagramTheme {
  const ctx = useContext(DiagramThemeContext);
  if (!ctx) {
    throw new Error(
      'Diagram subcomponent rendered outside DiagramThemeContext',
    );
  }
  return ctx;
}

export function makeDiagramIds(uid: string): DiagramIds {
  return {
    dots: `dgm-dots-${uid}`,
    hatch: `dgm-hatch-${uid}`,
    arrowAccent: `dgm-arrow-accent-${uid}`,
    arrowNeutral: `dgm-arrow-neutral-${uid}`,
    arrowDim: `dgm-arrow-dim-${uid}`,
  };
}
