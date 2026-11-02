import { CounterTokenSource, type TokenSource } from '@zukhruf/fencing';

/** Counts tokens like CounterTokenSource, but its first mint fails, as a token file on a full disk would. */
export function tokensThatFailOnce(failure: Error): TokenSource {
  const counter = new CounterTokenSource();
  const scripted = [failure];
  return {
    async next(key) {
      const next = scripted.shift();
      if (next) throw next;
      return counter.next(key);
    },
  };
}
