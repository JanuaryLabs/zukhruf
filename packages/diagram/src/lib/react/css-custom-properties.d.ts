/*
 * The renderers pass runtime values to their classes through --dgm-* custom
 * properties (left-(--dgm-x) reads --dgm-x). React's CSSProperties lists no
 * custom properties, so this adds the diagram's own.
 */
declare module 'react' {
  interface CSSProperties {
    [property: `--dgm-${string}`]: string | number | undefined;
  }
}

export {};
