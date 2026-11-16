import { join } from 'node:path';

/**
 * The store of this computer for the user of env: `zukhruf-pool/store.sqlite`
 * in the user's state folder for process.platform (ADR 0015). Throws when a
 * variable that the platform needs is not set, as Go's `os.UserConfigDir`.
 */
export function computerStore(env: Record<string, string | undefined>): string {
  return join(stateFolder(env), 'zukhruf-pool', 'store.sqlite');
}

function stateFolder(env: Record<string, string | undefined>): string {
  switch (process.platform) {
    case 'darwin':
      return join(home(env), 'Library', 'Application Support');
    case 'win32':
      if (!env.LOCALAPPDATA) throw new Error('%LOCALAPPDATA% is not defined');
      return env.LOCALAPPDATA;
    default:
      // The XDG Base Directory specification: an unset or empty
      // XDG_STATE_HOME means ~/.local/state.
      return env.XDG_STATE_HOME || join(home(env), '.local', 'state');
  }
}

function home(env: Record<string, string | undefined>): string {
  if (!env.HOME) throw new Error('$HOME is not defined');
  return env.HOME;
}
