// The owner of a connection that OpenSshConfig#dial made, as a process of its
// own: it holds a session that runs a command until its stdin ends, prints
// `ready`, and lives until it is killed. Its environment is only PATH and
// `home` as HOME.
//
//   node config-owner.ts <ssh config file> <destination> <home>
import { OpenSshConfig } from '../config.ts';

const [file, destination, home] = process.argv.slice(2);
if (file === undefined || destination === undefined || home === undefined) {
  throw new Error(
    'usage: config-owner.ts <ssh config file> <destination> <home>',
  );
}

const config = await OpenSshConfig.resolve(destination, {
  flags: ['-F', file],
  environment: { PATH: '/usr/bin:/bin', HOME: home },
});
const client = await config.dial({ clock: globalThis });
await client.newSession().start('exec cat > /dev/null');
process.stdout.write('ready\n');
