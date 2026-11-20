# Recipe: Report only the records that changed since the last check

**Use case.** An alert reads the records of a store at each check, and reports what is new or changed since the last check. It must not report a record again that did not change. A condition gives only the records that are true now (a level); the alert needs the records that changed (an edge). The edge comes from a comparison with the last check, and that comparison is a snapshot differential. The startup-credits app of context-compiler has three such alerts in `apps/startup-credits/src/alerts/` (commit `fd3b6ed` of context-compiler).

**What you need.** A `SnapshotDifferential`, a deletion policy, and a function that reads all the records of the store at each check.

## The steps

1. Make one `SnapshotDifferential` for the alert. Give it the primary key fields and the `key` function.
2. Choose the deletion policy. It decides what a record that leaves the scan and comes back means (see [Things to know](#things-to-know)).
3. Keep the snapshot of the last check in memory. Give `diff` the snapshot `null` at the first check, and the snapshot that the last check yielded at each later check.
4. Read the store once when the host starts, and report nothing. This first scan is the baseline: a restart reports only what changed after the start.
5. At each check, report each insert and each update. Ignore each delete.

## The program

The program makes the same alert twice, once with `ClosedWorld` and once with `Coverage(() => false)`. It reads a baseline of two offers, then does three checks. At the second check, the read of the page `a` fails, so the scan does not list `a`. At the third check, `a` comes back with the same amount.

```ts title="report-changes.ts"
import {
  ClosedWorld,
  Coverage,
  type DeletionPolicy,
  SnapshotDifferential,
} from '@zukhruf/snapshot-differential';

type Offer = { page: string; amount: number };

// Reports the offers that are new or changed since the last check. The
// snapshot of the last check stays in memory.
class OfferAlert {
  readonly #differential: SnapshotDifferential<Offer>;
  // The first check compares with nothing (null). Each later check compares
  // with the snapshot of the check before.
  #diff = (offers: readonly Offer[]) => this.#differential.diff(offers, null);

  constructor(policy: DeletionPolicy) {
    this.#differential = new SnapshotDifferential<Offer>({
      name: 'offers',
      primaryKey: ['page'],
      key: ({ page }) => [page],
      policy,
    });
  }

  // Reads what the upstream holds now, and reports nothing.
  async baseline(offers: readonly Offer[]): Promise<void> {
    await Array.fromAsync(this.check(offers));
  }

  async *check(offers: readonly Offer[]): AsyncGenerator<string> {
    for await (const change of this.#diff(offers)) {
      if (change.type === 'state') {
        const { state } = change;
        this.#diff = (next) => this.#differential.diff(next, state);
      } else if (change.type === 'insert')
        yield `new ${change.record.page} ${change.record.amount}`;
      else if (change.type === 'update')
        yield `changed ${change.record.page} ${change.record.amount}`;
      // A delete is not news: the alert ignores it.
    }
  }
}

const checks: (readonly Offer[])[] = [
  // 1. The page c is new.
  [
    { page: 'a', amount: 5000 },
    { page: 'b', amount: 3000 },
    { page: 'c', amount: 1000 },
  ],
  // 2. The amount of b changes. The read of a fails, so a is not listed.
  [
    { page: 'b', amount: 4000 },
    { page: 'c', amount: 1000 },
  ],
  // 3. The page a comes back with the same amount.
  [
    { page: 'a', amount: 5000 },
    { page: 'b', amount: 4000 },
    { page: 'c', amount: 1000 },
  ],
];

for (const [name, policy] of [
  ['ClosedWorld', new ClosedWorld()],
  ['Coverage(() => false)', new Coverage(() => false)],
] as const) {
  const alert = new OfferAlert(policy);
  await alert.baseline([
    { page: 'a', amount: 5000 },
    { page: 'b', amount: 3000 },
  ]);
  console.log(`${name}:`);
  for (const [index, offers] of checks.entries()) {
    const lines = await Array.fromAsync(alert.check(offers));
    console.log(`  check ${index + 1}: ${lines.join(', ') || 'nothing'}`);
  }
}
```

Output:

```
ClosedWorld:
  check 1: new c 1000
  check 2: changed b 4000
  check 3: new a 5000
Coverage(() => false):
  check 1: new c 1000
  check 2: changed b 4000
  check 3: nothing
```

## What the output shows

- **The baseline reports nothing.** The offers `a` and `b` were in the store before the first check, so the first check reports only `c`.
- **An update names the new record.** At check 2, the alert reports `changed b 4000`. The update gives the new record and the fingerprint that the snapshot saved, `savedFingerprint`, not the old record. To report the old amount, keep the old records yourself.
- **A delete reports nothing.** At check 2, `a` is a vanished key. With `ClosedWorld`, the verdict is `deleted`, and the alert ignores the delete. With `Coverage(() => false)`, the verdict is `unknown`, and the diff yields nothing.
- **The policy decides what a record that comes back means.** At check 3, `a` comes back with the same amount. With `ClosedWorld`, `a` left the snapshot at check 2, so `a` is an insert again. With `Coverage(() => false)`, `a` stayed in the snapshot, so the diff yields nothing.

## Things to know

- **Choose `ClosedWorld` when a record that comes back is news.** The `MissingPrograms` and `ModelFailures` alerts of startup-credits use it (`missing-programs.ts`, `model-failures.ts`). A page that stops failing and fails again is a new failure, and the alert reports it again.
- **Choose `Coverage(() => false)` when a record that leaves the scan can come back unchanged.** No vanished key is deleted: each one is unknown, and stays in the snapshot. The `OfferedPrograms` alert of startup-credits uses it (`offered-programs.ts`): a page whose offer call fails leaves the table, and when it comes back with the same amounts, the alert reports nothing. With eca, the alert before this package, it reported `offers changed X: $5,000 → $5,000` for such a page (commit `fd3b6ed` of context-compiler). The snapshot keeps each unknown key, so it grows with the records that leave for good. See [An unknown key stays until a scan can tell](../../README.md#an-unknown-key-stays-until-a-scan-can-tell).
- **A record that comes back changed is an update, also under `Coverage`.** The snapshot still has its key ([ADR 0005](../adr/0005-a-change-is-an-insert-or-an-update.md)). The test "a key judged unknown that a later scan lists changed is an update, since the snapshot still has it" in `src/snapshot-differential.test.ts` shows it.
- **The snapshot is in memory, so a restart starts again from the baseline.** The changes between the stop and the start are in the baseline, and the alert does not report them. To report them, save the snapshot with the store, and give it to the first `diff` after the start. startup-credits keeps the snapshot in memory and takes a baseline at each start (`main.ts`).
- **A failed read must throw.** An empty scan makes every key a vanished key. Under `ClosedWorld`, each record then comes back as an insert at the next check. startup-credits reads a table that does not exist yet as no records, and lets each other error throw (`rows` in `alert.ts`).
- **An alert that throws keeps the snapshot of the last check.** The program replaces `#diff` only when the diff yields the new snapshot. Thus a check that fails before the end compares again with the same snapshot at the next check, and loses no change (`alert.ts` of startup-credits).
