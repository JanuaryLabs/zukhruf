// The order in which CPython 3.12 iterates set(iterable) of non-negative ints
// (Objects/setobject.c): the hash of such an int is the int itself, and the
// set keeps each hash in a table of 2^n slots. A hash goes to the slot
// hash & mask; when that slot is full, the set looks at the next
// LINEAR_PROBES slots, then jumps with the perturbed hash. When the table is
// 3/5 full, it grows to the smallest power of two above 4 * used and adds the
// items again in table order. Iteration reads the table from slot 0. MTEB's
// multilabel classification encodes its training rows in this order.
const MINSIZE = 8;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;

export function pythonIntSetOrder(values: Iterable<number>): number[] {
  let table: (number | undefined)[] = new Array(MINSIZE);
  let used = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(
        `This port orders non-negative ints only, not ${value}.`,
      );
    if (insert(table, value, true)) {
      used++;
      // set_add_entry: fill * 5 < mask * 3 keeps the table.
      if (used * 5 >= (table.length - 1) * 3) table = resize(table, used);
    }
  }
  return table.filter((value) => value !== undefined);
}

// set_add_entry (checkEqual) and set_insert_clean: the slot of the hash, then
// the next LINEAR_PROBES slots when they fit in the table, then a jump. It
// returns false when the set has the value.
function insert(
  table: (number | undefined)[],
  value: number,
  checkEqual: boolean,
): boolean {
  const mask = BigInt(table.length - 1);
  let perturb = BigInt(value);
  let i = perturb & mask;
  for (;;) {
    const probes = i + BigInt(LINEAR_PROBES) <= mask ? LINEAR_PROBES : 0;
    for (let j = 0; j <= probes; j++) {
      const slot = Number(i) + j;
      const entry = table[slot];
      if (entry === undefined) {
        table[slot] = value;
        return true;
      }
      if (checkEqual && entry === value) return false;
    }
    perturb >>= PERTURB_SHIFT;
    i = (i * 5n + 1n + perturb) & mask;
  }
}

// set_table_resize(so, minused): the smallest power of two above minused,
// which is used * 4, or used * 2 above 50000 items.
function resize(
  table: readonly (number | undefined)[],
  used: number,
): (number | undefined)[] {
  const minused = used > 50_000 ? used * 2 : used * 4;
  let size = MINSIZE;
  while (size <= minused) size *= 2;
  const resized: (number | undefined)[] = new Array(size);
  for (const value of table)
    if (value !== undefined) insert(resized, value, false);
  return resized;
}
