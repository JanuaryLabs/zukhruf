// Says if a stated value and an expected value of one field agree. The walk
// asks it only when both values are present.
export interface Comparator {
  agrees(stated: unknown, expected: unknown): boolean;
}
