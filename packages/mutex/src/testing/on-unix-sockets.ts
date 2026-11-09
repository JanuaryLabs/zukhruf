/** For a test that uses the Unix socket path of a socket store. */
export const onUnixSockets = {
  skip:
    process.platform === 'win32'
      ? 'A socket store on Windows meets its leader on a named pipe'
      : false,
};
