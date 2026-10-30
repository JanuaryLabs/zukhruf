import { type ScoredId, compareScoredIds } from './python.ts';

// CPython's heapq on (score, id) tuples: a binary min-heap in an array. MTEB
// fills the result of a search from the order of this array.

// heap[index]; the sift loops read only inside the heap.
function itemAt(heap: readonly ScoredId[], index: number): ScoredId {
  const item = heap[index];
  if (item === undefined) throw new RangeError(`No heap item at ${index}.`);
  return item;
}

export function heappush(heap: ScoredId[], item: ScoredId): void {
  heap.push(item);
  siftDown(heap, 0, heap.length - 1);
}

// Pushes item, then pops and returns the smallest item.
export function heappushpop(heap: ScoredId[], item: ScoredId): ScoredId {
  const smallest = heap[0];
  if (smallest !== undefined && compareScoredIds(smallest, item) < 0) {
    heap[0] = item;
    siftUp(heap, 0);
    return smallest;
  }
  return item;
}

function siftDown(heap: ScoredId[], start: number, position: number): void {
  const item = itemAt(heap, position);
  let slot = position;
  while (slot > start) {
    const parentSlot = (slot - 1) >> 1;
    const parent = itemAt(heap, parentSlot);
    if (compareScoredIds(item, parent) >= 0) break;
    heap[slot] = parent;
    slot = parentSlot;
  }
  heap[slot] = item;
}

function siftUp(heap: ScoredId[], position: number): void {
  const end = heap.length;
  const item = itemAt(heap, position);
  let slot = position;
  let child = 2 * slot + 1;
  while (child < end) {
    const right = child + 1;
    if (
      right < end &&
      compareScoredIds(itemAt(heap, child), itemAt(heap, right)) >= 0
    )
      child = right;
    heap[slot] = itemAt(heap, child);
    slot = child;
    child = 2 * slot + 1;
  }
  heap[slot] = item;
  siftDown(heap, position, slot);
}
