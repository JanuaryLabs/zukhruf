# Pipes

One program of a computer listens on a pipe, and other programs of the same computer connect to it: a Unix domain socket on macOS and Linux, a named pipe on Windows. This package gives .NET's `System.IO.Pipes` on `node:net`.

## Language

**Pipe**:
The local endpoint that one server listens on: a Unix domain socket on macOS and Linux, a named pipe on Windows. .NET's word for both (`System.IO.Pipes`), and libuv's (`uv_pipe_t`).
_Avoid_: Socket (only one of the two kinds), channel, IPC endpoint

**Name**:
What the caller gives to `new PipeEndpoint`: a rooted name or a plain name. .NET's pipe name.
_Avoid_: Key, id, address

**Rooted name**:
A name that is an absolute path. On macOS and Linux it is the socket path as it is; on Windows its hash names the pipe. .NET's word ("rooted", `Path.IsPathRooted`).
_Avoid_: Absolute name, full name

**Plain name**:
A name that is one file name, not rooted. It goes into the default folder, or after the prefix on Windows. Ours, not an industry term: .NET says only "pipe name".
_Avoid_: Short name, relative name, label

**Prefix**:
The caller's text that names the default folder and starts each pipe name on Windows. It takes the place of .NET's fixed `CoreFxPipe_`.
_Avoid_: Scope, namespace, app name

**Endpoint**:
A `PipeEndpoint`: an endpoint that this program owns and may listen on. It is made from a name, and holds its address. .NET's word (`UnixDomainSocketEndPoint`).
_Avoid_: Address, location

**Address**:
A `PipeAddress`: where to connect, the path that a program published. It connects and does not listen. Two addresses with one path are one pipe. Go's word (`net.UnixAddr`).
_Avoid_: Endpoint, location

**Path**:
What `node:net` listens on and connects to: a socket path on macOS and Linux, a pipe path under `\\.\pipe\` on Windows. Node's word for both ("Identifying paths for IPC connections").
_Avoid_: Address, URL, socket name

**Socket path**:
The path of a socket file on macOS and Linux. At most one byte less than `sun_path`: 103 bytes on macOS, 107 on Linux.
_Avoid_: Socket address (`sockaddr_un` is the structure), socket name

**Default folder**:
The folder of the plain names of one prefix and one user: `/tmp/<prefix>-<uid>`, mode `0700`. Ours, not an industry term: .NET uses its temp folder, and tmux has the same folder for its own sockets.
_Avoid_: Socket folder (sqlite-notify's word for its own folder), runtime directory (`XDG_RUNTIME_DIR` is another folder), temp folder

**Unsafe folder**:
A default folder that is not a folder, is a link, belongs to another user, or gives access to its group or others. `endpoint.listen` refuses it with `UnsafeFolderError`. tmux's word ("has unsafe permissions").
_Avoid_: Bad folder, insecure folder, foreign folder

**Server**:
A `PipeServer`, which `endpoint.listen` gives: the owner of the socket file while it listens on the path of one endpoint. Its close, or its dispose, stops listening and removes the file. .NET's `NamedPipeServerStream`, an `IDisposable`.
_Avoid_: Listener (sqlite-notify's word for its own object), host, `net.Server` (the object of `node:net` inside it)

**Client**:
A `net.Socket` that `address.connect` connected. .NET's `NamedPipeClientStream`.
_Avoid_: Peer

**Connection**:
A `net.Socket` that a server accepted: `endpoint.listen` gives each one to its `connectionListener`. `server.close()` does not end the connections that are open; the caller ends them. Node's word (the [`'connection'` event](https://nodejs.org/api/net.html#event-connection) of `net.Server`).
_Avoid_: Client (the socket that `address.connect` connected), session, stream

**Leftover file**:
A socket file whose server crashed. A connect to it gives `ECONNREFUSED`. `endpoint.listen` removes it. .NET's word ("anything left over").
_Avoid_: Stale socket, dead file, orphan
