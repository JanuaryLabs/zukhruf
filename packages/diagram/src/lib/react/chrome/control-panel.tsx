import { cn } from 'cn';

import { DIAGRAM_ON_ACCENT, type DiagramMode } from './theme.ts';

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
    <div className="border-t border-[color:var(--dgm-divider)] pt-3">
      <div
        role="radiogroup"
        aria-label="Diagram motion mode"
        className="mx-auto inline-flex divide-x divide-[color:var(--dgm-divider)] overflow-hidden rounded-sm border border-[color:var(--dgm-divider)] font-mono text-[10px] leading-none"
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
                  ? { backgroundColor: activeColor, color: DIAGRAM_ON_ACCENT }
                  : undefined
              }
              className={cn(
                'px-2.5 py-1.5 transition-colors',
                active
                  ? activeColor
                    ? ''
                    : 'bg-[var(--dgm-text)] text-[var(--dgm-bg)]'
                  : 'text-[var(--dgm-dim)] hover:bg-[var(--dgm-hover)] hover:text-[var(--dgm-text)]',
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
