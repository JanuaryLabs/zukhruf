import type { ReactNode } from 'react';

export function DiagramHeader({
  title,
  corner,
}: {
  title: string[];
  corner?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4 sm:mb-4">
      <p className="max-w-md font-sans text-sm font-semibold text-balance text-dgm-text">
        {title.map((line, i) => (
          <span key={i}>
            {i > 0 && <br />}
            {line}
          </span>
        ))}
      </p>
      {corner}
    </div>
  );
}
