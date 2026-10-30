// mteb/timing.py. A Python context manager becomes a Disposable: write
// `using _ = timer.phase('Encoding')` where Python writes
// `with timer('Encoding'):`.

// The timing of one phase. start and end are seconds since the first phase of
// the stack.
export type PhaseTiming = {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly split: string;
  readonly subset: string;
};

// Python's time.monotonic(), in seconds.
export function monotonic(): number {
  return performance.now() / 1000;
}

// Times one phase of a stack, from its creation to its disposal.
export class TimingContext implements Disposable {
  readonly #stack: TimingStack;
  readonly #name: string;
  readonly #split: string;
  readonly #subset: string;
  readonly #start = monotonic();

  constructor(
    stack: TimingStack,
    name: string,
    options: { readonly split?: string; readonly subset?: string } = {},
  ) {
    this.#stack = stack;
    this.#name = name;
    this.#split = options.split ?? '';
    this.#subset = options.subset ?? '';
  }

  [Symbol.dispose](): void {
    this.#stack.addPhase(this.#name, {
      start: this.#start,
      end: monotonic(),
      split: this.#split,
      subset: this.#subset,
    });
  }
}

// The timing of the phases of an evaluation, such as loading the data and
// encoding the corpus.
export class TimingStack {
  readonly phases: PhaseTiming[] = [];
  #startTime: number | null = null;

  // TimingStack.__call__ of MTEB.
  phase(
    name: string,
    options: { readonly split?: string; readonly subset?: string } = {},
  ): TimingContext {
    this.#startTime ??= monotonic();
    return new TimingContext(this, name, options);
  }

  addPhase(
    name: string,
    options: {
      readonly start: number;
      readonly end: number;
      readonly split: string;
      readonly subset: string;
    },
  ): void {
    this.#startTime ??= options.start;
    this.phases.push({
      name,
      start: options.start - this.#startTime,
      end: options.end - this.#startTime,
      split: options.split,
      subset: options.subset,
    });
  }

  // A text bar chart of the phases.
  plot(): string {
    if (this.phases.length === 0) return 'No timing phases recorded.';
    const totalTime = Math.max(...this.phases.map((phase) => phase.end));
    if (totalTime === 0) return '';
    const labels = this.phases.map((phase) => {
      const parts = [phase.split, phase.subset].filter(Boolean);
      return parts.length > 0
        ? `${phase.name} (${parts.join(', ')})`
        : phase.name;
    });
    const maxLabelLength = Math.max(...labels.map((label) => label.length));
    const barLength = 50;
    const lines: string[] = [];
    let previousGroup: string | null = null;
    for (const [index, phase] of this.phases.entries()) {
      const group = `${phase.split}\u0000${phase.subset}`;
      if (previousGroup !== null && previousGroup !== group) lines.push('');
      previousGroup = group;
      const duration = phase.end - phase.start;
      const startPosition = Math.trunc((phase.start / totalTime) * barLength);
      const endPosition = Math.trunc((phase.end / totalTime) * barLength);
      const length = Math.max(1, endPosition - startPosition);
      const bar =
        ' '.repeat(startPosition) +
        '█'.repeat(length) +
        ' '.repeat(Math.max(0, barLength - startPosition - length));
      lines.push(
        `${(labels[index] ?? '').padEnd(maxLabelLength)} |${bar}| ${duration.toFixed(1)}s`,
      );
    }
    const tracked = this.phases.reduce(
      (sum, phase) => sum + phase.end - phase.start,
      0,
    );
    lines.push(
      `${' '.repeat(maxLabelLength)}  ${totalTime.toFixed(1)}s (untracked: ${Math.max(0, totalTime - tracked).toFixed(1)}s)`,
    );
    return lines.join('\n');
  }
}
