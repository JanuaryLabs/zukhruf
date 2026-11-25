import { basename } from 'node:path';

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

  static bundle(path: string): Client {
    return new Client('bundle', path, basename(path, '.app'));
  }

  static executable(path: string): Client {
    return new Client('executable', path, path);
  }
}
