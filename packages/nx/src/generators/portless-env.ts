import type { NxJsonConfiguration } from '@nx/devkit';

import { addMissingKeys } from './add-keys.ts';
import { updateTargetDefault } from './init/nx-json.ts';

/**
 * One portless proxy serves every app on the machine, and the target that
 * starts it sets its mode. PORTLESS_UNPRIVILEGED starts it without sudo, so an
 * agent with no TTY can. PORTLESS_HTTPS keeps it on HTTPS: a stopped
 * unprivileged proxy otherwise restarts on plain HTTP, and the generated
 * wiring expects https (the portless origin in ALLOWED_ORIGINS of a backend,
 * and the HMR of a web's vite.config.ts, which dials wss on 443). No
 * PORTLESS_TLD: localhost is the default, and a set TLD replaces the TLDs that
 * another repo's proxy saved. A key that is there stays. node-app, react-app
 * and the add-portless-proxy-env migration call it (#4768, #4786).
 */
export function addPortlessProxyEnv(nxJson: NxJsonConfiguration): void {
  updateTargetDefault(nxJson, 'portless', (entry) => ({
    ...entry,
    options: {
      ...entry.options,
      env: addMissingKeys(entry.options?.env, {
        PORTLESS_UNPRIVILEGED: '1',
        PORTLESS_HTTPS: '1',
      }),
    },
  }));
}
