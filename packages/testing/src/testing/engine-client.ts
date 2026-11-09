import { Docker } from '@zukhruf/docker';

export const docker = await Docker.connect({
  clock: globalThis,
  environment: process.env,
});
