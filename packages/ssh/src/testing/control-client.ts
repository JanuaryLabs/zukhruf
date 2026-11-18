// A client of a control master, as a process of its own.
//
//   node control-client.ts dial <socket path> <address>
//     dials a TCP address through the master, prints `ready`, and lives on the
//     open channel until it is killed.
//   node control-client.ts session <socket path> <command>
//     starts the command through the master, prints `ready`, and lives on the
//     open channel until it is killed.
//   node control-client.ts output <socket path> <command>
//     prints the output of the command, and has nothing left to do.
import { ControlClient } from '../control.ts';

const [mode, path, argument] = process.argv.slice(2);
if (path === undefined || argument === undefined) {
  throw new Error(
    'usage: control-client.ts dial|session|output <socket path> <address|command>',
  );
}

const client = new ControlClient(path);
switch (mode) {
  case 'dial': {
    const stream = await client.dial('tcp', argument);
    stream.resume();
    process.stdout.write('ready\n');
    break;
  }
  case 'session': {
    await client.newSession().start(argument);
    process.stdout.write('ready\n');
    break;
  }
  case 'output': {
    process.stdout.write(await client.newSession().output(argument));
    break;
  }
  default:
    throw new Error(`unknown mode ${String(mode)}`);
}
