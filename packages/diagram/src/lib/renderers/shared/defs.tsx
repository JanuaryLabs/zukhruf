import {
  DIAGRAM_DIM,
  DIAGRAM_DOT,
  DIAGRAM_HATCH,
  DIAGRAM_NEUTRAL,
  useDiagramTheme,
} from '../../react/chrome/theme.ts';

export function DiagramDefs() {
  const { accent, ids } = useDiagramTheme();
  return (
    <defs>
      <pattern
        id={ids.dots}
        x="0"
        y="0"
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
      >
        <circle cx="2" cy="2" r="0.7" fill={DIAGRAM_DOT} />
      </pattern>
      <pattern
        id={ids.hatch}
        x="0"
        y="0"
        width="8"
        height="8"
        patternUnits="userSpaceOnUse"
      >
        <path
          d="M -2 8 L 8 -2 M 2 10 L 10 2"
          fill="none"
          stroke={DIAGRAM_HATCH}
          strokeWidth="0.8"
        />
      </pattern>
      <ArrowMarker id={ids.arrowAccent} color={accent} />
      <ArrowMarker id={ids.arrowNeutral} color={DIAGRAM_NEUTRAL} />
      <ArrowMarker id={ids.arrowDim} color={DIAGRAM_DIM} />
    </defs>
  );
}

function ArrowMarker({ id, color }: { id: string; color: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerUnits="strokeWidth"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path
        d="M 0 1 L 9 5 L 0 9"
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </marker>
  );
}
