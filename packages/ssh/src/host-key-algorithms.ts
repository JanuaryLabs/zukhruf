/**
 * The host key algorithms of ssh2 1.17.0 (`SUPPORTED_SERVER_HOST_KEY` in
 * lib/protocol/constants.js:64-76). It has no *-cert-v01@openssh.com
 * algorithm, so a client offers none of those names.
 */
export const ssh2HostKeyAlgorithms = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
  'ssh-dss',
] as const;
