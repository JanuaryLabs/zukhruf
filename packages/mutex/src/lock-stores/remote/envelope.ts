const TAG = '@lock';

/** Lock messages travel inside a tagged envelope so they share the IPC channel with the application's own messages. */
export function wrap<T>(message: T): Record<typeof TAG, T> {
  return { [TAG]: message };
}

export function unwrap<T>(envelope: unknown): T | undefined {
  return typeof envelope === 'object' && envelope !== null && TAG in envelope
    ? (envelope as Record<typeof TAG, T>)[TAG]
    : undefined;
}
