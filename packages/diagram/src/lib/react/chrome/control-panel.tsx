import { cn } from 'cn';

import type { DiagramMode } from './theme.ts';

export function DiagramControlPanel({
  value,
  onChange,
  activeColor,
}: {
  value: DiagramMode;
  onChange: (mode: DiagramMode) => void;
  activeColor?: string;
}) {
  const options: { id: DiagramMode; label: string }[] = [
    { id: 'static', label: 'static' },
    { id: 'reveal', label: 'reveal' },
    { id: 'scrub', label: 'scrub' },
  ];
  return (
    <div className="border-t border-dgm-divider pt-3">
      <div
        role="radiogroup"
        aria-label="Diagram motion mode"
        className="mx-auto inline-flex divide-x divide-dgm-divider overflow-hidden rounded-sm border border-dgm-divider font-mono text-2xs leading-none"
      >
        {options.map((opt) => {
          const active = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.id)}
              style={
                active && activeColor
                  ? { '--dgm-active': activeColor }
                  : undefined
              }
              className={cn(
                'px-2.5 py-1.5 transition-colors',
                active
                  ? activeColor
                    ? 'bg-(--dgm-active) text-dgm-on-accent'
                    : 'bg-dgm-text text-dgm-bg'
                  : 'text-dgm-dim hover:bg-dgm-hover hover:text-dgm-text',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
