// Postgres's limits and messages (async.c:600-622): a channel is a name of
// fewer than NAMEDATALEN (64) bytes, and a payload is shorter than
// NOTIFY_PAYLOAD_MAX_LENGTH (8000) bytes.
const NAMEDATALEN = 64;
const NOTIFY_PAYLOAD_MAX_LENGTH = 8000;

export function checkChannel(channel: string): void {
  if (channel === '') throw new RangeError('channel name cannot be empty');
  if (Buffer.byteLength(channel) >= NAMEDATALEN)
    throw new RangeError('channel name too long');
}

export function checkPayload(payload: string): void {
  if (Buffer.byteLength(payload) >= NOTIFY_PAYLOAD_MAX_LENGTH)
    throw new RangeError('payload string too long');
}
