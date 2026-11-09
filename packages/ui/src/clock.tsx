import { type ReactNode, createContext, use } from 'react';

export interface UiClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(timer: unknown): void;
  Date: { now(): number };
  performance: { now(): number };
}

const ClockContext = createContext<UiClock | null>(null);

export function ClockProvider({
  clock,
  children,
}: {
  clock: UiClock;
  children: ReactNode;
}): ReactNode {
  return <ClockContext value={clock}>{children}</ClockContext>;
}

/** @throws Error when no ClockProvider is above the component. */
export function useClock(): UiClock {
  const clock = use(ClockContext);
  if (clock === null) {
    throw new Error('No clock set, use ClockProvider to set one');
  }
  return clock;
}
