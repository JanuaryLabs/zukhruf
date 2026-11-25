import { basename } from 'node:path';

import { nodeFfi } from './native/node-ffi.ts';

// PROC_PIDPATHINFO_MAXSIZE (sys/proc_info.h): four times MAXPATHLEN.
const pathSize = 4096;
// The main executable of a bundle; the greedy match takes the innermost
// bundle, the one whose Contents/MacOS holds the executable.
const bundled = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/;

// The program that TCC charges an access to, as the columns client and
// client_type of TCC.db hold it: an app bundle or an executable.
export class Client {
  readonly type: 'bundle' | 'executable';
  readonly path: string;
  // What the user finds in System Settings.
  readonly name: string;

  private constructor(
    type: 'bundle' | 'executable',
    path: string,
    name: string,
  ) {
    this.type = type;
    this.path = path;
    this.name = name;
  }

  // The client that macOS charges the access of the process pid to: the
  // executable of its responsible process (ADR 0004).
  static responsibleFor(pid: number): Client {
    using system = new (nodeFfi().DynamicLibrary)('/usr/lib/libSystem.B.dylib');
    const responsible = system.getFunction(
      'responsibility_get_pid_responsible_for_pid',
      { arguments: ['int32'], return: 'int32' },
    )(pid);
    const buffer = Buffer.alloc(pathSize);
    const length = system.getFunction('proc_pidpath', {
      arguments: ['int32', 'buffer', 'uint32'],
      return: 'int32',
    })(responsible, buffer, pathSize);
    if (length <= 0) throw new RangeError(`No process has the pid ${pid}`);
    const path = buffer.toString('utf8', 0, length);
    const bundle = bundled.exec(path)?.[1];
    return bundle === undefined
      ? Client.executable(path)
      : Client.bundle(bundle);
  }

  static bundle(path: string): Client {
    return new Client('bundle', path, basename(path, '.app'));
  }

  static executable(path: string): Client {
    return new Client('executable', path, path);
  }
}
