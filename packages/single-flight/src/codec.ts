/**
 * Turns a flight's value into text and back. The value crosses to the
 * processes whose callers joined the flight, and the coordinator only carries
 * the text, so the format is the caller's: JSON, or any other that keeps what
 * JSON would drop. The leader gets `decode(encode(value))` too, so every
 * caller sees the value in the same shape.
 */
export interface Codec<T> {
  encode(value: T): string;
  decode(text: string): T;
}
