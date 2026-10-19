import { cn } from 'cn';
import {
  type MotionValue,
  animate as motionAnimate,
  useMotionValue,
  useReducedMotion,
  useScroll,
} from 'motion/react';
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DiagramViewportFit } from '../../model/diagram-ir.ts';
import { DiagramControlPanel } from './control-panel.tsx';
import { DiagramHeader } from './header.tsx';
import {
  DIAGRAM_SKETCH_THEME_CLASS,
  DIAGRAM_THEME_CLASS,
  type DiagramAccent,
  type DiagramMode,
  type DiagramStylePreset,
  DiagramThemeContext,
  makeDiagramIds,
  resolveAccent,
} from './theme.ts';

export type DiagramFrameProps = {
  title: string[];
  corner?: ReactNode;
  defaultMode?: DiagramMode;
  controls?: boolean;
  showHeader?: boolean;
  accent?: DiagramAccent;
  stylePreset?: DiagramStylePreset;
  className?: string;
  fit?: DiagramViewportFit | undefined;
  children: (progress: MotionValue<number>, mode: DiagramMode) => ReactNode;
};

export function DiagramFrame({
  title,
  corner,
  defaultMode = 'reveal',
  controls = false,
  showHeader = true,
  accent = 'green',
  stylePreset = 'default',
  className,
  fit,
  children,
}: DiagramFrameProps) {
  const [mode, setMode] = useState<DiagramMode>(defaultMode);
  const reducedMotion = useReducedMotion();
  const effectiveMode: DiagramMode = reducedMotion ? 'static' : mode;

  const reactId = useId();
  const theme = useMemo(
    () => ({
      accent: resolveAccent(accent),
      ids: makeDiagramIds(reactId),
      stylePreset,
    }),
    [accent, reactId, stylePreset],
  );

  const controlsNode = controls ? (
    <DiagramControlPanel
      value={mode}
      onChange={setMode}
      activeColor={theme.accent}
    />
  ) : null;

  const layoutProps = {
    title,
    corner,
    controls: controlsNode,
    showHeader,
    fillContent: fit === 'contain',
    children,
  };

  return (
    <DiagramThemeContext.Provider value={theme}>
      <div
        className={cn(
          'w-full',
          DIAGRAM_THEME_CLASS,
          stylePreset === 'sketch' && DIAGRAM_SKETCH_THEME_CLASS,
          className,
        )}
        data-diagram-style-preset={stylePreset}
      >
        {effectiveMode === 'scrub' ? (
          <ScrubLayout key={effectiveMode} {...layoutProps} />
        ) : effectiveMode === 'reveal' ? (
          <RevealLayout key={effectiveMode} {...layoutProps} />
        ) : (
          <StaticLayout key={effectiveMode} {...layoutProps} />
        )}
      </div>
    </DiagramThemeContext.Provider>
  );
}

type LayoutProps = {
  title: string[];
  corner?: ReactNode;
  controls: ReactNode;
  showHeader: boolean;
  fillContent: boolean;
  children: (progress: MotionValue<number>, mode: DiagramMode) => ReactNode;
};

function StaticLayout({
  title,
  corner,
  controls,
  showHeader,
  fillContent,
  children,
}: LayoutProps) {
  const progress = useMotionValue(1);
  return (
    <div
      className={cn(
        'flex flex-col rounded-md bg-[var(--dgm-bg)] p-4 sm:p-6',
        fillContent && 'h-full min-h-0',
      )}
    >
      {showHeader && <DiagramHeader title={title} corner={corner} />}
      {fillContent ? (
        <div className="min-h-0 flex-1">{children(progress, 'static')}</div>
      ) : (
        children(progress, 'static')
      )}
      {controls && <div className="mt-4 flex justify-center">{controls}</div>}
    </div>
  );
}

function RevealLayout({
  title,
  corner,
  controls,
  showHeader,
  fillContent,
  children,
}: LayoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  const progress = useMotionValue(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          motionAnimate(progress, 1, {
            duration: 2.6,
            ease: [0.65, 0, 0.35, 1],
          });
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [progress]);

  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col rounded-md bg-[var(--dgm-bg)] p-4 sm:p-6',
        fillContent && 'h-full min-h-0',
      )}
    >
      {showHeader && <DiagramHeader title={title} corner={corner} />}
      {fillContent ? (
        <div className="min-h-0 flex-1">{children(progress, 'reveal')}</div>
      ) : (
        children(progress, 'reveal')
      )}
      {controls && <div className="mt-4 flex justify-center">{controls}</div>}
    </div>
  );
}

function ScrubLayout({
  title,
  corner,
  controls,
  showHeader,
  children,
}: LayoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end end'],
  });

  return (
    <div ref={ref} className="relative" style={{ height: '300vh' }}>
      <div className="sticky top-0 flex h-dvh items-center px-0 sm:px-2">
        <div className="mx-auto flex max-h-[92vh] w-full max-w-5xl flex-col rounded-md bg-[var(--dgm-bg)] p-4 sm:p-6">
          {showHeader && <DiagramHeader title={title} corner={corner} />}
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {children(scrollYProgress, 'scrub')}
          </div>
          {controls && (
            <div className="mt-4 flex justify-center">{controls}</div>
          )}
        </div>
      </div>
    </div>
  );
}
