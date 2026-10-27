// The role of a set says what a score on it may be used for.
// - training: a new design may be tuned on it.
// - regression: a new design must not score worse on it than the latest
//   accepted design.
// - exam: a set that no design has seen. It is scored one time, as the test
//   of a frozen design. After that score, it is a regression set.
export type Role = 'training' | 'regression' | 'exam';

export type Decision =
  | {
      readonly run: true;
      readonly role: Role;
      // This run is the first score of the set, so the runner writes its
      // date into set.json.
      readonly firstScore: boolean;
    }
  | { readonly run: false; readonly reason: string };

// exam: the caller asked to score the exam sets that were never scored.
export function decide(
  set: { readonly role: Role; readonly firstScoredAt: string | null },
  exam: boolean,
): Decision {
  const firstScore = set.firstScoredAt === null;
  if (set.role !== 'exam') return { run: true, role: set.role, firstScore };
  if (set.firstScoredAt !== null) {
    if (exam)
      throw new Error(
        `This exam set was scored on ${set.firstScoredAt}. It is a regression set now, and it cannot be an exam again.`,
      );
    return { run: true, role: 'regression', firstScore };
  }
  if (!exam)
    return {
      run: false,
      reason:
        'This exam set was never scored. It is scored one time only: pass --exam when the design is frozen.',
    };
  return { run: true, role: 'exam', firstScore };
}
