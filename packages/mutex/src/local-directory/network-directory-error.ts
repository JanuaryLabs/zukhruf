/** The lock directory is on a file system that other machines share, where the stores' locks do not hold. */
export class NetworkDirectoryError extends Error {
  readonly directory: string;
  /** The network file system the directory is on, for example `NFS`. */
  readonly fileSystem: string;

  constructor(directory: string, fileSystem: string) {
    super(
      `The lock directory ${JSON.stringify(directory)} is on a network file system (${fileSystem}), where its locks are not shared reliably between machines. Use a local directory.`,
    );
    this.name = 'NetworkDirectoryError';
    this.directory = directory;
    this.fileSystem = fileSystem;
  }
}
