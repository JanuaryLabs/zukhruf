/**
 * A binary min-heap of items by priority.
 *
 * Moved from graph-layout.ts, whose copy step 6 deletes with the old engine.
 */
export class MinHeap<T> {
  readonly #data: { item: T; priority: number }[] = [];

  get size(): number {
    return this.#data.length;
  }

  push(item: T, priority: number): void {
    this.#data.push({ item, priority });
    this.#bubbleUp(this.#data.length - 1);
  }

  pop(): T | undefined {
    const top = this.#data[0];
    if (!top) return undefined;
    const last = this.#data.pop()!;
    if (this.#data.length > 0) {
      this.#data[0] = last;
      this.#bubbleDown(0);
    }
    return top.item;
  }

  #bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const entry = this.#data[i]!;
      const parentEntry = this.#data[parent]!;
      if (entry.priority >= parentEntry.priority) break;
      this.#data[i] = parentEntry;
      this.#data[parent] = entry;
      i = parent;
    }
  }

  #bubbleDown(index: number): void {
    let i = index;
    for (;;) {
      const entry = this.#data[i]!;
      let smallest = i;
      let smallestEntry = entry;
      for (const child of [2 * i + 1, 2 * i + 2]) {
        const candidate = this.#data[child];
        if (candidate && candidate.priority < smallestEntry.priority) {
          smallest = child;
          smallestEntry = candidate;
        }
      }
      if (smallest === i) break;
      this.#data[i] = smallestEntry;
      this.#data[smallest] = entry;
      i = smallest;
    }
  }
}
