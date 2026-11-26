/**
 * The PATH of the test process, for the environment that a test gives ssh -G
 * and a ProxyCommand (ADR 0008). They then find ssh and the commands of the
 * config where this machine keeps them: NixOS keeps them in
 * /run/current-system/sw/bin, and its /usr/bin holds only env. Each other
 * variable of that environment is the test's own.
 */
export const PATH = process.env['PATH'] ?? '';
