import { Buffer } from 'node:buffer';

// Bytes as text through Buffer, which every Node.js LTS has: the
// Uint8Array.prototype.toBase64 and toHex methods are not in Node.js 24.
function view(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function base64url(bytes: Uint8Array): string {
  return view(bytes).toString('base64url');
}

export function hex(bytes: Uint8Array): string {
  return view(bytes).toString('hex');
}

export function fromBase64url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}
